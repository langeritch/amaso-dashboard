"use client";

import { useEffect, useRef, useCallback } from "react";

/**
 * Programmatic short-tone cue. Synthesises a soft note (or short note
 * sequence) via Web Audio on demand — no WAV asset, no network round-
 * trip. Used for state-transition cues where the existing pre-rendered
 * Telegram WAVs (`your_turn`, `thinking_start`, `message_sent`) don't
 * cover the moment, e.g. the dashboard mic-close edge.
 *
 * Why programmatic instead of a new WAV file?
 *   - No bundle-size cost: a 100 ms tone synthesised at runtime is a
 *     few hundred bytes of JS, not a 30 KB rendered file per cue.
 *   - No fetch + decode latency: cues fire on user-perceptible state
 *     edges; even a primed `<audio>` element costs ~10 ms on first
 *     play, while a scheduled OscillatorNode lands sample-accurate.
 *   - Lets us tune the envelope shape live without bouncing through
 *     the Python sound-recipe pipeline.
 *
 * Sound design (warm-not-beep policy):
 *   - Each note layers three inharmonic partials (1.0, 2.76, 5.40 —
 *     same Fletcher-bell rough cut the Python service uses) so the
 *     timbre reads as struck metal, not a synth sine. Single-sine
 *     cues sound robotic, which is the exact thing the brief vetoed.
 *   - Raised-cosine attack (4 ms) avoids the on-click; exponential
 *     decay over `note.decayMs` lets the tone ring out naturally.
 *   - Peak gain stays well under TTS playback — these are confirmation
 *     cues, not the foreground.
 */

export interface ToneNote {
  /** Fundamental in Hz. Inharmonic partials are added on top. */
  freq: number;
  /** Onset offset from the previous note's start (or 0 for the first
   *  note). Lets you sequence "tone A, then tone B 80 ms later" in a
   *  single play(). */
  offsetMs: number;
  /** Decay tail length. Total note length is `offsetMs + decayMs` from
   *  play() start. Short (60–120 ms) reads as a click; longer (200 ms+)
   *  reads as a bell. */
  decayMs: number;
  /** Per-note loudness, 0–1. Combined with the cue-wide `peak`. */
  velocity: number;
}

export interface ToneCueRecipe {
  notes: ToneNote[];
  /** Final peak gain after the full cue is rendered. 0.10–0.15 is
   *  about right to sit under TTS playback without disappearing. */
  peak: number;
  /** Re-trigger cooldown so rapid-fire callers don't stack the cue.
   *  Defaults to 250 ms (matches useChime). */
  cooldownMs?: number;
}

export function useToneCue(recipe: ToneCueRecipe): () => void {
  const ctxRef = useRef<AudioContext | null>(null);
  const lastPlayedAtRef = useRef(0);
  // Lazily create the AudioContext on first play() so we don't try
  // before a user gesture (browsers block AudioContext construction
  // pre-gesture on some platforms, others auto-suspend it).
  const ensureCtx = useCallback((): AudioContext | null => {
    if (typeof window === "undefined") return null;
    if (ctxRef.current) return ctxRef.current;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctxRef.current = new Ctor();
    } catch {
      return null;
    }
    return ctxRef.current;
  }, []);

  // Tear down on unmount so we don't leak an AudioContext when the
  // component remounts (e.g. fast-refresh in dev).
  useEffect(() => {
    return () => {
      const c = ctxRef.current;
      ctxRef.current = null;
      try {
        void c?.close();
      } catch {
        /* ignore */
      }
    };
  }, []);

  return useCallback(() => {
    const cooldown = recipe.cooldownMs ?? 250;
    const now = Date.now();
    if (now - lastPlayedAtRef.current < cooldown) return;
    lastPlayedAtRef.current = now;

    const ctx = ensureCtx();
    if (!ctx) return;
    void ctx.resume().catch(() => {});

    const startAt = ctx.currentTime + 0.005; // tiny safety lead-in
    let cursorMs = 0;

    // Each note → three OscillatorNodes (partials) summed into a
    // shared GainNode that runs the envelope.
    const partials: Array<{ ratio: number; gain: number }> = [
      { ratio: 1.0, gain: 1.0 },
      { ratio: 2.76, gain: 0.5 },
      { ratio: 5.4, gain: 0.25 },
    ];

    for (const note of recipe.notes) {
      cursorMs += note.offsetMs;
      const noteStart = startAt + cursorMs / 1000;
      const decayS = note.decayMs / 1000;
      // Velocity × cue peak × per-partial gain → final peak before
      // the gain envelope. Tau = decay/5 so the tail is essentially
      // silent after `decayMs`.
      const tau = Math.max(decayS / 5, 0.001);

      const env = ctx.createGain();
      env.gain.value = 0;
      env.connect(ctx.destination);

      const peakGain = note.velocity * recipe.peak;
      // Raised-cosine attack: ramp 0 → peak over 4 ms.
      env.gain.setValueAtTime(0, noteStart);
      env.gain.linearRampToValueAtTime(peakGain, noteStart + 0.004);
      // Exponential decay. setTargetAtTime gives us a true RC fall —
      // sounds more natural than a linear ramp for percussive cues.
      env.gain.setTargetAtTime(0, noteStart + 0.004, tau);

      const stopAt = noteStart + decayS + 0.05;

      for (const p of partials) {
        const osc = ctx.createOscillator();
        osc.type = "sine";
        osc.frequency.value = note.freq * p.ratio;
        const partialGain = ctx.createGain();
        partialGain.gain.value = p.gain;
        osc.connect(partialGain).connect(env);
        osc.start(noteStart);
        osc.stop(stopAt);
        // Disconnect on natural end so we don't stack idle nodes.
        osc.onended = () => {
          try {
            osc.disconnect();
            partialGain.disconnect();
          } catch {
            /* already detached */
          }
        };
      }

      // The shared envelope outlives every partial that fed into it;
      // disconnect once the last partial is done.
      window.setTimeout(
        () => {
          try {
            env.disconnect();
          } catch {
            /* already detached */
          }
        },
        Math.ceil((stopAt - ctx.currentTime + 0.05) * 1000),
      );
    }
  }, [ensureCtx, recipe]);
}
