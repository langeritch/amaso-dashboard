"use client";

// Tour runner for demo mode. Persists at the root layout level so the
// cursor / caption / interaction lock survive client-side route changes
// as the script walks the visitor from /login into the real dashboard.
//
// Lifecycle:
//   1. Mount → show intro card ("Start tour").
//   2. User clicks Start → audio.play() (required for autoplay), start
//      the rAF clock, run the script.
//   3. Each rAF tick: find the latest step whose `atMs` ≤ elapsed; for
//      every step we haven't yet fired, apply its effects (update
//      caption, set cursor target, dispatch the one-shot action).
//   4. When elapsed ≥ DEMO_TOUR_DURATION_MS → show replay card.
//
// Effects applied per step:
//   - caption          → replace the bottom caption text
//   - cursor {x,y}     → set cursor target to (x%, y%) of viewport
//   - cursor {selector}→ querySelector, aim at element's bounding center
//   - action "type"    → character-by-character write into selector using
//                        the React native-value-setter trick so the
//                        controlled input's onChange fires
//   - action "click"   → increment clickTick (visual pulse only)
//   - action "navigate"→ router.push(path); keeps demo overlay mounted
//
// Interaction lock:
//   A full-viewport div with pointer-events: auto above all app content
//   (z 9999, below the cursor at z 10000) swallows pointer + wheel +
//   touch. A capturing keydown listener blocks typing.
//
// Audio:
//   Plays <audio src={DEMO_AUDIO_SRC}>. Autoplay failures and missing
//   files are caught and surface the muted badge; the tour still runs
//   off its own clock.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Play, RotateCcw, VolumeX } from "lucide-react";
import {
  DEMO_AUDIO_SRC,
  DEMO_TOUR,
  DEMO_TOUR_DURATION_MS,
  type CursorTarget,
  type DemoStep,
} from "@/lib/demo/script";
import DemoCursor from "./DemoCursor";

type RunState =
  | { kind: "intro" }
  | { kind: "running"; startedAt: number }
  | { kind: "done" };

interface CursorPos {
  x: number;
  y: number;
}

function viewportPctToPx(x: number, y: number): CursorPos {
  const w = typeof window !== "undefined" ? window.innerWidth : 1280;
  const h = typeof window !== "undefined" ? window.innerHeight : 720;
  return { x: (x / 100) * w, y: (y / 100) * h };
}

