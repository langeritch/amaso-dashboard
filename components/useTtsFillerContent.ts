"use client";

import { useEffect, useRef } from "react";
import {
  registerFillerStopHandler,
  setFillerAudible,
} from "@/lib/filler-handoff";

/**
 * TTS-spoken filler for thinking-time gaps. Fetches content from
 * `/api/spar/filler-content`, synthesises it via `/api/tts`, and
 * plays it through its own dedicated <audio> element so it never
 * pollutes SparProvider's TTS state machine.
 *
 * Why a dedicated audio path:
 *   - SparProvider's `ttsAudible` / `ttsIdle` flags gate downstream
 *     decisions like "should the filler trigger?" Routing filler
 *     audio through that pipeline would create a loop where filler
 *     suppresses itself the moment it starts.
 *   - Independent fade control: the real-response handoff needs a
 *     ~300 ms fade-to-silence on top of whatever the main TTS
 *     pipeline is doing. A separate element keeps those concerns
 *     orthogonal.
 *
 * Lifecycle:
 *   1. `active` flips true → wait `delayMs`. If the real reply has
 *      arrived in that window, never start.
 *   2. Fetch next item → POST to `/api/tts` → play the resulting
 *      blob. On natural end, chain into the next item.
 *   3. `active` flips false (real response started arriving): let
 *      the current item finish naturally — that approximates
 *      "finish the current sentence" since each item is 1–2 short
 *      sentences. Don't chain.
 *   4. `realStarted` flips true (real TTS audible right now): hard
 *      handoff — fade the current item to silence over 300 ms and
 *      stop. No overlap with the real reply.
 *
 * Returned `playing` lets the caller surface "filler is talking"
 * to the UI / state machine if it ever needs to.
 */

interface UseTtsFillerContentArgs {
  /** Kick filler on (true) or off (false). Typically `busy && mode is
   *  a TTS-content mode && nobody talking && not on Telegram`. */
  active: boolean;
  /** True when real assistant TTS is *currently audible*. Triggers
   *  the hard fade-out. Distinct from `!active`: the caller often
   *  flips active false a beat before the first real TTS chunk
   *  becomes audible (busy → idle), so we use this as the
   *  "definitely silence now" signal. */
  realStarted: boolean;
  /** ms to wait between active=true and the first fetch. The user
   *  gets quick replies often enough that we don't want to fire on
   *  every <2s thinking gap. 3–5 s is the spec range. */
  delayMs?: number;
}

const DEFAULT_DELAY_MS = 3_500;
const HARD_FADE_MS = 300;
const FETCH_TIMEOUT_MS = 15_000;
const TTS_FALLBACK_VOLUME = 0.85;

