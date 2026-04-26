"use client";

import { useEffect, useRef } from "react";

/**
 * Soft ambient "thinking" chime for the browser voice UI.
 *
 * Replaces the earlier two-detuned-sine drone (90/93 Hz) with the same
 * wind-chime WAV the Python telegram-voice service plays into calls —
 * fetched from `/api/telegram/sounds/thinking_chime.wav`. Single source
 * of truth for both channels means the user hears an identical cue
 * whether they're on the laptop or the phone; rewriting the recipe in
 * Web Audio a second time was the obvious alternative, but any drift
 * between the two implementations shows up as a jarring "this doesn't
 * sound like the phone one" the moment you switch mid-conversation.
 *
 * We still go through Web Audio (not a raw <audio loop>) because we
 * want smooth gain ramps when `active` toggles — `<audio>.volume` isn't
 * sample-accurate and the fade ends up audibly stepped. AudioBuffer +
 * AudioBufferSourceNode + GainNode gets us zero-click fades and a
 * gapless loop for free.
 *
 * If the WAV isn't on disk yet (telegram-voice has never run on this
 * machine) the fetch 404s and the hook becomes a no-op. A missing
 * chime is a papercut, not worth breaking the voice flow over.
 *
 * Volume is capped well below TTS playback level so the chime sits
 * under the assistant's voice rather than competing with it.
 */

interface ChimeNodes {
  ctx: AudioContext;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

// `?v=` cache-bust matches `_SOUND_RECIPE_VERSION` in the Python
// service. The sounds route marks responses `immutable`, so bumping
// the query string is how we force a refetch after a recipe change.
const CHIME_URL = "/api/telegram/sounds/thinking_chime.wav?v=2";
const TARGET_GAIN = 0.6; // WAV is rendered quiet on disk (peak ~0.22); this
//                         plus the peak combine to roughly -15 dBFS, about
//                         the same perceived level as the old drone.
const FADE_IN_S = 0.4;
const FADE_OUT_S = 0.4;

export function useThinkingHum(active: boolean): void {
  const ctxRef = useRef<AudioContext | null>(null);
  const bufferRef = useRef<AudioBuffer | null>(null);
  const nodesRef = useRef<ChimeNodes | null>(null);
  const activeRef = useRef(false);

  // Lazy-load the AudioContext + decoded buffer once per mount. Both
  // are expensive to recreate (fetch + decode) so we hang on to them
  // across every toggle, and only tear everything down on unmount.
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
        const resp = await fetch(CHIME_URL, { cache: "force-cache" });
        if (!resp.ok) return; // 404 = not baked yet; silent no-op.
        const bytes = await resp.arrayBuffer();
        const decoded = await ctx.decodeAudioData(bytes);
        if (cancelled) return;
        bufferRef.current = decoded;
        // If `active` flipped true while we were fetching, start now.
        if (activeRef.current) startChime();
      } catch {
        /* network / decode failure — stay silent */
      }
    })();

    return () => {
      cancelled = true;
      stopChimeImmediately();
      const c = ctxRef.current;
      ctxRef.current = null;
      bufferRef.current = null;
      try {
        void c?.close();
      } catch {
        /* ignore */
      }
    };
    // Mount-only: the hook's `active` prop drives the second effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    activeRef.current = active;
    if (active) startChime();
    else fadeOutAndStop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function startChime(): void {
    const ctx = ctxRef.current;
    const buffer = bufferRef.current;
    if (!ctx || !buffer) return;
    // Already playing — just (re)start the fade-in in case we were
    // mid-fade-out when `active` flipped back on.
    if (nodesRef.current) {
      const { gain } = nodesRef.current;
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(TARGET_GAIN, now + FADE_IN_S);
      return;
    }

    void ctx.resume().catch(() => {});
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(ctx.destination);
    source.start();
    nodesRef.current = { ctx, source, gain };

    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(TARGET_GAIN, now + FADE_IN_S);
  }

  function fadeOutAndStop(): void {
    const nodes = nodesRef.current;
    if (!nodes) return;
    const { ctx, source, gain } = nodes;
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + FADE_OUT_S);
    // Stop the source after the fade so we don't leak an oscillating
    // buffer node in the background. We null out `nodesRef` synchronously
    // so a quick re-activation during the fade creates a fresh source
    // rather than fighting the one that's on its way out.
    nodesRef.current = null;
    const tearDown = () => {
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
    };
    setTimeout(tearDown, FADE_OUT_S * 1000 + 50);
  }

  function stopChimeImmediately(): void {
    const nodes = nodesRef.current;
    nodesRef.current = null;
    if (!nodes) return;
    try {
      nodes.source.stop();
    } catch {
      /* already stopped */
    }
    try {
      nodes.source.disconnect();
      nodes.gain.disconnect();
    } catch {
      /* ignore */
    }
  }
}
