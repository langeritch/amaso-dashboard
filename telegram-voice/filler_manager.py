"""
During-thinking content manager. Plays pre-rendered Kokoro clips —
news headlines or fun facts — while the dashboard's LLM round-trip
is in flight, so the caller hears something useful instead of a
windchime loop.

Design notes:

- Every clip is pre-rendered to disk via Kokoro during startup,
  in a background task that does NOT block service readiness. First
  call after boot may still get the windchime fallback if prerender
  isn't finished yet — that's fine and intentional.
- Cache key is a hash of (kind, text), so restarts within the same
  news cycle reuse the same WAVs. The cache directory is
  `telegram-voice/filler-cache/`.
- One FillerManager instance, owned by the Service dataclass. Active
  filler loops are keyed by chat_id, so a hypothetical concurrent
  call wouldn't stomp another's playback. (Concurrent calls aren't
  supported today — the shape just keeps the option open.)
- Handoff to the real reply: cancel the filler task, play a 500 ms
  silence bridge, then the caller hands off to the reply play() in
  _handle_turn. NOT a true crossfade — pytgcalls doesn't expose a
  volume envelope and there is no practical way to dip the current
  stream amplitude in real time. A 500 ms silence gap makes the
  transition feel deliberate instead of abrupt.
- Mode persists in `filler-config.json` next to this file. Valid:
  "news", "facts", "mixed" (default), "off".
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import html
import json
import logging
import os
import re
import time
import urllib.request
import wave
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from pytgcalls.types import MediaStream

# Local helpers for the YouTube branch. Both modules degrade
# gracefully (return None / False) when their dependencies are
# missing or the dashboard is unreachable, so importing them here
# is safe even on a stripped-down install. Flat imports because
# telegram-voice/ is run as a module collection, not a package
# (there's no __init__.py — service.py uses `from filler_manager
# import FillerManager` and friends).
import dashboard_client
import youtube_audio


log = logging.getLogger("telegram-voice.filler")


HERE = Path(__file__).resolve().parent
CACHE_DIR = HERE / "filler-cache"
CONFIG_PATH = HERE / "filler-config.json"
# Headline archive — persistent dedupe ledger so played stories
# never replay automatically across restarts. Entries age out after
# ARCHIVE_TTL_SEC so the user can still ask "play that again" within
# the window; after it lapses the headline is eligible to be picked
# up again in a future fetch. See HeadlineArchive class.
ARCHIVE_PATH = HERE / "headline-archive.json"
ARCHIVE_TTL_SEC = 2 * 24 * 60 * 60  # 2 days

DEFAULT_MODE = "news"
# Legacy "facts" / "mixed" values are normalised up to "news" in the
# mode getter — keeping them out of VALID_MODES means a legacy
# on-disk config still boots cleanly.
#
# "youtube" is the dashboard-handoff branch: when the user has a
# video selected, the filler manager fetches its audio URL via
# yt_dlp and streams it into the call from the dashboard's last
# reported position. yt_dlp / network failures fall back to news
# transparently — see _play_loop's youtube branch. "hum" matches
# the dashboard's hum mode (no content, just the windchime); the
# Python service treats it the same as "off" today since there's
# no separate hum loop on the call path.
VALID_MODES = {"news", "youtube", "hum", "off"}

# Filler content renders in a distinct Kokoro voice so the caller
# instantly knows it's background / news-reader audio and not the
# assistant's actual reply. The main assistant voice (af_heart)
# stays on the reply path — this constant only governs filler.
# Override with FILLER_VOICE env var if you want a different one.
FILLER_VOICE = os.environ.get("FILLER_VOICE", "am_michael").strip() or "am_michael"

# Filler plays faster than the main assistant — brisk news-anchor
# cadence instead of conversational. Only governs filler; the reply
# TTS path passes speed=None and gets Kokoro's 1.0x default.
def _parse_speed(raw: str) -> float:
    try:
        v = float(raw)
        if 0.5 <= v <= 2.0:
            return v
    except (TypeError, ValueError):
        pass
    return 1.3
FILLER_SPEED = _parse_speed(os.environ.get("FILLER_SPEED", "1.3"))

SILENCE_BRIDGE_S = 0.5
# Breathing room between consecutive filler clips. Previously 50 ms
# (just long enough to let the pytgcalls buffer drain without a
# click) — which made clips feel like they were stacking on top of
# each other. A full second of quiet between news stories lets the
# listener process one before the next one starts.
INTER_CLIP_GAP_S = 1.0
KOKORO_SAMPLE_RATE = 48_000  # matches kokoro_bridge output; skips pytgcalls resample


# ---- News sources ----------------------------------------------------------

@dataclass(frozen=True)
class RssSource:
    url: str
    label: str  # spoken attribution, e.g. "Al Jazeera"


# Middle East coverage prioritised per product requirement. BBC World
# is kept at the end for variety when regional feeds are slow or thin.
# Order matters: earlier sources are parsed first, and we dedupe by
# title-prefix, so an Al Jazeera story wins when feeds overlap.
NEWS_SOURCES: list[RssSource] = [
    RssSource(
        "https://www.aljazeera.com/xml/rss/all.xml",
        "Al Jazeera",
    ),
    RssSource(
        "https://feeds.bbci.co.uk/news/world/middle_east/rss.xml",
        "BBC News Middle East",
    ),
    RssSource(
        "http://feeds.bbci.co.uk/news/world/rss.xml",
        "BBC World",
    ),
]

# Keywords that score an item as Middle East / conflict related.
# Counted as substring hits in lowercase (title + description); any
# hit qualifies, more hits bump priority. Kept liberal — a false
# positive just means a non-ME clip plays (fine) but a missed Gaza
# story is the actual failure we're avoiding.
ME_KEYWORDS: frozenset[str] = frozenset({
    "israel", "israeli", "palestin", "gaza", "west bank",
    "iran", "iranian", "tehran",
    "hezbollah", "hizbollah",
    "lebanon", "lebanese", "beirut",
    "syria", "syrian", "damascus",
    "yemen", "yemeni", "houthi",
    "hamas",
    "middle east",
    "jerusalem", "tel aviv", "ramallah",
    "ceasefire", "hostage",
    "idf",
})

# Target pool size. 25 is mid-band of the user-specified 20-30 and
# leaves slack after dedup / filter rejects. Per-source cap keeps
# any one feed from dominating on a thin news day.
NEWS_CLIPS_TARGET = 25
PER_SOURCE_CAP = 12

# Sanity bounds on composed clip text. Below MIN_CLIP_CHARS the
# scrub has almost certainly eaten the story; above MAX_CLIP_CHARS
# we start bumping into multi-minute Kokoro synth times and lose
# the "background" feel.
MIN_CLIP_CHARS = 80
MAX_CLIP_CHARS = 700

# RSS content:encoded lives in its own namespace. Rather than
# declare it everywhere, we find it via an explicit qualified name.
CONTENT_NS = "{http://purl.org/rss/1.0/modules/content/}"


# ---- Data types -------------------------------------------------------------

@dataclass
class FillerClip:
    id: str
    text: str
    path: Path
    duration_s: float
    kind: str  # "news" | "silence"
    # Raw source metadata carried through from _fetch_news so we can
    # archive the headline when it plays. Empty for silence bridges
    # and anything synthesised outside the news pipeline.
    source_title: str = ""
    source_label: str = ""
    archive_key: str = ""


SynthFn = Callable[..., tuple[bytes, float]]


def _headline_archive_key(title: str) -> str:
    """
    Normalised prefix used both for cross-feed dedupe AND for the
    persistent archive. Lowercased, non-alphanumeric stripped, first
    60 chars kept. Two feeds phrasing the same story slightly
    differently collide on this key, which is exactly what we want —
    one play per story across all sources.
    """
    lower = title.lower()
    stripped = re.sub(r"[^a-z0-9 ]", "", lower)
    return stripped[:60].strip()


# ---- Headline archive ------------------------------------------------------

class HeadlineArchive:
    """
    Persistent dedupe store. `record_played` goes in whenever a
    headline clip is picked for playback; `is_archived` answers "has
    this story been played before" at fetch time so we never compose
    a clip whose headline has already been heard. Entries expire
    after ARCHIVE_TTL_SEC (2 days by default) — enough window for a
    "play that headline again" follow-up without the ledger growing
    unbounded.

    Serialised as a tiny JSON array in `headline-archive.json`:
        [{key, title, source, played_at}, ...]

    Writes go through a save-the-whole-file path rather than append:
    the file stays <100 entries in practice, atomic rewrite is
    trivial, and we dodge any partial-write corruption concerns.
    """

    def __init__(self, path: Path = ARCHIVE_PATH, ttl_sec: int = ARCHIVE_TTL_SEC) -> None:
        self._path = path
        self._ttl_sec = ttl_sec
        # key -> dict with title / source / played_at (float epoch)
        self._entries: dict[str, dict[str, Any]] = {}
        self._load()

    def _load(self) -> None:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return
        except Exception:
            log.exception("headline archive load failed; starting fresh")
            return
        if not isinstance(raw, list):
            return
        now = time.time()
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            key = str(entry.get("key") or "").strip()
            if not key:
                continue
            played_at = entry.get("played_at")
            if not isinstance(played_at, (int, float)):
                continue
            if now - played_at > self._ttl_sec:
                continue  # drop on load — effectively a sweep every restart
            self._entries[key] = {
                "key": key,
                "title": str(entry.get("title") or "")[:300],
                "source": str(entry.get("source") or "")[:60],
                "played_at": float(played_at),
            }

    def _save(self) -> None:
        try:
            self._path.write_text(
                json.dumps(list(self._entries.values()), indent=2),
                encoding="utf-8",
            )
        except Exception:
            log.exception("headline archive save failed")

    def _evict_stale(self) -> bool:
        now = time.time()
        stale = [
            k for k, e in self._entries.items()
            if now - float(e.get("played_at", 0)) > self._ttl_sec
        ]
        if not stale:
            return False
        for k in stale:
            self._entries.pop(k, None)
        return True

    def is_archived(self, key: str) -> bool:
        if not key:
            return False
        if self._evict_stale():
            self._save()
        return key in self._entries

    def record_played(self, key: str, title: str, source: str) -> None:
        if not key:
            return
        self._evict_stale()
        # Refresh played_at every time we record — if the same story
        # gets picked a second time before the first window expires,
        # sliding the clock keeps it gated for another 2 days.
        self._entries[key] = {
            "key": key,
            "title": title[:300],
            "source": source[:60],
            "played_at": time.time(),
        }
        self._save()

    def keys(self) -> frozenset[str]:
        """Snapshot of currently-archived keys, post-sweep."""
        if self._evict_stale():
            self._save()
        return frozenset(self._entries.keys())

    def count(self) -> int:
        return len(self._entries)


# ---- Manager ---------------------------------------------------------------

class FillerManager:
    def __init__(self, synth_fn: SynthFn) -> None:
        """
        synth_fn: callable (text, voice=None, speed=None, lang=None)
        returning (wav_bytes, duration_s). Normally
        kokoro_bridge.synthesize. Injected for testability and to keep
        this module agnostic to the TTS implementation.
        """
        self._synth = synth_fn
        self._clips: list[FillerClip] = []
        self._played_ids: set[str] = set()
        self._active_tasks: dict[int, asyncio.Task[None]] = {}
        self._silence_bridge: FillerClip | None = None
        self._prerender_task: asyncio.Task[None] | None = None
        # Persistent dedupe store. Survives restarts; 2-day TTL.
        # Writes happen in _next_clip when a headline is picked up
        # for playback, reads happen at _fetch_news composition time.
        self._archive = HeadlineArchive()
        CACHE_DIR.mkdir(exist_ok=True, parents=True)

    # -- Mode persistence ----------------------------------------------------

    @property
    def mode(self) -> str:
        try:
            data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            raw = str(data.get("mode", DEFAULT_MODE))
            # Legacy values from the pre-news-only era map onto "news"
            # rather than reset to default — users who had picked
            # "mixed" clearly wanted content playing, not silence.
            if raw in {"mixed", "facts"}:
                return "news"
            return raw if raw in VALID_MODES else DEFAULT_MODE
        except FileNotFoundError:
            return DEFAULT_MODE
        except Exception:
            log.exception("filler: mode load failed, defaulting to %s", DEFAULT_MODE)
            return DEFAULT_MODE

    def set_mode(self, mode: str) -> None:
        if mode not in VALID_MODES:
            raise ValueError(f"bad mode {mode!r}; valid: {sorted(VALID_MODES)}")
        CONFIG_PATH.write_text(
            json.dumps({"mode": mode}, indent=2), encoding="utf-8"
        )

    # -- Public API ----------------------------------------------------------

    def has_content(self) -> bool:
        return self.mode != "off" and any(
            self._clip_matches_mode(c, self.mode) for c in self._clips
        )

    def is_thinking(self, chat_id: int) -> bool:
        task = self._active_tasks.get(chat_id)
        return bool(task and not task.done())

    def kick_off_prerender(self) -> asyncio.Task[None]:
        """
        Fire-and-forget prerender. Called during service startup AFTER
        Pyrogram+pytgcalls are up, so we don't delay call-readiness
        behind 30+ s of Kokoro synths. Caller doesn't have to await.
        """
        if self._prerender_task and not self._prerender_task.done():
            return self._prerender_task
        self._prerender_task = asyncio.create_task(
            self._prerender(), name="filler-prerender",
        )
        return self._prerender_task

    async def start_thinking(self, calls: Any, chat_id: int) -> None:
        """
        Start the filler loop as a background task. Non-blocking — the
        loop runs until stop_thinking() cancels it.
        """
        existing = self._active_tasks.get(chat_id)
        if existing and not existing.done():
            return
        self._active_tasks[chat_id] = asyncio.create_task(
            self._play_loop(calls, chat_id),
            name=f"filler-loop-{chat_id}",
        )

    def cancel_thinking(self, chat_id: int) -> bool:
        """
        Synchronous cancellation — for the call-end path. stop_thinking()
        plays a silence bridge after cancelling, which fails (and would
        block) when the call channel is already being torn down. This
        variant just fires task.cancel() and returns. The task's
        CancelledError handler still runs (e.g. the YouTube branch
        writes its final position report) — we just don't wait.
        Returns True if a task was actively cancelled.
        """
        task = self._active_tasks.pop(chat_id, None)
        if task is None or task.done():
            return False
        task.cancel()
        return True

    async def stop_thinking(self, calls: Any, chat_id: int) -> None:
        """
        Cancel the filler loop and play a short silence bridge. The
        caller is expected to play the real reply immediately after
        this returns.
        """
        task = self._active_tasks.pop(chat_id, None)
        if task and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        bridge = self._silence_bridge
        if bridge is None or not bridge.path.exists():
            return
        try:
            await calls.play(chat_id, MediaStream(str(bridge.path)))
            await asyncio.sleep(bridge.duration_s)
        except Exception:
            log.warning("filler: silence bridge play failed", exc_info=True)

    # -- Internal: play loop -------------------------------------------------

    def _next_clip(self) -> FillerClip | None:
        mode = self.mode
        if mode == "off":
            return None
        pool = [c for c in self._clips if self._clip_matches_mode(c, mode)]
        # No cycle-back: once every fresh clip has been picked this
        # session we stop emitting. Better silence than replayed
        # headlines. Re-listening to a specific one is an on-demand
        # flow (MCP / explicit ask), not an automatic fallback.
        available = [c for c in pool if c.id not in self._played_ids]
        if not available:
            return None
        clip = available[0]
        self._played_ids.add(clip.id)
        # Record the headline to the persistent archive so future
        # prerenders filter it out. Safe for non-news kinds too —
        # archive_key is empty when there's no source_title, and
        # record_played is a no-op in that case.
        if clip.kind == "news" and clip.archive_key:
            self._archive.record_played(
                clip.archive_key, clip.source_title, clip.source_label,
            )
        return clip

    @staticmethod
    def _clip_matches_mode(clip: FillerClip, mode: str) -> bool:
        # Only "news" plays content now; anything else (e.g. "off")
        # produces an empty pool and falls back to the chime hum.
        if mode == "news":
            return clip.kind == "news"
        return False

    async def _play_loop(self, calls: Any, chat_id: int) -> None:
        try:
            while True:
                mode = self.mode
                # YouTube branch — best-effort. We ATTEMPT it once per
                # loop iteration; if anything fails we fall through to
                # the news branch below for this iteration and try
                # again on the next. Any persistent failure (no
                # videoId selected, yt_dlp not installed, dead URL)
                # means we just keep playing news for the duration of
                # the call. The dashboard sees no surface change.
                if mode == "youtube":
                    played = await self._try_play_youtube(calls, chat_id)
                    if played:
                        continue
                    # YouTube fallthrough: don't spam the loop with
                    # news headlines if the user explicitly picked
                    # youtube — sleep briefly and re-poll the state in
                    # case yt_dlp recovers (cache expiry, network
                    # blip).
                    await asyncio.sleep(2.0)
                    continue
                if mode == "hum" or mode == "off":
                    # No active content — yield. The dashboard's hum
                    # is a parallel track on its own audio element;
                    # we don't replicate it on the call path because
                    # pytgcalls would just mute over our reply later.
                    await asyncio.sleep(0.5)
                    continue
                clip = self._next_clip()
                if clip is None:
                    # Nothing to play — yield to the event loop and let
                    # stop_thinking() cancel us when the reply is ready.
                    await asyncio.sleep(0.5)
                    continue
                log.info(
                    "filler: playing %s %s (%.1fs): %r",
                    clip.kind, clip.id[:8], clip.duration_s, clip.text[:60],
                )
                try:
                    await calls.play(chat_id, MediaStream(str(clip.path)))
                except Exception:
                    log.warning(
                        "filler: play failed for %s", clip.id[:8], exc_info=True,
                    )
                    await asyncio.sleep(0.5)
                    continue
                # Sleep for the clip length plus INTER_CLIP_GAP_S so
                # the next play() call lands after the caller has had
                # a beat of silence to absorb the story. The gap also
                # absorbs the pytgcalls buffer drain that the old
                # 50 ms pad was designed for.
                await asyncio.sleep(clip.duration_s + INTER_CLIP_GAP_S)
        except asyncio.CancelledError:
            raise

    async def _try_play_youtube(self, calls: Any, chat_id: int) -> bool:
        """
        Stream the dashboard-selected YouTube video into the call
        from the last-reported position. Returns True if playback
        was started (the loop should NOT also play news this tick),
        False on any failure (the loop falls back to news).

        EXPERIMENTAL: this is the audio-handoff path between dashboard
        and Telegram. It requires yt_dlp (pip install) and that
        pytgcalls' MediaStream accepts URL-string sources, which is
        documented but not exercised elsewhere in this codebase.
        Every step is wrapped in try/except so a failure never breaks
        the call — at worst we play news instead.
        """
        if not youtube_audio.is_available():
            return False
        snap = await dashboard_client.fetch_state()
        if snap is None or not snap.wants_youtube or snap.video_id is None:
            return False

        # Resolve a CDN URL from the cache (or extract fresh).
        resolved = await youtube_audio.resolve_audio_url(snap.video_id)
        if resolved is None:
            log.warning(
                "filler/yt: extraction failed for %s — falling back",
                snap.video_id,
            )
            return False

        start_at = max(0.0, float(snap.position_sec))
        log.info(
            "filler/yt: streaming %s @ %.1fs (title=%r)",
            snap.video_id, start_at, resolved.title,
        )
        # MediaStream accepts URL strings — pytgcalls hands them to
        # ffmpeg under the hood. We pass the start offset via
        # ffmpeg_parameters; ffmpeg's `-ss` BEFORE the input is the
        # fast seek that doesn't have to decode through the prefix.
        # If pytgcalls' MediaStream signature in this version
        # rejects ffmpeg_parameters, we catch + fall back.
        try:
            stream_kwargs: dict[str, Any] = {}
            if start_at > 0.5:
                stream_kwargs["ffmpeg_parameters"] = (
                    f"-ss {start_at:.3f}"
                )
            stream = MediaStream(resolved.url, **stream_kwargs)
        except TypeError:
            # Older pytgcalls without ffmpeg_parameters — fall back
            # to no-seek playback. The user hears the video from the
            # start; not perfect but better than no audio at all.
            log.info("filler/yt: ffmpeg_parameters unsupported, no seek")
            stream = MediaStream(resolved.url)
        except Exception:
            log.warning("filler/yt: MediaStream build failed", exc_info=True)
            return False

        try:
            await calls.play(chat_id, stream)
        except Exception:
            log.warning("filler/yt: play() failed", exc_info=True)
            # The cached URL might have been ejected by YouTube's CDN
            # signature rotation — invalidate so the next attempt
            # re-extracts a fresh one.
            youtube_audio.invalidate(snap.video_id)
            return False

        # Position-report loop. We track wall-clock time since play()
        # plus the start offset, since pytgcalls doesn't expose a
        # playhead callback. Reports continue until stop_thinking()
        # cancels this task — coarse 5 s cadence keeps the
        # dashboard's resume position fresh enough for handover.
        play_started = time.monotonic()

        # Sleep tick: report position, then wait. Stop_thinking
        # cancellation propagates through asyncio.sleep so we exit
        # cleanly when the reply path takes over.
        try:
            while True:
                elapsed = time.monotonic() - play_started
                pos = start_at + elapsed
                if resolved.duration_sec and pos >= resolved.duration_sec:
                    log.info("filler/yt: reached end-of-video at %.1fs", pos)
                    return True  # let the loop pick the next thing
                await dashboard_client.report_position(pos)
                await asyncio.sleep(5.0)
        except asyncio.CancelledError:
            # Final position write before we yield — gives the
            # dashboard's resume the freshest possible playhead.
            elapsed = time.monotonic() - play_started
            with contextlib.suppress(Exception):
                await dashboard_client.report_position(start_at + elapsed)
            raise

    # -- Internal: prerender -------------------------------------------------

    async def _prerender(self) -> None:
        t0 = time.monotonic()
        log.info(
            "filler: prerender start (mode=%s, voice=%s, speed=%.2fx, "
            "target=%d clips, archive=%d entries)",
            self.mode, FILLER_VOICE, FILLER_SPEED, NEWS_CLIPS_TARGET,
            self._archive.count(),
        )

        self._silence_bridge = await asyncio.to_thread(
            self._render_silence, SILENCE_BRIDGE_S
        )

        try:
            fetched = await asyncio.to_thread(self._fetch_news)
        except Exception:
            log.exception("filler: news fetch raised")
            fetched = []

        log.info("filler: composed %d news scripts — synthesising", len(fetched))
        for script, source_title, source_label in fetched:
            clip = await self._render_text(
                "news", script,
                source_title=source_title,
                source_label=source_label,
            )
            if clip is not None:
                self._clips.append(clip)

        log.info(
            "filler: prerender done in %.1fs — %d news clips ready; "
            "silence_bridge=%s",
            time.monotonic() - t0,
            len(self._clips),
            bool(self._silence_bridge),
        )

    async def _render_text(
        self,
        kind: str,
        text: str,
        *,
        source_title: str = "",
        source_label: str = "",
    ) -> FillerClip | None:
        text = text.strip()
        if not text:
            return None
        # Voice + speed are part of the cache key so swapping either
        # transparently re-renders without stomping old files — each
        # (voice, speed) pair lives in its own slot on disk.
        cid = hashlib.sha1(
            f"{kind}:{FILLER_VOICE}:{FILLER_SPEED:.2f}:{text}".encode("utf-8")
        ).hexdigest()[:16]
        archive_key = (
            _headline_archive_key(source_title) if source_title else ""
        )
        path = CACHE_DIR / f"{kind}-{cid}.wav"
        if path.exists():
            try:
                duration_s = _wav_duration(path)
                return FillerClip(
                    id=cid, text=text, path=path,
                    duration_s=duration_s, kind=kind,
                    source_title=source_title,
                    source_label=source_label,
                    archive_key=archive_key,
                )
            except Exception:
                log.warning("filler: cached wav unreadable, re-rendering %s", cid)
                with contextlib.suppress(Exception):
                    path.unlink()
        try:
            wav_bytes, duration_s = await asyncio.to_thread(
                self._synth, text, FILLER_VOICE, FILLER_SPEED
            )
        except Exception:
            log.exception("filler: synth failed for %s: %r", kind, text[:60])
            return None
        try:
            path.write_bytes(wav_bytes)
        except Exception:
            log.exception("filler: cache write failed at %s", path)
            return None
        return FillerClip(
            id=cid, text=text, path=path,
            duration_s=duration_s, kind=kind,
            source_title=source_title,
            source_label=source_label,
            archive_key=archive_key,
        )

    @staticmethod
    def _render_silence(seconds: float) -> FillerClip | None:
        """
        48 kHz mono s16le silence file that matches kokoro_bridge's
        output format so pytgcalls doesn't have to resample it on the
        fly.
        """
        if seconds <= 0:
            return None
        path = CACHE_DIR / f"silence-{int(seconds * 1000)}ms.wav"
        if not path.exists():
            sr = KOKORO_SAMPLE_RATE
            n_frames = int(seconds * sr)
            try:
                with wave.open(str(path), "wb") as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(sr)
                    wf.writeframes(b"\x00\x00" * n_frames)
            except Exception:
                log.exception("filler: silence write failed at %s", path)
                return None
        return FillerClip(
            id="silence", text="", path=path,
            duration_s=seconds, kind="silence",
        )

    # ---- News fetch + composition ---------------------------------------

    @staticmethod
    def _clean_html(raw: str) -> str:
        """
        Strip tags, decode entities, normalise the Unicode punctuation
        that Kokoro phonemiser trips on. RSS descriptions commonly
        wrap the real summary in <p> tags plus a trailing <a>..read
        more..</a>, so we do the tag-strip first and the anchor text
        disappears along with the href.
        """
        if not raw:
            return ""
        no_tags = re.sub(r"<[^>]+>", " ", raw)
        decoded = html.unescape(no_tags)
        # Smart quotes, dashes, ellipsis — Kokoro renders ASCII
        # equivalents more reliably.
        decoded = (
            decoded
            .replace("‘", "'").replace("’", "'")
            .replace("“", '"').replace("”", '"')
            .replace("–", "-").replace("—", " - ")
            .replace("…", "...")
        )
        # Collapse whitespace runs (including nbsp variants).
        return re.sub(r"\s+", " ", decoded).strip()

    @staticmethod
    def _score_item(haystack: str) -> int:
        """Count Middle East keyword substring hits in lowercased text."""
        lower = haystack.lower()
        return sum(1 for kw in ME_KEYWORDS if kw in lower)

    @staticmethod
    def _compose_clip(title: str, description: str, source_label: str) -> str:
        """
        Broadcast-style spoken script:

            "From {source}. {Title}. {Description}."

        Both title and description are already HTML-scrubbed by the
        caller. We ensure terminal punctuation so Kokoro doesn't run
        the sentences together into a mush.
        """
        title = title.rstrip(" .!?;:,")
        description = description.strip()
        if description and description[-1] not in ".!?":
            description += "."
        if description:
            return f"From {source_label}. {title}. {description}"
        return f"From {source_label}. {title}."

    @staticmethod
    def _fetch_one_feed(source: RssSource) -> list[tuple[str, str]]:
        """Fetch one RSS URL; return [(title, description), ...]."""
        try:
            req = urllib.request.Request(
                source.url,
                headers={
                    # Many news CDNs 403 a default urllib UA. A
                    # plausible browser UA gets through reliably and
                    # still identifies us as amaso in the brand tail.
                    "User-Agent": (
                        "Mozilla/5.0 (amaso-dashboard/filler) "
                        "AppleWebKit/537.36"
                    ),
                    "Accept": "application/rss+xml, application/xml, text/xml, */*",
                },
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = resp.read()
        except Exception as e:
            log.warning("filler: fetch failed %s: %s", source.url, e)
            return []

        try:
            root = ET.fromstring(data)
        except Exception:
            log.exception("filler: parse failed %s", source.url)
            return []

        items: list[tuple[str, str]] = []
        for item in root.iter("item"):
            title_el = item.find("title")
            if title_el is None:
                continue
            title = (title_el.text or "").strip()
            if not title or len(title) > 200:
                continue

            # Try <description> first, then <content:encoded> as a
            # richer fallback (some feeds relegate the summary to
            # <description> and put the full article body in
            # content:encoded; others do the opposite).
            desc_el = item.find("description")
            desc = (desc_el.text or "").strip() if desc_el is not None else ""
            if not desc:
                enc_el = item.find(f"{CONTENT_NS}encoded")
                desc = (enc_el.text or "").strip() if enc_el is not None else ""

            items.append((title, desc))
            if len(items) >= PER_SOURCE_CAP:
                break
        log.info("filler: %s — %d items", source.label, len(items))
        return items

    def _fetch_news(self) -> list[tuple[str, str, str]]:
        """
        Fetch every source, compose broadcast scripts, dedupe within
        this batch AND against the persistent archive, rank by Middle
        East relevance, cap at NEWS_CLIPS_TARGET. Returns tuples of
        (script, source_title, source_label) — the extra fields let
        _next_clip record the headline to the archive when played.
        """
        # Snapshot archive once per fetch so the 2-day eviction sweep
        # runs a single time instead of once per item.
        archived = self._archive.keys()
        # (score, script, title, label, key) — score is ME-keyword
        # hits (higher = more topical); ties break on list order,
        # which matches the source precedence in NEWS_SOURCES.
        scored: list[tuple[int, str, str, str, str]] = []
        seen_keys: set[str] = set()
        archive_skipped = 0

        for source in NEWS_SOURCES:
            for title, desc in FillerManager._fetch_one_feed(source):
                clean_title = FillerManager._clean_html(title)
                clean_desc = FillerManager._clean_html(desc)
                if not clean_title:
                    continue

                # Dedupe against stories repeated across feeds using
                # a prefix of the normalised title. Prefix is short
                # enough that minor rewording ("X kills Y" vs "Y
                # killed in X") still collides on the common noun
                # subject.
                key = _headline_archive_key(clean_title)
                if key in seen_keys:
                    continue
                seen_keys.add(key)

                # Persistent archive filter — previously played in
                # the last 2 days, don't bother rendering again.
                if key in archived:
                    archive_skipped += 1
                    continue

                script = FillerManager._compose_clip(
                    clean_title, clean_desc, source.label,
                )
                n = len(script)
                if n < MIN_CLIP_CHARS or n > MAX_CLIP_CHARS:
                    continue
                score = FillerManager._score_item(
                    f"{clean_title} {clean_desc}"
                )
                scored.append((score, script, clean_title, source.label, key))

        if not scored:
            log.warning(
                "filler: no fresh items (archive_skipped=%d across all feeds)",
                archive_skipped,
            )
            return []

        # Sort by score desc, stable on insertion order (Python's
        # sort is stable). Python compares tuples elementwise, so
        # we reverse just the first element by negating.
        scored.sort(key=lambda t: -t[0])
        top = scored[:NEWS_CLIPS_TARGET]
        selected = [(script, title, label) for _s, script, title, label, _k in top]
        n_topical = sum(1 for s, _, _, _, _ in top if s > 0)
        log.info(
            "filler: selected %d/%d scripts (%d Middle-East-scored, "
            "%d archive-skipped)",
            len(selected), len(scored), n_topical, archive_skipped,
        )
        return selected


def _wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        frames = wf.getnframes()
        rate = wf.getframerate() or 1
        return frames / rate