export function useTtsFillerContent({
  active,
  realStarted,
  delayMs = DEFAULT_DELAY_MS,
}: UseTtsFillerContentArgs): { playing: boolean } {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Generation counter. Bumped on every "stop chaining" trigger
  // (active flipped false, hard handoff fired). In-flight fetches
  // and async chain-on-end calls compare against this and bail if
  // it's moved past their snapshot — the standard cancellation
  // pattern for non-AbortController async chains.
  const genRef = useRef(0);
  const activeRef = useRef(false);
  const playingRef = useRef(false);
  const startTimerRef = useRef<number | null>(null);
  const fadeTimerRef = useRef<number | null>(null);
  const chainingRef = useRef(false);

  // Mount the audio element once. `playsInline` so iOS doesn't
  // hijack to fullscreen, `crossOrigin` left default (we serve
  // /api/tts from the same origin).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = new Audio();
    el.preload = "auto";
    el.volume = 0; // start muted; fade in on first play()
    audioRef.current = el;
    // Hand SparProvider a way to stop us synchronously the moment
    // the real reply lands. Uses the same hard-fade + don't-chain
    // path the `realStarted` prop already triggers — having both
    // routes is fine because the operations are idempotent.
    const unregister = registerFillerStopHandler("tts-filler", () => {
      chainingRef.current = false;
      cancelStartTimer();
      hardFadeAndStop();
    });
    return () => {
      unregister();
      setFillerAudible("tts-filler", false);
      try {
        el.pause();
      } catch {
        /* ignore */
      }
      audioRef.current = null;
    };
    // Mount-only — second effect drives the active toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drive the lifecycle. Two effects: one for active (start/stop
  // chaining), one for realStarted (hard fade). They share state
  // via refs.
  useEffect(() => {
    activeRef.current = active;
    if (active) {
      startWithDelay();
    } else {
      // Soft stop: don't chain. Let the current item finish — its
      // ~5 s of audio approximates "finish the current sentence".
      chainingRef.current = false;
      cancelStartTimer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!realStarted) return;
    // Hard handoff: real TTS is audible. Cut filler immediately
    // with a quick fade so there's no overlap with the reply.
    chainingRef.current = false;
    cancelStartTimer();
    hardFadeAndStop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realStarted]);

  function startWithDelay(): void {
    if (typeof window === "undefined") return;
    cancelStartTimer();
    const myGen = ++genRef.current;
    chainingRef.current = true;
    startTimerRef.current = window.setTimeout(() => {
      startTimerRef.current = null;
      if (myGen !== genRef.current || !activeRef.current) return;
      void runChain(myGen);
    }, delayMs);
  }

  function cancelStartTimer(): void {
    if (startTimerRef.current !== null) {
      window.clearTimeout(startTimerRef.current);
      startTimerRef.current = null;
    }
  }

  function cancelFadeTimer(): void {
    if (fadeTimerRef.current !== null) {
      window.clearInterval(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  }

  async function runChain(gen: number): Promise<void> {
    while (gen === genRef.current && chainingRef.current && activeRef.current) {
      const ok = await playOne(gen);
      if (!ok) {
        // Couldn't fetch / synthesise / play — give up the chain.
        // The next active=true edge will retry from scratch.
        return;
      }
      // Loop continues into the next item only if no stop signal
      // has fired in the meantime.
    }
  }

  async function playOne(gen: number): Promise<boolean> {
    const el = audioRef.current;
    if (!el) return false;

    // 1) Pull a content item.
    let body: { text: string; mode: string } | null = null;
    try {
      const r = await fetch("/api/spar/filler-content", { cache: "no-store" });
      if (gen !== genRef.current) return false;
      if (r.status === 204) return false; // no content for this mode
      if (!r.ok) return false;
      body = (await r.json()) as { text: string; mode: string };
    } catch {
      return false;
    }
    if (!body || !body.text) return false;

    // 2) Synthesise it.
    let blobUrl: string | null = null;
    try {
      const ctl = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body.text, speed: 1.0 }),
        signal: ctl,
      });
      if (gen !== genRef.current) return false;
      if (!r.ok || r.status === 204) return false;
      const blob = await r.blob();
      if (gen !== genRef.current || blob.size === 0) return false;
      blobUrl = URL.createObjectURL(blob);
    } catch {
      return false;
    }

    // 3) Play it. Wait for `ended` (or a stop signal) before
    //    returning so the caller's while-loop chains correctly.
    el.src = blobUrl;
    el.currentTime = 0;
    el.volume = 0;
    cancelFadeTimer();

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let releaseUrl: (() => void) | null = () => {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        blobUrl = null;
      };

      const cleanup = (chained: boolean) => {
        if (settled) return;
        settled = true;
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("error", onError);
        cancelFadeTimer();
        try {
          el.pause();
        } catch {
          /* ignore */
        }
        if (releaseUrl) {
          releaseUrl();
          releaseUrl = null;
        }
        playingRef.current = false;
        // Audio element has been paused — but if we're cleaning up
        // because of a hard-fade, the fade-out tail is still in
        // flight via `hardFadeAndStop`. Defer flipping audible=false
        // by HARD_FADE_MS so the handoff waiter doesn't release the
        // real-TTS gate before our last sample is silent.
        setTimeout(
          () => setFillerAudible("tts-filler", false),
          HARD_FADE_MS + 50,
        );
        resolve(chained);
      };

      function onEnded() {
        cleanup(true);
      }
      function onError() {
        cleanup(false);
      }
      el.addEventListener("ended", onEnded);
      el.addEventListener("error", onError);

      // External stop signal: poll the gen counter via a microtask
      // chain isn't needed because the realStarted effect calls
      // hardFadeAndStop() directly, which pauses the element. The
      // pause synthesises an `ended`-equivalent only on some
      // browsers, so we ALSO listen for `pause` and resolve there
      // when the gen has moved.
      const audioEl: HTMLAudioElement = el;
      function onPause() {
        if (gen !== genRef.current || !chainingRef.current) {
          audioEl.removeEventListener("pause", onPause);
          cleanup(false);
        }
      }
      audioEl.addEventListener("pause", onPause);

      el.play()
        .then(() => {
          playingRef.current = true;
          setFillerAudible("tts-filler", true);
          // Ramp 0 → target over ~250 ms. Same fade duration as
          // SparProvider uses for the first chunk; matching keeps
          // filler sounds feel "of a piece" with real replies.
          fadeIn(TTS_FALLBACK_VOLUME);
        })
        .catch(() => {
          cleanup(false);
        });
    });
  }

  function fadeIn(target: number): void {
    const el = audioRef.current;
    if (!el) return;
    cancelFadeTimer();
    const steps = 10;
    let step = 0;
    fadeTimerRef.current = window.setInterval(() => {
      step += 1;
      const v = Math.min(target, (target * step) / steps);
      try {
        el.volume = v;
      } catch {
        /* ignore */
      }
      if (step >= steps) cancelFadeTimer();
    }, 25);
  }

  function hardFadeAndStop(): void {
    const el = audioRef.current;
    if (!el) return;
    cancelFadeTimer();
    const startVol = el.volume;
    if (startVol <= 0.001) {
      try {
        el.pause();
      } catch {
        /* ignore */
      }
      return;
    }
    const steps = Math.max(4, Math.round(HARD_FADE_MS / 25));
    let step = 0;
    fadeTimerRef.current = window.setInterval(() => {
      step += 1;
      const v = Math.max(0, startVol * (1 - step / steps));
      try {
        el.volume = v;
      } catch {
        /* ignore */
      }
      if (step >= steps) {
        cancelFadeTimer();
        try {
          el.pause();
        } catch {
          /* ignore */
        }
      }
    }, 25);
  }

  return { playing: playingRef.current };
}
