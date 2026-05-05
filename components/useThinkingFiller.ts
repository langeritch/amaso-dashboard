"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  registerFillerStopHandler,
  setFillerAudible,
} from "@/lib/filler-handoff";

/**
 * Plays pre-rendered filler content (news headlines, fun facts) over
 * the browser speakers while Spar is thinking — the same WAV pool
 * the Python telegram-voice service generates into
 * `telegram-voice/filler-cache/`. The dashboard reads that pool via
 * `/api/filler/clips` + `/api/filler/clip/[id]` and never synthesises
 * anything itself; whatever the Python prerender has cooked up is
 * what the browser plays.
 *
 * Why Web Audio (not a plain <audio> element):
 *   - Sample-accurate gain envelopes. The Telegram side can only
 *     hard-cut streams; here we actually fade, so the transition
 *     into Spar's real TTS reply sounds like a dip instead of a
 *     rug-pull.
 *   - Buffer pool + prefetch for gapless chaining. The next clip is
 *     fetched + decoded while the current one is playing, so the
 *     200 ms inter-clip gap stays a feature, not an accident of
 *     network latency.
 *   - Shares the event loop's playback clock with no competing
 *     media-element timing, which is what made `useThinkingHum`'s
 *     fades clean in the first place.
 *
 * Falls back silently when:
 *   - The browser can't make an AudioContext (no Web Audio)
 *   - `/api/filler/clips` returns an empty list (Python never
 *     prerendered, or the cache got wiped). In that case `hasContent`
 *     stays false and callers can activate `useThinkingHum` instead.
 *
 * Session state (played-id set) lives inside the hook instance; it
 * resets when the provider unmounts, which for Spar means on full
 * page reload. Good enough — the point is just "don't replay the
 * same headline three turns in a row", not indefinite dedup.
 */

interface ClipMeta {
  id: string;
  kind: "news";
  title: string | null;
  source: string | null;
}

interface IndexResponse {
  clips: ClipMeta[];
  silenceBridgeId: string | null;
}

export interface NewsFillerState {
  /** True while a clip is actively decoding/playing (not while
   *  paused or between clips). The mini-player uses this to flip
   *  the play/pause icon. */
  hasContent: boolean;
  /** Currently-loaded clip (the one whose audio is decoded into the
   *  active source, or just paused mid-buffer). null when no clip is
   *  staged. */
  currentClip: ClipMeta | null;
  /** Up to ~10 unplayed clips in the order they'll play. Drives the
   *  "up next" list in the unified mini-player. */
  upcoming: ClipMeta[];
  /** User-initiated pause flag. Distinct from the prop-driven
   *  active=false fade — user pauses persist across active toggles
   *  (a thinking window that lands while paused stays silent). */
  paused: boolean;
  pause: () => void;
  resume: () => void;
  /** Advance to the next clip immediately. Drops the current clip's
   *  resume offset so a re-activation starts fresh. */
  skip: () => void;
}

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  clipId: string;
  stopTimeoutId: number | null;
  // Playback-position bookkeeping. `startTime` is the ctx clock when
  // we called source.start(); `baseOffset` is the offset into the
  // buffer we started at (nonzero when resuming). The interrupt
  // position is computed as baseOffset + (ctx.currentTime - startTime).
  startTime: number;
  baseOffset: number;
  buffer: AudioBuffer;
}

interface ResumeState {
  clipId: string;
  offset: number;
}

// When a clip finishes with less than this many seconds left vs. its
// buffer duration, treat it as "done" and don't bother saving a
// resume point — advancing to the next clip is nicer than hearing a
// tiny tail fragment.
const RESUME_MIN_TAIL_S = 0.25;

// Index endpoint returns the full playable pool; exclude the silence
// bridge entry here because the fade-out envelope replaces it.
const INDEX_URL = "/api/filler/clips";
const CLIP_URL = (id: string) => `/api/filler/clip/${id}`;

