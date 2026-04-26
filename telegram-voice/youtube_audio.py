"""
yt-dlp wrapper that resolves a YouTube video id to a direct audio
CDN URL playable by pytgcalls' MediaStream.

EXPERIMENTAL: this module adds the YouTube-into-Telegram-call
branch the dashboard handoff needs. The integration runs end-to-end
in defensive mode — every failure (yt-dlp not installed, extractor
quirk, expired URL, network blip) returns None so the filler
manager can fall back to news transparently.

Why URL extraction rather than full download:
  - Downloading the whole audio takes seconds and stalls the call
    while we wait. Streaming via the direct CDN URL starts within
    one HTTP roundtrip.
  - pytgcalls' MediaStream accepts URL strings; ffmpeg-under-the-hood
    handles the actual fetch with a Range request.
  - The signed CDN URL expires (~5 h on YouTube), but typical call
    durations are a small fraction of that, and we cache by video id
    to avoid re-extracting on every call.

Failure modes we handle:
  - `yt_dlp` not installed → import-time guard returns None
  - Extractor raises (geo-block, age gate, deleted) → None
  - URL expired mid-call → caller is expected to re-resolve and
    restart; this module flushes the cache entry on demand
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Optional

log = logging.getLogger(__name__)

# Cache TTL is well under YouTube's typical signed-URL expiry of
# ~5 h. We could push this to 4 h, but 1 h is safer — a long-running
# Telegram call doesn't sit on a stale URL just because we got lucky
# at extraction time.
CACHE_TTL_S = 3600.0

# Lazy import — keeps "yt-dlp not installed" out of the hot path.
# A first call without the dep produces ONE warning and returns None;
# the filler_manager treats that the same as "no video selected".
_yt_dlp_mod = None
_yt_dlp_load_attempted = False
_yt_dlp_warned = False


def _load_yt_dlp():
    global _yt_dlp_mod, _yt_dlp_load_attempted, _yt_dlp_warned
    if _yt_dlp_load_attempted:
        return _yt_dlp_mod
    _yt_dlp_load_attempted = True
    try:
        import yt_dlp  # type: ignore[import-not-found]

        _yt_dlp_mod = yt_dlp
    except ImportError:
        if not _yt_dlp_warned:
            log.warning(
                "yt_dlp not installed; YouTube branch will fall back to "
                "news. Install with: pip install yt-dlp",
            )
            _yt_dlp_warned = True
        _yt_dlp_mod = None
    return _yt_dlp_mod


@dataclass
class ResolvedAudio:
    video_id: str
    url: str
    duration_sec: Optional[float]
    title: Optional[str]
    resolved_at: float


_cache: dict[str, ResolvedAudio] = {}


def _is_fresh(entry: ResolvedAudio) -> bool:
    return (time.monotonic() - entry.resolved_at) < CACHE_TTL_S


def _extract_sync(video_id: str) -> Optional[ResolvedAudio]:
    """
    Blocking yt-dlp extraction. Run via asyncio.to_thread() — the
    call hits the network and parses YouTube's player config, which
    is single-digit-hundreds-of-ms in the happy path but can stretch
    into seconds on first run.
    """
    yt = _load_yt_dlp()
    if yt is None:
        return None
    # Audio-only format selection. `bestaudio[ext=m4a]/bestaudio`
    # prefers an MP4-A4 stream (broadly compatible with ffmpeg) and
    # falls back to whatever bestaudio exists if YouTube hasn't
    # transcoded that container for this video.
    opts = {
        "format": "bestaudio[ext=m4a]/bestaudio",
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        # Limit the player request to the cheapest extractor path —
        # geo-bypass and HLS handling cost extra round-trips we don't
        # need for typical music videos.
        "extractor_args": {"youtube": {"player_client": ["android"]}},
    }
    url_in = f"https://www.youtube.com/watch?v={video_id}"
    try:
        with yt.YoutubeDL(opts) as ydl:  # type: ignore[attr-defined]
            info = ydl.extract_info(url_in, download=False)
    except Exception as exc:  # yt_dlp raises a zoo of subclasses
        log.warning("yt_dlp extract failed for %s: %s", video_id, exc)
        return None
    if not isinstance(info, dict):
        return None
    url = info.get("url")
    if not isinstance(url, str) or not url:
        # Sometimes the top-level info has `formats` instead — pick
        # the highest-bitrate audio entry as a fallback.
        formats = info.get("formats") or []
        audio_formats = [
            f
            for f in formats
            if isinstance(f, dict)
            and f.get("vcodec") in (None, "none")
            and isinstance(f.get("url"), str)
        ]
        if not audio_formats:
            log.warning("yt_dlp returned no audio url for %s", video_id)
            return None
        audio_formats.sort(
            key=lambda f: (f.get("abr") or f.get("tbr") or 0),
            reverse=True,
        )
        url = audio_formats[0]["url"]
    duration = info.get("duration")
    title = info.get("title")
    return ResolvedAudio(
        video_id=video_id,
        url=url,
        duration_sec=float(duration) if isinstance(duration, (int, float)) else None,
        title=str(title) if isinstance(title, str) else None,
        resolved_at=time.monotonic(),
    )


async def resolve_audio_url(video_id: str) -> Optional[ResolvedAudio]:
    """
    Return a ResolvedAudio for `video_id`, using the per-process
    cache when fresh. Returns None when extraction fails — caller
    is expected to fall back to news.
    """
    if not video_id or len(video_id) != 11:
        return None
    cached = _cache.get(video_id)
    if cached and _is_fresh(cached):
        return cached
    resolved = await asyncio.to_thread(_extract_sync, video_id)
    if resolved is not None:
        _cache[video_id] = resolved
    return resolved


def invalidate(video_id: str) -> None:
    """
    Remove a cached entry — call this after a play attempt fails
    (e.g. CDN URL was already expired by the time pytgcalls tried
    to play it) so the next call re-extracts a fresh URL.
    """
    _cache.pop(video_id, None)


def is_available() -> bool:
    """Quick check the filler manager can use to decide whether to
    even attempt the YouTube branch this call. Cheap — no network."""
    return _load_yt_dlp() is not None
