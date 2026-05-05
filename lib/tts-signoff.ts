"use client";

import { useEffect, useState } from "react";

const KEY = "tts-signoff-word";
const DEFAULT = "";
const EVT = "tts-signoff-change";

export function readSignoffWord(): string {
  if (typeof window === "undefined") return DEFAULT;
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
