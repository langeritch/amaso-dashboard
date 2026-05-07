"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";

// 60-day commitment: every shippable thing ships or gets killed by
// midnight at the start of July 6, 2026 (Europe/Amsterdam). Target
// stamped at module load — counting against a fixed Date avoids drift
// across timezones / DST and keeps the banner SSR-safe (the server
// computes the same target the client does).
const DEADLINE = new Date(2026, 6, 6, 0, 0, 0, 0); // July 6, 2026, 00:00 local

interface Remaining {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  millis: number;
  reached: boolean;
}

function computeRemaining(now: number): Remaining {
  const diff = DEADLINE.getTime() - now;
  if (diff <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, millis: 0, reached: true };
  }
  const days = Math.floor(diff / 86_400_000);
  const hours = Math.floor((diff % 86_400_000) / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1_000);
  const millis = diff % 1_000;
  return { days, hours, minutes, seconds, millis, reached: false };
}

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}

/**
 * Top-of-page commitment banner. Two display modes:
 *   - inline: one-line strip pinned above the Topbar on every page
 *     (admins + team only — gated in app/layout.tsx). Shows the full
 *     d/h/m/s/ms breakdown so every glance reminds the team that a
 *     real clock is running.
 *   - fullscreen: a viewport-filling overlay for the office display
 *     monitor. Fires the browser's Fullscreen API on enter so screens
 *     wedged behind reception don't show browser chrome. ESC, the X
 *     button, or the button on the inline bar all exit.
 *
 * Tick rate: requestAnimationFrame, so the millisecond column actually
 * looks alive. The whole component is <300 nodes; rAF re-renders at
 * 60 fps are cheap and stop entirely when the tab backgrounds (rAF
 * pauses by spec).
 *
 * SSR safety: useState initialiser runs in server context too, so we
 * seed `now` from a static value and let the first useEffect tick
 * fill in real time on the client. Avoids hydration mismatches across
 * the second / millisecond boundary.
 */
