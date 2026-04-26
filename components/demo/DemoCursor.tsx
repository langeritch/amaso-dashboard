"use client";

// A fake cursor that glides between scripted positions. Positions are
// absolute pixels from the top-left of the viewport — the tour runner
// converts viewport-percentage targets and querySelector hits into
// pixels before handing them off.
//
// The click pulse is a ring that briefly expands and fades whenever
// `clickTick` increments. Purely decorative.

import { useEffect, useRef, useState } from "react";

interface Props {
  /** Absolute viewport-px position. */
  x: number;
  y: number;
  /** Increment to fire a click pulse at the current position. */
  clickTick: number;
}

export default function DemoCursor({ x, y, clickTick }: Props) {
  const [pulseKey, setPulseKey] = useState(0);
  const lastTick = useRef(0);

  useEffect(() => {
    if (clickTick === lastTick.current) return;
    lastTick.current = clickTick;
    setPulseKey((k) => k + 1);
  }, [clickTick]);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[10000]">
      <div
        className="absolute transition-[left,top] duration-[1200ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ left: `${x}px`, top: `${y}px` }}
      >
        {pulseKey > 0 && (
          <span
            key={pulseKey}
            className="absolute left-1 top-1 h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/80"
            style={{ animation: "demo-cursor-pulse 700ms ease-out forwards" }}
          />
        )}
        <svg
          width="22"
          height="22"
          viewBox="0 0 22 22"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.55))" }}
        >
          <path
            d="M2 1.5L2 16.5L6.2 12.3L9 18.5L11.5 17.3L8.7 11.2L14.5 11.2L2 1.5Z"
            fill="white"
            stroke="black"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <style>{`
        @keyframes demo-cursor-pulse {
          0%   { transform: translate(-50%, -50%) scale(0.4); opacity: 0.95; }
          100% { transform: translate(-50%, -50%) scale(2.8); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
