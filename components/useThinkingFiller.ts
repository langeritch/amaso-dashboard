"use client";

import { useEffect, useRef, useState } from "react";
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
}

interface IndexResponse {
  clips: ClipMeta[];
  silenceBridgeId: string | null;
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

export function useThinkingFiller(active: boolean): { hasContent: boolean } {
  const ctxRef = useRef<AudioContext | null>(null);
  const clipsRef = useRef<ClipMeta[]>([]);
  const bufferCacheRef = useRef<Map<string, AudioBuffer>>(new Map());
  const playedIdsRef = useRef<Set<string>>(new Set());
  const currentSourceRef = useRef<ActiveSource | null>(null);
  // When `active` flips false mid-clip we stash the clip id + the
  // offset we'd reached, so the next `active=true` resumes the same
  // clip instead of jumping to a new one. Cleared on natural clip
  // end so we advance normally when a clip plays through.
  const resumeRef = useRef<ResumeState | null>(null);
  const activeRef = useRef(false);
  const [hasContent, setHasContent] = useState(false);

  // Mount-only: create the AudioContext, fetch the index, pre-decode
  // the first clip. Keep the ctx alive across every active toggle
  // (cheap to keep, expensive to recreate on every thinking edge).
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;

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
        // Warm up the first couple so the first activation starts fast.
        const warm = data.clips.slice(0, 2);
        void Promise.all(warm.map((c) => fetchAndDecode(c.id)));
        // If `active` flipped true while we were fetching, kick off.
        if (activeRef.current && data.clips.length > 0) {
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
    if (active) {
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
    // an automatic fallback.
    const pool = clips.filter((c) => !playedIdsRef.current.has(c.id));
    if (pool.length === 0) return null;
    const clip = pool[0];
    playedIdsRef.current.add(clip.id);
    return clip.id;
  }

  async function playNext(): Promise<void> {
    if (!activeRef.current) return;
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
      if (!activeRef.current) return;
      window.setTimeout(() => {
        if (!activeRef.current) return;
        void playNext();
      }, GAP_BETWEEN_CLIPS_S * 1000);
    };

    // start(when, offset) — passing the buffer offset lets WebAudio
    // resume in the middle of the decoded clip without us having to
    // build a secondary trimmed buffer.
    source.start(0, startOffset);
    setFillerAudible("news-clip", true);

    // Prefetch the *next* clip in parallel with playback so onended
    // can chain without a decode roundtrip. Harmless if we never
    // actually play it — it just sits in the buffer cache.
    const upcoming = clipsRef.current.find(
      (c) => !playedIdsRef.current.has(c.id),
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

  return { hasContent };
}