export default function CountdownBanner() {
  // Static initial value (Date.now() at module load on the server,
  // refreshed on first rAF on the client). The diff between server
  // render and client first paint is at most a few hundred ms — the
  // hydration warning would have fired on the seconds column without
  // this seeding trick. We render placeholder dashes until the first
  // client tick lands so the SSR HTML and the post-hydration HTML
  // match exactly.
  const [now, setNow] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);

  // rAF loop: schedules itself recursively so the millisecond column
  // updates on every frame the browser paints. rAF auto-pauses when
  // the tab is hidden, so we don't burn CPU off-screen.
  useEffect(() => {
    const tick = () => {
      setNow(Date.now());
      rafRef.current = window.requestAnimationFrame(tick);
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const enterFullscreen = useCallback(() => {
    setFullscreen(true);
    // Best-effort: ask the browser to also drop chrome. Some browsers
    // reject the call when it isn't tied directly to a user gesture
    // (rare in practice — this is in the click handler, so it's fine
    // — but the catch keeps a refusal silent so we still show the CSS
    // overlay). The overlay element isn't mounted yet on the first
    // render after setFullscreen(true), so defer to the next paint.
    requestAnimationFrame(() => {
      const el = overlayRef.current;
      if (el && el.requestFullscreen) {
        el.requestFullscreen().catch(() => {
          /* silent — CSS overlay still covers the viewport */
        });
      }
    });
  }, []);

  const exitFullscreen = useCallback(() => {
    setFullscreen(false);
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {
        /* silent */
      });
    }
  }, []);

  // ESC closes fullscreen + sync state if the user uses the browser
  // chrome / F11 to leave fullscreen.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitFullscreen();
    };
    const onChange = () => {
      if (!document.fullscreenElement) setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("fullscreenchange", onChange);
    };
  }, [fullscreen, exitFullscreen]);

  const remaining = now == null ? null : computeRemaining(now);

  return (
    <>
      {/* Inline strip — always rendered. The fullscreen overlay
          renders ON TOP when active; the strip stays in the DOM so
          collapsing fullscreen returns to a known layout. */}
      <div
        role="status"
        aria-live="polite"
        className="border-b border-orange-500/40 bg-gradient-to-r from-neutral-950 via-orange-950/40 to-neutral-950"
      >
        <div className="mx-auto flex max-w-6xl items-center justify-center gap-2 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] sm:text-xs">
          {remaining === null ? (
            <span className="text-neutral-500">Loading countdown…</span>
          ) : remaining.reached ? (
            <>
              <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.9)]" />
              <span className="text-red-300">Deadline reached</span>
              <span className="hidden text-neutral-500 sm:inline">·</span>
              <span className="hidden text-neutral-400 sm:inline">
                July 6, 2026
              </span>
            </>
          ) : (
            <>
              <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-orange-400 shadow-[0_0_6px_rgba(251,146,60,0.9)]" />
              {/* font-mono + tabular-nums + zero-padded values keeps
                  every digit position visually fixed as the ms column
                  ticks. Without this the d/h/m/s segments shimmy left
                  and right whenever a value flips between 1 and 2
                  digits. */}
              <span className="flex items-baseline gap-0.5 font-mono tabular-nums text-orange-200">
                <span className="text-orange-100">
                  {pad(remaining.days, 2)}
                </span>
                <span className="text-orange-300/70">d</span>
                <span className="ml-1.5 text-orange-100">
                  {pad(remaining.hours, 2)}
                </span>
                <span className="text-orange-300/70">h</span>
                <span className="ml-1.5 text-orange-100">
                  {pad(remaining.minutes, 2)}
                </span>
                <span className="text-orange-300/70">m</span>
                <span className="ml-1.5 text-orange-100">
                  {pad(remaining.seconds, 2)}
                </span>
                <span className="text-orange-300/70">s</span>
                <span className="ml-1.5 text-orange-200/80">
                  {pad(remaining.millis, 3)}
                </span>
                <span className="text-orange-300/70">ms</span>
              </span>
              <span className="text-neutral-400">until launch</span>
              <span className="hidden text-neutral-600 sm:inline">·</span>
              <span className="hidden text-neutral-500 sm:inline">
                July 6, 2026
              </span>
            </>
          )}
          <button
            type="button"
            onClick={enterFullscreen}
            aria-label="open countdown fullscreen"
            title="Fullscreen"
            className="amaso-fx ml-2 inline-flex h-5 w-5 items-center justify-center rounded text-orange-300/60 hover:bg-orange-500/10 hover:text-orange-200"
          >
            <Maximize2 className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Fullscreen overlay — covers the viewport when active. Even if
          the browser refuses requestFullscreen() (rare), the fixed
          inset-0 + max z-index makes this a hard takeover that hides
          everything underneath. */}
      {fullscreen && (
        <div
          ref={overlayRef}
          role="dialog"
          aria-label="60-day countdown fullscreen"
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-neutral-950 text-neutral-100"
        >
          {/* Backdrop accents — subtle radial glow so the overlay
              doesn't feel like a flat black slab on huge displays. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,_rgba(251,146,60,0.10)_0%,_rgba(10,10,12,1)_70%)]"
          />
          <button
            type="button"
            onClick={exitFullscreen}
            aria-label="exit countdown fullscreen"
            title="Exit fullscreen (Esc)"
            className="amaso-fx absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900/80 text-neutral-400 hover:border-neutral-700 hover:text-neutral-100"
          >
            <Minimize2 className="h-4 w-4" />
          </button>

          {remaining === null ? null : remaining.reached ? (
            <FullscreenReached />
          ) : (
            <FullscreenCountdown remaining={remaining} />
          )}
        </div>
      )}
    </>
  );
}

function FullscreenCountdown({ remaining }: { remaining: Remaining }) {
  return (
    <div className="relative flex flex-col items-center gap-8 px-6 text-center">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.4em] text-orange-300/80 sm:text-xs">
        <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-orange-400 shadow-[0_0_8px_rgba(251,146,60,0.95)]" />
        <span>60-day commitment · July 6, 2026</span>
      </div>

      {/* font-mono + tabular-nums on the grid cascades to every Cell;
          combined with zero-padded values it locks each digit slot to
          the same width so the ms column flipping 60 times a second
          can't shake the d/h/m/s columns sideways. */}
      <div className="grid grid-cols-5 gap-3 font-mono tabular-nums sm:gap-6 md:gap-10">
        <Cell value={pad(remaining.days, 2)} label="days" />
        <Cell value={pad(remaining.hours, 2)} label="hours" />
        <Cell value={pad(remaining.minutes, 2)} label="min" />
        <Cell value={pad(remaining.seconds, 2)} label="sec" />
        <Cell value={pad(remaining.millis, 3)} label="ms" dim />
      </div>

      <div className="text-sm font-medium uppercase tracking-[0.3em] text-neutral-500 sm:text-base">
        ships or gets killed.
      </div>
    </div>
  );
}

function FullscreenReached() {
  return (
    <div className="relative flex flex-col items-center gap-6 text-center">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.4em] text-red-300/80">
        <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.95)]" />
        <span>July 6, 2026</span>
      </div>
      <div className="text-6xl font-black uppercase tracking-tight text-red-300 sm:text-8xl md:text-[10rem]">
        Deadline reached
      </div>
      <div className="text-sm font-medium uppercase tracking-[0.3em] text-neutral-500 sm:text-base">
        time's up.
      </div>
    </div>
  );
}

function Cell({
  value,
  label,
  dim,
}: {
  value: string;
  label: string;
  dim?: boolean;
}) {
  return (
    <div className="flex flex-col items-center">
      <div
        className={`font-black leading-none tracking-tight ${
          dim ? "text-orange-200/70" : "text-orange-100"
        } text-5xl sm:text-7xl md:text-9xl`}
      >
        {value}
      </div>
      <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.3em] text-orange-300/70 sm:mt-3 sm:text-xs">
        {label}
      </div>
    </div>
  );
}