// localStorage key + lifetime cap. Survives reloads so the same news
// headline can't be heard 10 times across a day's worth of sessions —
// playedIdsRef alone resets on reload, which is what the user keeps
// bumping into. Three plays is the soft retire bar: enough that a
// missed clip can come back around once or twice, low enough that
// stale headlines actually drop out.
const PLAY_COUNT_STORAGE_KEY = "news-clip-play-counts";
const MAX_PLAYS_PER_CLIP = 3;

const TARGET_GAIN = 1.0;
const FADE_IN_S = 0.25;
// Matches the Telegram side's silence_bridge duration so the UX
// feels the same whether you're in the browser or on the phone.
const FADE_OUT_S = 0.5;
// Silence between chained clips — matches INTER_CLIP_GAP_S on the
// Python filler_manager. A full second between news stories gives
// the listener a beat to absorb one before the next arrives;
// anything shorter felt like clips were stacking.
const GAP_BETWEEN_CLIPS_S = 1.0;

export function useThinkingFiller(active: boolean): NewsFillerState {
  const ctxRef = useRef<AudioContext | null>(null);
  const clipsRef = useRef<ClipMeta[]>([]);
  const bufferCacheRef = useRef<Map<string, AudioBuffer>>(new Map());
  const playedIdsRef = useRef<Set<string>>(new Set());
  // Lifetime play counts, hydrated from localStorage on mount. Distinct
  // from playedIdsRef (which is session-scoped within-mount dedup):
  // this one survives reloads and triggers the MAX_PLAYS_PER_CLIP cap.
  const playCountsRef = useRef<Map<string, number>>(new Map());
  const currentSourceRef = useRef<ActiveSource | null>(null);
  // When `active` flips false mid-clip we stash the clip id + the
  // offset we'd reached, so the next `active=true` resumes the same
  // clip instead of jumping to a new one. Cleared on natural clip
  // end so we advance normally when a clip plays through.
  const resumeRef = useRef<ResumeState | null>(null);
  const activeRef = useRef(false);
  // User-initiated pause. The mini-player drives this directly via
  // pause()/resume(); it composes with `active` by AND — both have
  // to be true for audio to flow.
  const pausedRef = useRef(false);
  const [paused, setPausedState] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const [currentClip, setCurrentClip] = useState<ClipMeta | null>(null);
  const [upcoming, setUpcoming] = useState<ClipMeta[]>([]);

  // Recompute the "up next" list whenever the played-set or the
  // clip pool changes. Cap at 10 — long enough to feel like a queue,
  // short enough that the expanded mini-player card doesn't scroll
  // forever. Also drops clips that have hit the lifetime play cap so
  // the queue UI never advertises a clip pickNextClipId would skip.
  const refreshUpcoming = useCallback(() => {
    const pool = clipsRef.current.filter(
      (c) =>
        !playedIdsRef.current.has(c.id) &&
        (playCountsRef.current.get(c.id) ?? 0) < MAX_PLAYS_PER_CLIP,
    );
    setUpcoming(pool.slice(0, 10));
  }, []);

  // Bump the lifetime count for a clip and persist immediately.
  // Synchronous write because the next pickNextClipId call needs to
  // see the new total, and we can't wait for a microtask if a fade
  // and reload race. Storage failures (quota / disabled) silently
  // degrade to in-memory only — losing persistence is much better
  // than losing playback.
  const recordPlay = useCallback((clipId: string) => {
    const next = (playCountsRef.current.get(clipId) ?? 0) + 1;
    playCountsRef.current.set(clipId, next);
    if (typeof window === "undefined") return;
    try {
      const obj: Record<string, number> = {};
      for (const [k, v] of playCountsRef.current.entries()) obj[k] = v;
      window.localStorage.setItem(
        PLAY_COUNT_STORAGE_KEY,
        JSON.stringify(obj),
      );
    } catch {
      /* quota / disabled — keep going from memory */
    }
  }, []);

  // Mount-only: create the AudioContext, fetch the index, pre-decode
  // the first clip. Keep the ctx alive across every active toggle
  // (cheap to keep, expensive to recreate on every thinking edge).
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

    // Hydrate lifetime play counts before anything else can call
    // pickNextClipId. A corrupt blob (hand-edited, partial write)
    // resets to empty rather than crashing — the user just hears
    // some already-played clips again, which is the worst case.
    try {
      const raw = window.localStorage.getItem(PLAY_COUNT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object") {
          const map = new Map<string, number>();
          for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof v === "number" && Number.isFinite(v) && v > 0) {
              map.set(k, v);
            }
          }
          playCountsRef.current = map;
        }
      }
    } catch {
      /* corrupt or unavailable — start from empty */
    }

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;

    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return;
    }
    ctxRef.current = ctx;

    (async () => {
      try {
        const resp = await fetch(INDEX_URL, { cache: "no-store" });
        if (!resp.ok) return;
        const data = (await resp.json()) as IndexResponse;
        if (cancelled) return;
        clipsRef.current = data.clips;
        setHasContent(data.clips.length > 0);
        refreshUpcoming();
        // Warm up the first couple so the first activation starts fast.
        const warm = data.clips.slice(0, 2);
        void Promise.all(warm.map((c) => fetchAndDecode(c.id)));
        // If `active` flipped true while we were fetching, kick off.
        if (activeRef.current && !pausedRef.current && data.clips.length > 0) {
          void playNext();
        }
      } catch {
        /* network / parse failure — hum fallback covers us */
      }
    })();

    // Hand SparProvider a stop trigger via the filler-handoff
    // coordinator. Same path as the prop-driven `active=false`
    // route — fadeOutCurrent is idempotent so calling it twice in
    // quick succession is fine.
    const unregister = registerFillerStopHandler("news-clip", () => {
      fadeOutCurrent();
    });

    return () => {
      cancelled = true;
      unregister();
      setFillerAudible("news-clip", false);
      stopImmediately();
      const c = ctxRef.current;
      ctxRef.current = null;
      bufferCacheRef.current.clear();
      try {
        void c?.close();
      } catch {
        /* ignore */
      }
    };
    // Mount-only — the second effect handles the `active` transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    activeRef.current = active;
    if (active && !pausedRef.current) {
      void playNext();
    } else {
      fadeOutCurrent();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function fetchAndDecode(id: string): Promise<AudioBuffer | null> {
    const ctx = ctxRef.current;
    if (!ctx) return null;
    const cached = bufferCacheRef.current.get(id);
    if (cached) return cached;
    try {
      const resp = await fetch(CLIP_URL(id), { cache: "force-cache" });
      if (!resp.ok) return null;
      const bytes = await resp.arrayBuffer();
      const decoded = await ctx.decodeAudioData(bytes);
      bufferCacheRef.current.set(id, decoded);
      return decoded;
    } catch {
      return null;
    }
  }

  function pickNextClipId(): string | null {
    const clips = clipsRef.current;
    if (clips.length === 0) return null;
    // No cycle-back: once every fresh clip has played this session
    // we return null so the caller goes silent. Better than looping
    // yesterday's headlines mid-call; a replay is an explicit
    // user-initiated flow (via MCP / "play that one again"), not
    // an automatic fallback. The play-count filter is the lifetime
    // cap layered on top: a clip that's been heard 3 times across
    // any combination of sessions retires until the cache rolls.
    const pool = clips.filter(
      (c) =>
        !playedIdsRef.current.has(c.id) &&
        (playCountsRef.current.get(c.id) ?? 0) < MAX_PLAYS_PER_CLIP,
    );
    if (pool.length === 0) return null;
    const clip = pool[0];
    playedIdsRef.current.add(clip.id);
    // Defer the upcoming-list refresh so React doesn't tear into the
    // ongoing render — pickNextClipId is called from inside playNext,
    // not a render path.
    refreshUpcoming();
    return clip.id;
  }

  async function playNext(): Promise<void> {
    if (!activeRef.current || pausedRef.current) return;
    const ctx = ctxRef.current;
    if (!ctx) return;

    // Resume-from-offset: if the last activation was cut short
    // mid-clip, pick up the same clip where it left off rather than
    // jumping to a fresh one. resumeRef is consumed here and only
    // re-populated if THIS clip also gets interrupted.
    let id: string | null;
    let startOffset = 0;
    const saved = resumeRef.current;
    if (saved && clipsRef.current.some((c) => c.id === saved.clipId)) {
      id = saved.clipId;
      startOffset = saved.offset;
      resumeRef.current = null;
    } else {
      // Stale resume (clip no longer in the pool) — discard and
      // advance normally.
      if (saved) resumeRef.current = null;
      id = pickNextClipId();
    }
    if (!id) return;

    const buffer = await fetchAndDecode(id);
    // Active could have flipped false while we were decoding; re-check
    // before actually scheduling playback.
    if (!buffer || !activeRef.current) return;

    // A resume offset past (or within a blink of) the buffer end
    // means the clip was effectively done when we snapshot. Treat as
    // finished and advance instead.
    if (startOffset >= Math.max(0, buffer.duration - RESUME_MIN_TAIL_S)) {
      void playNext();
      return;
    }

    void ctx.resume().catch(() => {});
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(TARGET_GAIN, now + FADE_IN_S);

    const entry: ActiveSource = {
      source,
      gain,
      clipId: id,
      stopTimeoutId: null,
      startTime: now,
      baseOffset: startOffset,
      buffer,
    };
    currentSourceRef.current = entry;

    source.onended = () => {
      // If we were replaced (fadeOutCurrent cleared the ref) don't
      // auto-chain — the TTS reply is on its way. Don't touch
      // resumeRef either; fadeOutCurrent already snapshot the
      // position for the next activation.
      if (currentSourceRef.current !== entry) return;
      currentSourceRef.current = null;
      // Natural end — only here do we count the clip toward its
      // lifetime cap. Fade-out (assistant interrupting) is not a
      // full play; the user heard half a sentence and we'll resume
      // it. Skip is counted separately in the skip() handler.
      recordPlay(id);
      // Clip finished naturally — any resume snapshot that still
      // points at it is stale. Clear it so the next activation
      // advances to a new clip instead of replaying the tail of
      // this one.
      if (resumeRef.current?.clipId === id) {
        resumeRef.current = null;
      }
      // Natural end — release audible immediately. Inter-clip gap
      // is silent so the handoff waiter shouldn't block during it.
      setFillerAudible("news-clip", false);
      // Clear the now-playing metadata once the clip finishes. The
      // next playNext() resets it; until then the mini-player shows
      // an empty title (an inter-clip gap, ~1 s).
      setCurrentClip(null);
      if (!activeRef.current || pausedRef.current) return;
      window.setTimeout(() => {
        if (!activeRef.current || pausedRef.current) return;
        void playNext();
      }, GAP_BETWEEN_CLIPS_S * 1000);
    };

    // start(when, offset) — passing the buffer offset lets WebAudio
    // resume in the middle of the decoded clip without us having to
    // build a secondary trimmed buffer.
    source.start(0, startOffset);
    setFillerAudible("news-clip", true);
    // Surface the now-playing clip metadata for the unified mini-
    // player. Look up by id so the rendered title/source survives
    // even on resume — pickNextClipId already added it to the played
    // set and pulled it out of the upcoming pool.
    const meta = clipsRef.current.find((c) => c.id === id) ?? null;
    setCurrentClip(meta);

    // Prefetch the *next* clip in parallel with playback so onended
    // can chain without a decode roundtrip. Harmless if we never
    // actually play it — it just sits in the buffer cache. Mirror
    // the pickNextClipId filter so we don't warm a clip that's
    // already at the lifetime cap.
    const upcoming = clipsRef.current.find(
      (c) =>
        !playedIdsRef.current.has(c.id) &&
        (playCountsRef.current.get(c.id) ?? 0) < MAX_PLAYS_PER_CLIP,
    );
    if (upcoming) void fetchAndDecode(upcoming.id);
  }

  function fadeOutCurrent(): void {
    const entry = currentSourceRef.current;
    // Clear synchronously so a quick re-activation during the fade
    // starts a fresh source instead of fighting this one.
    currentSourceRef.current = null;
    if (!entry) return;
    const ctx = ctxRef.current;

    // Snapshot resume position before tearing the source down. We
    // capture at fade-START rather than fade-END: the ~500 ms of
    // audible fade gets replayed (with a fade-in) next activation,
    // which sounds intentional — the alternative is a silent
    // fade-out window you never actually hear and can't recover.
    if (ctx) {
      const elapsed = ctx.currentTime - entry.startTime;
      const offset = entry.baseOffset + Math.max(0, elapsed);
      // Skip saving if the clip was basically done when we cut in —
      // better to advance to a fresh thought than resume the last
      // 100 ms of an old one.
      if (offset < entry.buffer.duration - RESUME_MIN_TAIL_S) {
        resumeRef.current = { clipId: entry.clipId, offset };
      } else if (resumeRef.current?.clipId === entry.clipId) {
        resumeRef.current = null;
      }
    }

    if (!ctx) {
      try {
        entry.source.stop();
      } catch {
        /* already stopped */
      }
      setFillerAudible("news-clip", false);
      return;
    }
    const { source, gain } = entry;
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + FADE_OUT_S);
    entry.stopTimeoutId = window.setTimeout(() => {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        /* ignore */
      }
      // Tail is fully silent — let the handoff waiter resolve.
      setFillerAudible("news-clip", false);
    }, FADE_OUT_S * 1000 + 50);
  }

  function stopImmediately(): void {
    const entry = currentSourceRef.current;
    currentSourceRef.current = null;
    setFillerAudible("news-clip", false);
    if (!entry) return;
    if (entry.stopTimeoutId !== null) {
      window.clearTimeout(entry.stopTimeoutId);
    }
    try {
      entry.source.stop();
    } catch {
      /* already stopped */
    }
    try {
      entry.source.disconnect();
      entry.gain.disconnect();
    } catch {
      /* ignore */
    }
  }

  // User-pause: fade out + don't chain. Setting pausedRef before
  // fadeOutCurrent makes the resume snapshot capture the right
  // offset (fadeOutCurrent already does that bookkeeping).
  const pause = useCallback(() => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    setPausedState(true);
    fadeOutCurrent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resume from where pause left off. Only kicks playback if the
  // upstream `active` gate is also true — when the assistant isn't
  // thinking, "resume" just clears the paused flag and the next
  // thinking window will start playing again.
  const resume = useCallback(() => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    setPausedState(false);
    if (activeRef.current) {
      void playNext();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Skip: drop the current clip's resume offset and advance. Treats
  // the current clip as fully consumed (its id stays in playedIds so
  // we won't loop back to it). Also clears userPaused so a "skip
  // through silence" doesn't strand on a paused next clip.
  const skip = useCallback(() => {
    // Skip counts toward the lifetime cap — the user explicitly said
    // "I'm done with this one." Capture the id BEFORE fadeOutCurrent
    // tears the source ref down. Distinct from the prop-driven fade
    // (active=false), which is an interruption, not a dismissal.
    const skipped = currentSourceRef.current?.clipId;
    if (skipped) recordPlay(skipped);
    resumeRef.current = null;
    fadeOutCurrent();
    // Re-clear resumeRef because fadeOutCurrent's bookkeeping may
    // have re-stored the just-faded clip — skip semantics mean
    // "don't come back to it".
    resumeRef.current = null;
    if (pausedRef.current) {
      pausedRef.current = false;
      setPausedState(false);
    }
    if (activeRef.current) {
      // Small delay so the fade tail finishes before the next clip
      // starts overlapping it.
      window.setTimeout(() => {
        if (!activeRef.current || pausedRef.current) return;
        void playNext();
      }, FADE_OUT_S * 1000 + 100);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    hasContent,
    currentClip,
    upcoming,
    paused,
    pause,
    resume,
    skip,
  };
}
