"use client";

import { useEffect, useState } from "react";

const HOLD_MS = 1750;
const FADE_MS = 480;

export default function SplashScreen() {
  const [phase, setPhase] = useState<"show" | "fade" | "done">("show");

  useEffect(() => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      setPhase("done");
      return;
    }
    const t1 = window.setTimeout(() => setPhase("fade"), HOLD_MS);
    const t2 = window.setTimeout(() => setPhase("done"), HOLD_MS + FADE_MS);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);

  if (phase === "done") return null;

  const word = ["A", "M", "A", "S", "O"];

  return (
    <div
      className={`amaso-splash${phase === "fade" ? " amaso-splash--out" : ""}`}
      aria-hidden="true"
    >
      <div className="amaso-splash__glow" />
      <div className="amaso-splash__ring amaso-splash__ring--1" />
      <div className="amaso-splash__ring amaso-splash__ring--2" />
      <div className="amaso-splash__ring amaso-splash__ring--3" />

      <div className="amaso-splash__stage">
        <div className="amaso-splash__logo">
          <svg viewBox="0 0 512 512" aria-hidden="true">
            <defs>
              <linearGradient id="amaso-splash-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#34d399" />
                <stop offset="100%" stopColor="#059669" />
              </linearGradient>
            </defs>
            <path
              className="amaso-splash__a"
              d="M256 104 L408 400 H352 L320 336 H192 L160 400 H104 Z M218 288 H294 L256 212 Z"
              fill="url(#amaso-splash-grad)"
            />
            <circle
              className="amaso-splash__dot"
              cx="256"
              cy="440"
              r="14"
              fill="#10b981"
            />
          </svg>
          <div className="amaso-splash__shine" />
        </div>

        <div className="amaso-splash__word">
          {word.map((c, i) => (
            <span
              key={i}
              style={{ "--i": i } as React.CSSProperties}
            >
              {c}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
