"use client";

import { useEffect, useRef } from "react";
import {
  registerFillerStopHandler,
  setFillerAudible,
} from "@/lib/filler-handoff";

/**
 * Warm ambient pad for thinking-time silence. Distinct from the
 * windchime in `useThinkingHum` (an event-y looped WAV) and from
 * any of the spoken-filler systems (news clips / fun-facts TTS).
 * This is a continuous low-level drone synthesised on the fly, so
 * gaps where no other content is playing don't read as dead air.
 *
 * Sound design:
 *   - Two sine oscillators at A2 (110 Hz) detuned ±5 cents → mild
 *     beating that gives the drone life without sounding like a
 *     fixed tone. The mind tends to file fixed tones as "machine
 *     noise"; the slow beat reads as ambience.
 *   - A third sine at the perfect fifth (165 Hz). Adds harmonic
 *     warmth without going high enough to cut through speech if
 *     this ever leaks into a moment where someone's talking.
 *   - Lowpass at 700 Hz with a soft slope strips any aliasing or
 *     latent harshness so the pad sits well under TTS / chimes.
 *   - Master gain envelopes from 0 to 0.04 over 1 s (fade-in) and
 *     back to 0 over 500 ms (fade-out). 0.04 ≈ -28 dBFS — well
 *     below TTS playback (~-12 dBFS), so it's "presence, not
 *     content".
 *   - A 0.06 Hz LFO sweeps the lowpass cutoff between 600–800 Hz
 *     so the timbre breathes slightly, reinforcing "live ambient"
 *     vs "dead loop".
 *
 * Tear-down: synchronous nullify of `nodesRef` on stop so a quick
 * active-true → false → true sequence creates fresh oscillators
 * instead of fighting the ones still fading. Matches the pattern
 * in `useThinkingHum`.
 */

interface PadNodes {
  ctx: AudioContext;
  oscA: OscillatorNode;
  oscB: OscillatorNode;
  oscFifth: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
}

const TARGET_GAIN = 0.04;
const FADE_IN_S = 1.0;
const FADE_OUT_S = 0.5;

export function useAmbientPad(active: boolean): void {
  const ctxRef = useRef<AudioContext | null>(null);
  const nodesRef = useRef<PadNodes | null>(null);
  const activeRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
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
    // Hook into the filler-handoff coordinator so SparProvider can
    // request a fade-out on this source the moment real TTS arrives.
    const unregister = registerFillerStopHandler("ambient-pad", () => {
      fadeOutAndStop();
    });
    return () => {
      unregister();
      setFillerAudible("ambient-pad", false);
      stopImmediately();
      ctxRef.current = null;
      try {
        void ctx.close();
      } catch {
        /* ignore */
      }
    };
    // Mount-only — second effect drives the active toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    activeRef.current = active;
    if (active) start();
    else fadeOutAndStop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function start(): void {
    const ctx = ctxRef.current;
    if (!ctx) return;

    // Already playing — re-arm the fade-in in case we were mid-fade-out.
    if (nodesRef.current) {
      const { gain } = nodesRef.current;
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(TARGET_GAIN, now + FADE_IN_S);
      return;
    }

    void ctx.resume().catch(() => {});

    const oscA = ctx.createOscillator();
    oscA.type = "sine";
    oscA.frequency.value = 110;
    oscA.detune.value = -5;

    const oscB = ctx.createOscillator();
    oscB.type = "sine";
    oscB.frequency.value = 110;
    oscB.detune.value = 5;

    const oscFifth = ctx.createOscillator();
    oscFifth.type = "sine";
    oscFifth.frequency.value = 165;

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 700;
    filter.Q.value = 0.5;

    // Slow LFO breathes the cutoff between ~600 and ~800 Hz so the
    // timbre doesn't sit perfectly still — the difference between
    // ambience and a "machine on" tone.
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 100;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);

    const gain = ctx.createGain();
    gain.gain.value = 0;

    oscA.connect(filter);
    oscB.connect(filter);
    oscFifth.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);

    oscA.start();
    oscB.start();
    oscFifth.start();
    lfo.start();

    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(TARGET_GAIN, now + FADE_IN_S);

    nodesRef.current = {
      ctx,
      oscA,
      oscB,
      oscFifth,
      filter,
      gain,
      lfo,
      lfoGain,
    };
    // Audible from the first sample of the fade-in. The handoff
    // waiter uses this to know "there's still something making
    // sound" — being conservative here is correct: it's better to
    // delay the answer by one extra fade-out than to overlap.
    setFillerAudible("ambient-pad", true);
  }

  function fadeOutAndStop(): void {
    const nodes = nodesRef.current;
    if (!nodes) return;
    nodesRef.current = null;
    const { ctx, gain, oscA, oscB, oscFifth, lfo, filter, lfoGain } = nodes;
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + FADE_OUT_S);
    setTimeout(
      () => {
        for (const n of [oscA, oscB, oscFifth, lfo]) {
          try {
            n.stop();
          } catch {
            /* already stopped */
          }
          try {
            n.disconnect();
          } catch {
            /* ignore */
          }
        }
        for (const n of [filter, gain, lfoGain]) {
          try {
            n.disconnect();
          } catch {
            /* ignore */
          }
        }
        // Fade is fully complete — release the audible flag so the
        // handoff waiter can resolve and the answer can start.
        setFillerAudible("ambient-pad", false);
      },
      FADE_OUT_S * 1000 + 50,
    );
  }

  function stopImmediately(): void {
    const nodes = nodesRef.current;
    nodesRef.current = null;
    if (!nodes) return;
    for (const n of [nodes.oscA, nodes.oscB, nodes.oscFifth, nodes.lfo]) {
      try {
        n.stop();
      } catch {
        /* already stopped */
      }
      try {
        n.disconnect();
      } catch {
        /* ignore */
      }
    }
    try {
      nodes.filter.disconnect();
      nodes.gain.disconnect();
      nodes.lfoGain.disconnect();
    } catch {
      /* ignore */
    }
    setFillerAudible("ambient-pad", false);
  }
}
