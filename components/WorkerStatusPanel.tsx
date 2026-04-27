"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

/**
 * Mission-control style live panel for the sparring page. Polls
 * `/api/spar/worker-status` every few seconds and renders one row per
 * project the user can see — busy ones at the top with their state +
 * a short summary of the last terminal output, idle ones below as
 * "ready". The status hints come straight from the same heuristic
 * Spar uses when inspecting a worker so the UI never disagrees with
 * the agent.
 */

interface WorkerStatus {
  id: string;
  name: string;
  visibility: "team" | "client" | "public";
  running: boolean;
  startedAt: number | null;
  state: "thinking" | "permission_gate" | "at_prompt" | "unknown" | "idle";
  hint: string;
  lastLine: string;
}

const POLL_INTERVAL_MS = 3_000;

export default function WorkerStatusPanel() {
  const [workers, setWorkers] = useState<WorkerStatus[] | null>(null);
  // Default collapsed on mobile: the inline pill header stays in flow
  // (compact summary, harmless), but the full list would otherwise
  // grow down into the centered audio ring and obscure the listening
  // indicator, timer, and interim transcript. When expanded on mobile
  // the list opens as a left-side drawer (see below) so it never
  // overlaps the ring; on ≥md screens it expands inline as before.
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 767px)").matches;
  });

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch("/api/spar/worker-status", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { workers: WorkerStatus[] };
        if (!cancelled) setWorkers(body.workers);
      } catch {
        /* swallow — next tick will retry */
      }
    }
    void tick();
    const id = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const { busy, ready } = useMemo(() => {
    const list = workers ?? [];
    // Busy = running with an active state (thinking / permission_gate /
    // unknown). at_prompt counts as "ready and waiting" — the worker
    // is alive but not chewing on anything, which is functionally what
    // a free terminal looks like.
    const b: WorkerStatus[] = [];
    const r: WorkerStatus[] = [];
    for (const w of list) {
      if (w.running && (w.state === "thinking" || w.state === "permission_gate" || w.state === "unknown")) {
        b.push(w);
      } else {
        r.push(w);
      }
    }
    // Within busy: permission_gate first (needs a human), then
    // thinking, then unknown. Within ready: at_prompt first, then
    // idle (no PTY at all).
    const busyRank = (s: WorkerStatus["state"]) =>
      s === "permission_gate" ? 0 : s === "thinking" ? 1 : 2;
    b.sort((x, y) => busyRank(x.state) - busyRank(y.state));
    const readyRank = (w: WorkerStatus) =>
      w.state === "at_prompt" ? 0 : w.running ? 1 : 2;
    r.sort((x, y) => readyRank(x) - readyRank(y));
    return { busy: b, ready: r };
  }, [workers]);

  if (workers === null || workers.length === 0) return null;

  const busyCount = busy.length;
  const totalRunning = workers.filter((w) => w.running).length;

  return (
    <section className="relative z-30 max-w-sm px-4 py-2">
      <div className="rounded-lg border border-neutral-800 bg-neutral-950/70 backdrop-blur">
        <header className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-neutral-500">
            <span>Workers</span>
            <span className="text-neutral-600">·</span>
            <span className="font-mono normal-case tracking-normal text-neutral-400">
              {busyCount > 0 ? `${busyCount} busy` : "all clear"}
            </span>
            {totalRunning > 0 && (
              <>
                <span className="text-neutral-600">·</span>
                <span className="font-mono normal-case tracking-normal text-neutral-500">
                  {totalRunning}/{workers.length} terminals up
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="rounded px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500 transition hover:bg-neutral-800 hover:text-neutral-200"
            aria-expanded={!collapsed}
          >
            {collapsed ? "show" : "hide"}
          </button>
        </header>
        {!collapsed && (
          <ul className="max-h-[28vh] divide-y divide-neutral-800/70 overflow-y-auto border-t border-neutral-800/70 md:max-h-none md:overflow-visible">
            {busy.map((w) => (
              <WorkerRow key={w.id} w={w} />
            ))}
            {ready.map((w) => (
              <WorkerRow key={w.id} w={w} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function WorkerRow({ w }: { w: WorkerStatus }) {
  const visual = stateVisual(w);
  return (
    <li>
      <Link
        href={`/projects/${w.id}`}
        className="flex items-center gap-3 px-3 py-2 transition hover:bg-neutral-900/60"
      >
        <StatusDot tone={visual.tone} pulsing={visual.pulsing} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-neutral-200">
              {w.name}
            </span>
            <span className={`flex-shrink-0 text-[10px] uppercase tracking-wider ${visual.labelClass}`}>
              {visual.label}
            </span>
          </div>
          {w.lastLine ? (
            <p className="mt-0.5 truncate font-mono text-[11px] text-neutral-500">
              {w.lastLine}
            </p>
          ) : (
            <p className="mt-0.5 truncate text-[11px] italic text-neutral-600">
              {visual.idleHint}
            </p>
          )}
        </div>
      </Link>
    </li>
  );
}

interface Visual {
  tone: "amber" | "rose" | "emerald" | "neutral" | "sky";
  pulsing: boolean;
  label: string;
  labelClass: string;
  idleHint: string;
}

function stateVisual(w: WorkerStatus): Visual {
  if (w.state === "permission_gate") {
    return {
      tone: "rose",
      pulsing: true,
      label: "needs you",
      labelClass: "text-rose-300",
      idleHint: "Waiting on a permission prompt.",
    };
  }
  if (w.state === "thinking") {
    return {
      tone: "amber",
      pulsing: true,
      label: "working",
      labelClass: "text-amber-300",
      idleHint: "Thinking — no recent output yet.",
    };
  }
  if (w.state === "unknown" && w.running) {
    return {
      tone: "sky",
      pulsing: true,
      label: "running",
      labelClass: "text-sky-300",
      idleHint: "Terminal active — state unclear.",
    };
  }
  if (w.state === "at_prompt") {
    return {
      tone: "emerald",
      pulsing: false,
      label: "ready",
      labelClass: "text-emerald-400/80",
      idleHint: "Idle at prompt — ready for the next task.",
    };
  }
  // No PTY running.
  return {
    tone: "neutral",
    pulsing: false,
    label: "offline",
    labelClass: "text-neutral-500",
    idleHint: "No terminal running. Open the project to start one.",
  };
}

function StatusDot({
  tone,
  pulsing,
}: {
  tone: Visual["tone"];
  pulsing: boolean;
}) {
  // Centralised tone → color class so the dot always agrees with the
  // label tint next to it. neutral has no ping (offline shouldn't
  // pulse), the others use animate-ping when pulsing.
  const core =
    tone === "amber"
      ? "bg-amber-400"
      : tone === "rose"
        ? "bg-rose-400"
        : tone === "emerald"
          ? "bg-emerald-500"
          : tone === "sky"
            ? "bg-sky-400"
            : "bg-neutral-700";
  const halo =
    tone === "amber"
      ? "bg-amber-400/60"
      : tone === "rose"
        ? "bg-rose-400/60"
        : tone === "emerald"
          ? "bg-emerald-500/60"
          : tone === "sky"
            ? "bg-sky-400/60"
            : "bg-neutral-700/60";
  return (
    <span className="relative flex h-2 w-2 flex-shrink-0" aria-hidden>
      {pulsing && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full ${halo}`}
        />
      )}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${core}`} />
    </span>
  );
}
