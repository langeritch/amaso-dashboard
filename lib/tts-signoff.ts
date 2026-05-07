"use client";

import { useEffect, useState } from "react";

// localStorage key. Renamed from "tts-signoff-word" to "tts-end-phrase"
// when the input moved from the global footer chip onto the spar page's
// audio controls. The migration block below copies a stale value from
// the legacy key one time so existing settings carry over silently.
const KEY = "tts-end-phrase";
const LEGACY_KEY = "tts-signoff-word";
const DEFAULT = "";
const EVT = "tts-end-phrase-change";

function migrateLegacy(): void {
  if (typeof window === "undefined") return;
  try {
    const current = window.localStorage.getItem(KEY);
    if (current !== null) return;
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy === null) return;
    window.localStorage.setItem(KEY, legacy);
    window.localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* localStorage may be disabled — non-fatal */
  }
}

export function readSignoffWord(): string {
  if (typeof window === "undefined") return DEFAULT;
  migrateLegacy();
  const v = window.localStorage.getItem(KEY);
  return v === null ? DEFAULT : v;
}

export function writeSignoffWord(v: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, v);
  window.dispatchEvent(new CustomEvent(EVT, { detail: v }));
}

export function useSignoffWord(): [string, (v: string) => void] {
  const [val, setVal] = useState<string>(DEFAULT);
  useEffect(() => {
    setVal(readSignoffWord());
    const onChange = () => setVal(readSignoffWord());
    window.addEventListener(EVT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return [
    val,
    (v: string) => {
      writeSignoffWord(v);
      setVal(v);
    },
  ];
}