function resolveCursor(target: CursorTarget): CursorPos | null {
  if ("x" in target) return viewportPctToPx(target.x, target.y);
  const el = document.querySelector<HTMLElement>(target.selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const dx = target.offset?.dx ?? 0;
  const dy = target.offset?.dy ?? 0;
  return { x: r.left + r.width / 2 + dx, y: r.top + r.height / 2 + dy };
}

/** React-compatible way to write a value to a controlled input. The
 *  native value-setter bypasses React's synthetic bookkeeping, and then
 *  dispatching a bubbling `input` event wakes React up to read it. */
function setNativeInputValue(el: HTMLInputElement, value: string) {
  const desc = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  );
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export default function DemoTour() {
  const router = useRouter();
  const [state, setState] = useState<RunState>({ kind: "intro" });
  const [cursor, setCursor] = useState<CursorPos>({ x: 0, y: 0 });
  const [caption, setCaption] = useState<string>("");
  const [clickTick, setClickTick] = useState(0);
  const [audioBlocked, setAudioBlocked] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const firedStepsRef = useRef<Set<number>>(new Set());
  const typingTimersRef = useRef<number[]>([]);
  const cursorRef = useRef<CursorPos>({ x: 0, y: 0 });

  // Keep a ref in sync with cursor state so selector-resolution failures
  // (element not in DOM) can leave the cursor parked where it was.
  useEffect(() => {
    cursorRef.current = cursor;
  }, [cursor]);

  // Initial cursor position: center of viewport, once we're in the browser.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setCursor({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  }, []);

  // ── Swallow user keyboard input during the tour ─────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const allowed = new Set(["F5", "F12"]);
      if (allowed.has(e.key)) return;
      if (e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // ── Apply a step's effects once when it fires ───────────────────────
  const applyStep = useCallback(
    (step: DemoStep) => {
      if (step.caption !== undefined) setCaption(step.caption);

      if (step.cursor) {
        const pos = resolveCursor(step.cursor);
        if (pos) setCursor(pos);
      }

      if (step.action) {
        const { action } = step;
        if (action.kind === "click") {
          setClickTick((t) => t + 1);
        } else if (action.kind === "navigate") {
          router.push(action.path);
        } else if (action.kind === "type") {
          const el = document.querySelector<HTMLInputElement>(action.selector);
          if (el) {
            el.focus();
            const per = action.perCharMs ?? 70;
            let typed = "";
            for (let i = 0; i < action.text.length; i++) {
              const ch = action.text[i];
              const t = window.setTimeout(() => {
                typed += ch;
                setNativeInputValue(el, typed);
              }, per * (i + 1));
              typingTimersRef.current.push(t);
            }
          }
        }
      }
    },
    [router],
  );

  // ── Main tour clock ─────────────────────────────────────────────────
  useEffect(() => {
    if (state.kind !== "running") return;
    const { startedAt } = state;

    const tick = () => {
      const elapsed = performance.now() - startedAt;

      // Also re-resolve the currently-targeted step's cursor each frame
      // when it's a selector — the page may still be loading / layout
      // may shift — but cheap: only when the step has a selector.
      for (let i = 0; i < DEMO_TOUR.length; i++) {
        const step = DEMO_TOUR[i];
        if (step.atMs > elapsed) break;
        if (!firedStepsRef.current.has(i)) {
          firedStepsRef.current.add(i);
          applyStep(step);
        }
      }

      if (elapsed >= DEMO_TOUR_DURATION_MS) {
        setState({ kind: "done" });
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [state, applyStep]);

  // ── Re-resolve cursor selectors on route change ─────────────────────
  //
  // When the script fires `navigate`, the new page doesn't mount
  // instantly — so any selector-based cursor target set on the same tick
  // may miss. We nudge the latest-fired selector-target to re-resolve a
  // few times over the first ~500ms after a navigation.
  useEffect(() => {
    if (state.kind !== "running") return;
    const id = window.setInterval(() => {
      // Find the latest fired step with a selector-cursor.
      let latestSelectorStep: DemoStep | null = null;
      for (const idx of firedStepsRef.current) {
        const s = DEMO_TOUR[idx];
        if (s.cursor && "selector" in s.cursor) {
          if (!latestSelectorStep || s.atMs > latestSelectorStep.atMs) {
            latestSelectorStep = s;
          }
        }
      }
      if (latestSelectorStep && latestSelectorStep.cursor) {
        const pos = resolveCursor(latestSelectorStep.cursor);
        if (pos) setCursor(pos);
      }
    }, 120);
    return () => window.clearInterval(id);
  }, [state]);

  // ── Start / replay ─────────────────────────────────────────────────
  const start = useCallback(() => {
    firedStepsRef.current = new Set();
    typingTimersRef.current.forEach((t) => clearTimeout(t));
    typingTimersRef.current = [];
    setCaption("");
    setAudioBlocked(false);

    const el = audioRef.current;
    if (el) {
      try {
        el.currentTime = 0;
        const promise = el.play();
        if (promise && typeof promise.catch === "function") {
          promise.catch(() => setAudioBlocked(true));
        }
      } catch {
        setAudioBlocked(true);
      }
    }

    setState({ kind: "running", startedAt: performance.now() });
  }, []);

  const replay = useCallback(() => {
    // After a tour, we've navigated away from /login. Put visitors back
    // at the same start state (login screen) so the whole journey replays.
    router.push("/login");
    start();
  }, [router, start]);

  return (
    <>
      {/* Interaction lock: absorbs every pointer/touch/wheel while the
          tour is running. Rendered above real content (z 9999), below
          the cursor (z 10000). Omitted during intro/done so those cards
          are clickable. */}
      {state.kind === "running" && (
        <div
          aria-hidden
          className="fixed inset-0 z-[9999] cursor-none"
          onClickCapture={stopAll}
          onPointerDownCapture={stopAll}
          onPointerUpCapture={stopAll}
          onWheelCapture={stopAll}
          onTouchStartCapture={stopAll}
          onContextMenuCapture={stopAll}
        />
      )}

      {state.kind === "running" && (
        <>
          <DemoCursor x={cursor.x} y={cursor.y} clickTick={clickTick} />
          {caption && <Caption text={caption} />}
          {audioBlocked && <MutedBadge />}
        </>
      )}

      {state.kind === "intro" && <IntroOverlay onStart={start} />}
      {state.kind === "done" && <DoneOverlay onReplay={replay} />}

      <audio
        ref={audioRef}
        src={DEMO_AUDIO_SRC}
        preload="auto"
        onError={() => setAudioBlocked(true)}
      />
    </>
  );
}

function stopAll(e: React.SyntheticEvent) {
  e.preventDefault();
  e.stopPropagation();
}

function Caption({ text }: { text: string }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-10 z-[10001] flex justify-center px-6"
    >
      <div
        key={text}
        className="max-w-2xl rounded-full border border-white/10 bg-black/75 px-5 py-3 text-center text-sm font-medium text-white shadow-2xl backdrop-blur"
        style={{ animation: "demo-caption-in 380ms ease-out both" }}
      >
        {text}
      </div>
      <style>{`
        @keyframes demo-caption-in {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

function MutedBadge() {
  return (
    <div className="pointer-events-none fixed right-4 top-16 z-[10001] flex items-center gap-1.5 rounded-full bg-black/75 px-3 py-1.5 text-[11px] text-neutral-300 backdrop-blur">
      <VolumeX className="h-3.5 w-3.5" />
      Audio unavailable
    </div>
  );
}

function IntroOverlay({ onStart }: { onStart: () => void }) {
  return (
    <div className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/85 backdrop-blur">
      <div className="mx-4 max-w-md rounded-2xl border border-white/10 bg-neutral-950 p-8 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-white/10">
          <Play className="h-5 w-5" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">
          Amaso — live product tour
        </h2>
        <p className="mt-2 text-sm text-neutral-400">
          A ~30-second walkthrough of the client portal, from sign-in to
          project workspace. Sit back — this one drives itself.
        </p>
        <button
          type="button"
          onClick={onStart}
          className="mt-6 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-black transition hover:bg-neutral-200"
        >
          <Play className="h-4 w-4" />
          Start tour
        </button>
        <p className="mt-3 text-[11px] text-neutral-500">
          Audio plays with narration. No real login required.
        </p>
      </div>
    </div>
  );
}

function DoneOverlay({ onReplay }: { onReplay: () => void }) {
  return (
    <div className="fixed inset-0 z-[10002] flex items-center justify-center bg-black/85 backdrop-blur">
      <div className="mx-4 max-w-md rounded-2xl border border-white/10 bg-neutral-950 p-8 text-center shadow-2xl">
        <h2 className="text-xl font-semibold tracking-tight">
          Thanks for watching.
        </h2>
        <p className="mt-2 text-sm text-neutral-400">
          Want this for your agency? Let&apos;s talk.
        </p>
        <button
          type="button"
          onClick={onReplay}
          className="mt-6 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-black transition hover:bg-neutral-200"
        >
          <RotateCcw className="h-4 w-4" />
          Replay tour
        </button>
      </div>
    </div>
  );
}
