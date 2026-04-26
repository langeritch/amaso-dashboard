"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Preloads a WAV chime and returns a debounced play function.
 *
 * Used to surface state-transition cues in the browser voice UI —
 * currently the "mic is open" chime that mirrors the one the Python
 * telegram-voice service plays into Telegram calls. Both sides pull
 * from the same WAV in `telegram-voice/sounds/` so the cue sounds
 * identical whether the user is on the laptop or the phone.
 *
 * Design notes:
 *   - We use `<audio>` rather than Web Audio because chimes are short
 *     pre-rendered WAVs; the decoding cost is negligible and we get
 *     browser-managed playback state for free.
 *   - A 250 ms re-trigger cooldown stops rapid-fire callers from
 *     stacking the chime on itself (looks like a bug to the user).
 *   - Volume is capped at 0.6 to sit under TTS playback rather than
 *     competing with it — same reasoning as useThinkingHum's gain cap.
 *   - If the WAV doesn't exist (e.g. telegram-voice has never run on
 *     this box so Python never baked the file), `load()` errors and
 *     `play()` becomes a no-op. Missing chime = papercut; we don't
 *     want a hard failure in the voice flow over it.
 */

const COOLDOWN_MS = 250;
const MAX_VOLUME = 0.6;

export function useChime(url: string): () => void {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const loadedRef = useRef(false);
  const lastPlayedAtRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = new Audio(url);
    el.preload = "auto";
    el.volume = MAX_VOLUME;
    // `canplaythrough` fires once the browser believes it can play
    // the whole clip without buffering — a good proxy for "chime
    // is ready to fire on demand without the user hearing stutter".
    const onReady = () => {
      loadedRef.current = true;
    };
    el.addEventListener("canplaythrough", onReady, { once: true });
    audioRef.current = el;
    return () => {
      el.removeEventListener("canplaythrough", onReady);
      try {
        el.pause();
      } catch {
        /* ignore */
      }
      audioRef.current = null;
      loadedRef.current = false;
    };
  }, [url]);

  return useCallback(() => {
    const el = audioRef.current;
    if (!el || !loadedRef.current) return;
    const now = Date.now();
    if (now - lastPlayedAtRef.current < COOLDOWN_MS) return;
    lastPlayedAtRef.current = now;
    try {
      el.currentTime = 0;
    } catch {
      /* some browsers throw if not fully loaded — safe to ignore */
    }
    // `play()` returns a promise; rejected promises are a common
    // false-alarm (autoplay policy, interruption from a newer play).
    // Swallow them — the next tick will try again.
    el.play().catch(() => {});
  }, []);
}
