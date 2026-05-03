"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, Info, Plus, X } from "lucide-react";

/**
 * Mission-control style live panel for the sparring page. Polls
 * `/api/spar/worker-status` every few seconds and renders one row per
 * project the user can see — busy ones at the top with their state +
 * a short summary of the last terminal output, idle ones below as
 * "ready". The status hints come straight from the same heuristic
 * Spar uses when inspecting a worker so the UI never disagrees with
 * the agent.
 *
 * The component splits into two: this default export keeps its old
 * card chrome (header + collapse toggle) so anywhere that still
 * imports it as a standalone widget keeps working, while the named
 * `WorkerList` export renders just the rows so callers like the spar
 * sidebar can wrap them in their own chrome without fighting the
 * card's internal collapse state.
 */

interface WorkerStatus {
  /** `<projectId>:<sessionId>` — stable React key, distinct per
   *  session even when the same project hosts several. */
  id: string;
  /** Owning project. Used for /projects/<id> nav and for grouping
   *  rows under one project header. Optional for the same
   *  forward-/backward-compat reason as the hover-card extras. */
  projectId?: string;
  /** Specific session this row reflects. Equals projectId for the
   *  legacy single-session case. */
  sessionId?: string;
  /** 1-based ordinal among the project's live sessions. 0 when no
   *  PTY is running for this project (synthetic row). */
  sessionOrdinal?: number;
  /** Total live sessions for this project. >= 2 enables the "#N"
   *  label suffix and the per-row kill button. */
  projectSessionCount?: number;
  name: string;
  visibility: "team" | "client" | "public";
  running: boolean;
  startedAt: number | null;
  state:
    | "thinking"
    | "permission_gate"
    | "at_prompt"
    | "awaiting_input"
    | "unknown"
    | "idle";
  hint: string;
  lastLine: string;
  // Hover-card extras — see app/api/spar/worker-status/route.ts. Older
  // server builds may not return these; we treat them as optional and
  // fall back at render time so the panel never blanks if a deploy
  // ships out of order.
  lastPrompt?: string;
  lastOutputSummary?: string;
  promptCount?: number;
}

const POLL_INTERVAL_MS = 1_000;

// A worker is only *actively* working when the visible status row
// carries the live "<verb>ING… (timer · …)" shape Claude Code paints
// during a turn: present-progressive verb, ellipsis, parenthesised
// timer. Completion rows are past-tense + " for Ns" ("Brewed for
// 2m 20s", "Cogitated for 12s"). The completion check wins outright
// — even if the same line drags a parenthesised footer that would
// otherwise look "active", a past-tense " for Ns" means the turn
// is over.
const ACTIVE_STATUS_RX =
  /\b[A-Za-z]+ing\b[^\n]*?(?:…|\.\.\.)\s*\(\s*(?:[^()]*?\s)?(?:\d+\s*m\s+)?\d+\s*s\b/i;
const COMPLETION_RX =
  /\b[A-Za-z]+(?:ed|t)\b\s+for\s+(?:\d+\s*m\s+)?\d+\s*s\b/i;

function isActivelyWorking(w: WorkerStatus): boolean {
  if (!w.running) return false;
  // Completion line beats any active match: a past-tense "Brewed for
  // 5s" overrides whatever `…(` residue is also visible in the tail.
  if (COMPLETION_RX.test(w.lastLine)) return false;
  return ACTIVE_STATUS_RX.test(w.lastLine);
}

function useWorkerStatusPoll() {
  const [workers, setWorkers] = useState<WorkerStatus[] | null>(null);
  // refresh() is exposed alongside the poll so spawn / kill actions
  // can request an immediate re-fetch instead of waiting up to one
  // second for the next tick. Plain ref + bumping a token state lets
  // both the interval and the imperative path share one fetcher.
  const refreshTokenRef = useRef(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => {
    refreshTokenRef.current += 1;
    setRefreshToken(refreshTokenRef.current);
  }, []);
  useEffect(() => {
    let cancelled = false;
    // Stable signature of the (id, state) pairs so we only log when the
    // server's view actually changes. Without this the console fills with
    // a line per poll. Diagnostic for the "panel doesn't refresh on
    // state transitions" investigation — confirms the API is returning
    // updated data and React is receiving it. Cheap to leave on.
    let prevSig = "";
    async function tick() {
      try {
        const res = await fetch("/api/spar/worker-status", {
          cache: "no-store",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { workers: WorkerStatus[] };
        if (cancelled) return;
        const sig = body.workers.map((w) => `${w.id}:${w.state}`).join("|");
        if (sig !== prevSig) {
          prevSig = sig;
          console.log(
            "[WorkerStatusPanel] state changed:",
            body.workers.map((w) => ({ id: w.id, state: w.state })),
          );
        }
        setWorkers(body.workers);
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
  }, [refreshToken]);
  return { workers, refresh };
}

/** POST a spawn for `projectId`. Errors are swallowed (the next poll
 *  surfaces the new row anyway, or the user retries) — we just kick
 *  off the request and refresh on completion. */
async function spawnSession(projectId: string): Promise<void> {
  await fetch("/api/spar/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
    cache: "no-store",
  }).catch(() => {
    /* surfaced via the next poll; nothing to do here */
  });
}

async function killSession(
  projectId: string,
  sessionId: string,
): Promise<void> {
  await fetch(
    `/api/spar/sessions/${encodeURIComponent(sessionId)}?projectId=${encodeURIComponent(projectId)}`,
    { method: "DELETE", cache: "no-store" },
  ).catch(() => {
    /* same fallback as spawn */
  });
}

function partitionWorkers(workers: WorkerStatus[]) {
  // Busy = needs human attention (permission_gate, awaiting_input) OR
  // actively processing per the visible status row. Trusting the
  // `state` field alone marked workers "working" long after their
  // turn ended because the API's heuristic kept resolving stale tail
  // bytes as thinking — checking lastLine for the live "… (timer)"
  // shape is the source of truth.
  const b: WorkerStatus[] = [];
  const r: WorkerStatus[] = [];
  for (const w of workers) {
    const needsAttention =
      w.running &&
      (w.state === "permission_gate" || w.state === "awaiting_input");
    if (needsAttention || isActivelyWorking(w)) {
      b.push(w);
    } else {
      r.push(w);
    }
  }
  // Within busy: permission_gate first (needs human approval), then
  // awaiting_input (prompt sitting unsubmitted — one keypress away),
  // then actively-working. Within ready: running workers first, then
  // offline (no PTY at all).
  const busyRank = (w: WorkerStatus) =>
    w.state === "permission_gate"
      ? 0
      : w.state === "awaiting_input"
        ? 1
        : 2;
  b.sort((x, y) => busyRank(x) - busyRank(y));
  const readyRank = (w: WorkerStatus) => (w.running ? 0 : 1);
  r.sort((x, y) => readyRank(x) - readyRank(y));
  return { busy: b, ready: r };
}

/**
 * Headless, chrome-free worker list. Renders one row per session
 * straight from the worker-status API — no card, no collapse pill,
 * no max-width. The spar sidebar uses this so its own collapse
 * header is the single source of truth and every project row stays
 * visible (the legacy default-collapsed pill was hiding all 13
 * projects when nested inside the sidebar).
 */
export function WorkerList() {
  const { workers, refresh } = useWorkerStatusPoll();
  const { busy, ready } = useMemo(
    () => partitionWorkers(workers ?? []),
    [workers],
  );
  if (workers === null) {
    // Skeleton rows so the panel doesn't blink to "Loading…" then to
    // a populated list — the shimmer reads as "data is on its way"
    // and matches the row height of the real workers below.
    return (
      <ul className="flex flex-col gap-px divide-y divide-neutral-800/70">
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            className="amaso-fade-in flex items-center gap-3 px-3 py-2.5"
          >
            <span className="amaso-skeleton h-2 w-2 flex-shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="amaso-skeleton h-3 w-1/2" />
              <div className="amaso-skeleton h-2.5 w-3/4" />
            </div>
          </li>
        ))}
      </ul>
    );
  }
  if (workers.length === 0) {
    return (
      <div className="px-3 py-2 text-[11px] italic text-neutral-600">
        No projects configured.
      </div>
    );
  }
  return (
    <ul className="divide-y divide-neutral-800/70">
      {busy.map((w) => (
        <WorkerRow key={w.id} w={w} onRefresh={refresh} />
      ))}
      {ready.map((w) => (
        <WorkerRow key={w.id} w={w} onRefresh={refresh} />
      ))}
    </ul>
  );
}

export default function WorkerStatusPanel() {
  const { workers, refresh } = useWorkerStatusPoll();
  // Default collapsed everywhere — the panel is overlaid on the chat
  // area so we want the smallest possible footprint by default. The
  // pill header still surfaces "X busy" so users know at a glance
  // whether anything needs attention; expanding shows the full list.
  const [collapsed, setCollapsed] = useState(true);

  const { busy, ready } = useMemo(
    () => partitionWorkers(workers ?? []),
    [workers],
  );

  if (workers === null || workers.length === 0) return null;

  const busyCount = busy.length;
  const totalRunning = workers.filter((w) => w.running).length;
  // Distinct projects with at least one running session — the "X/Y
  // terminals up" copy is per-project, not per-session, so a project
  // with three live sessions still contributes 1 to the numerator.
  const runningProjects = new Set(
    workers.filter((w) => w.running).map((w) => w.projectId ?? w.id),
  ).size;
  const totalProjects = new Set(
    workers.map((w) => w.projectId ?? w.id),
  ).size;
  // Multi-session badge for the collapsed header. When at least one
  // project has more than one live session we show the total count so
  // the operator notices parallel workers are alive without expanding.
  const multiSessionTotal = workers.filter(
    (w) => w.running && (w.projectSessionCount ?? 0) > 1,
  ).length;

  return (
    <section className="relative z-30 max-w-sm px-4 py-2">
      <div className="rounded-xl border border-neutral-800/80 bg-neutral-950/75 shadow-[0_4px_16px_rgba(0,0,0,0.3)] backdrop-blur-md backdrop-saturate-150">
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
                  {runningProjects}/{totalProjects} terminals up
                </span>
              </>
            )}
            {multiSessionTotal > 0 && (
              <>
                <span className="text-neutral-600">·</span>
                <span className="font-mono normal-case tracking-normal text-sky-400/80">
                  {totalRunning} sessions
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="amaso-fx rounded-md px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500 hover:bg-neutral-800/80 hover:text-neutral-100"
            aria-expanded={!collapsed}
          >
            {collapsed ? "show" : "hide"}
          </button>
        </header>
        {!collapsed && (
          <ul className="max-h-[28vh] divide-y divide-neutral-800/70 overflow-y-auto border-t border-neutral-800/70">
            {busy.map((w) => (
              <WorkerRow key={w.id} w={w} onRefresh={refresh} />
            ))}
            {ready.map((w) => (
              <WorkerRow key={w.id} w={w} onRefresh={refresh} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function WorkerRow({
  w,
  onRefresh,
}: {
  w: WorkerStatus;
  onRefresh: () => void;
}) {
  const visual = stateVisual(w);
  const projectId = w.projectId ?? w.id.split(":")[0];
  const sessionId = w.sessionId ?? projectId;
  const ordinal = w.sessionOrdinal ?? 0;
  const sessionCount = w.projectSessionCount ?? 0;
  // "#N" suffix only when the project actually has multiple live
  // sessions — solo sessions render exactly like the pre-Stage-2 row
  // so single-session UX is preserved bit-for-bit.
  const showLabel = sessionCount > 1 && ordinal > 0;
  // Spawn affordance shows on every project row regardless of count
  // (one click = a second worker), and the kill button shows only on
  // multi-session rows so the legacy "stop the project terminal"
  // path stays in the project page (avoids accidentally killing a
  // single-session project from the sidebar).
  const showKill = sessionCount > 1 && w.running;
  // Local pending flag so the user gets a visual "spawning…" beat
  // even if the next poll lands a frame later. Cleared either by the
  // refresh fetch resolving or the next worker-status snapshot
  // showing the new row.
  const [spawning, setSpawning] = useState(false);
  const [killing, setKilling] = useState(false);

  const handleSpawn = useCallback(async () => {
    if (spawning) return;
    setSpawning(true);
    try {
      await spawnSession(projectId);
    } finally {
      onRefresh();
      // Hold the pending state slightly so the new row has time to
      // surface — without this the "+" snaps back before the new row
      // appears and feels like nothing happened.
      window.setTimeout(() => setSpawning(false), 600);
    }
  }, [spawning, projectId, onRefresh]);

  const handleKill = useCallback(async () => {
    if (killing) return;
    setKilling(true);
    try {
      await killSession(projectId, sessionId);
    } finally {
      onRefresh();
      window.setTimeout(() => setKilling(false), 600);
    }
  }, [killing, projectId, sessionId, onRefresh]);
  // Single source of truth for "is the popover showing right now":
  //   - Desktop hover: mouseenter sets `hovering=true` after a small
  //     delay; mouseleave clears it after a longer delay so the user
  //     can move into the card without it snapping shut.
  //   - Mobile tap: clicking the info button toggles `pinned`, which
  //     wins over hover so a tap holds the card open until tapped
  //     again or the user clicks away.
  const [hovering, setHovering] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = pinned || hovering;
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLLIElement | null>(null);

  const cancelTimers = useCallback(() => {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  // Tap-outside dismissal so a pinned card on mobile doesn't get
  // stranded when the user moves on. Uses pointerdown so it fires
  // before any nav click drains the state.
  useEffect(() => {
    if (!pinned) return;
    function onPointerDown(e: PointerEvent) {
      const node = containerRef.current;
      if (node && e.target instanceof Node && node.contains(e.target)) return;
      setPinned(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pinned]);

  useEffect(() => () => cancelTimers(), [cancelTimers]);

  function handleEnter() {
    cancelTimers();
    openTimerRef.current = window.setTimeout(() => setHovering(true), 200);
  }
  function handleLeave() {
    cancelTimers();
    closeTimerRef.current = window.setTimeout(() => setHovering(false), 150);
  }

  const promptCount = w.promptCount ?? 0;
  const lastPrompt = (w.lastPrompt ?? "").trim();
  const lastOutput = (w.lastOutputSummary ?? w.lastLine ?? "").trim();

  return (
    <li
      ref={containerRef}
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div className="flex items-stretch">
        <Link
          href={`/projects/${projectId}${
            showLabel ? `?session=${encodeURIComponent(sessionId)}` : ""
          }`}
          className="amaso-fx amaso-press flex min-h-[52px] flex-1 items-center gap-3 px-3 py-2.5 hover:bg-neutral-900/70 active:bg-neutral-900/90 sm:min-h-0"
        >
          <StatusDot tone={visual.tone} pulsing={visual.pulsing} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="truncate text-sm font-medium text-neutral-200">
                {w.name}
                {showLabel && (
                  <span className="ml-1 text-[11px] font-normal text-neutral-500">
                    #{ordinal}
                  </span>
                )}
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
        {showKill && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void handleKill();
            }}
            disabled={killing}
            aria-label={`Stop session ${ordinal}`}
            title={`Stop session #${ordinal}`}
            className="amaso-fx amaso-press flex h-auto w-11 flex-shrink-0 items-center justify-center text-neutral-600 hover:bg-rose-900/40 hover:text-rose-300 active:bg-rose-900/60 disabled:opacity-40 sm:w-8"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void handleSpawn();
          }}
          disabled={spawning}
          aria-label={`Spawn another session for ${w.name}`}
          title="Spawn another session for this project"
          className="amaso-fx amaso-press flex h-auto w-11 flex-shrink-0 items-center justify-center text-neutral-600 hover:bg-orange-900/30 hover:text-orange-300 active:bg-orange-900/50 disabled:opacity-40 sm:w-8"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setPinned((p) => !p);
          }}
          aria-expanded={open}
          aria-label={open ? "Hide worker details" : "Show worker details"}
          title="Worker details"
          className={`amaso-fx amaso-press flex h-auto w-11 flex-shrink-0 items-center justify-center text-neutral-600 hover:bg-neutral-900/60 hover:text-neutral-300 active:bg-neutral-900/90 sm:w-8 ${
            pinned ? "bg-neutral-900/60 text-neutral-300" : ""
          }`}
        >
          {pinned ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <Info className="h-3.5 w-3.5" />
          )}
        </button>
      </div>
      {open && (
        <WorkerHoverCard
          worker={w}
          visual={visual}
          lastPrompt={lastPrompt}
          lastOutput={lastOutput}
          promptCount={promptCount}
        />
      )}
    </li>
  );
}

function WorkerHoverCard({
  worker,
  visual,
  lastPrompt,
  lastOutput,
  promptCount,
}: {
  worker: WorkerStatus;
  visual: Visual;
  lastPrompt: string;
  lastOutput: string;
  promptCount: number;
}) {
  const uptime =
    worker.running && worker.startedAt
      ? formatUptime(Date.now() - worker.startedAt)
      : null;
  const statusLabel = worker.running ? visual.label : "stopped";
  return (
    <div
      role="dialog"
      className="border-t border-neutral-800/70 bg-neutral-950/95 px-3 py-3 text-[11px] text-neutral-300"
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-neutral-500 uppercase tracking-wider text-[10px]">Status</dt>
        <dd className={`uppercase tracking-wider text-[10px] ${visual.labelClass}`}>
          {statusLabel}
        </dd>

        <dt className="text-neutral-500 uppercase tracking-wider text-[10px]">Uptime</dt>
        <dd className="font-mono text-neutral-300">
          {uptime ?? <span className="italic text-neutral-600">—</span>}
        </dd>

        <dt className="text-neutral-500 uppercase tracking-wider text-[10px]">Prompts</dt>
        <dd className="font-mono text-neutral-300">
          {promptCount > 0 ? promptCount : (
            <span className="italic text-neutral-600">none yet</span>
          )}
        </dd>

        <dt className="text-neutral-500 uppercase tracking-wider text-[10px]">Last prompt</dt>
        <dd className="break-words font-mono text-neutral-300">
          {lastPrompt || <span className="italic text-neutral-600">—</span>}
        </dd>

        <dt className="text-neutral-500 uppercase tracking-wider text-[10px]">Last output</dt>
        <dd className="line-clamp-3 break-words text-neutral-300">
          {lastOutput || <span className="italic text-neutral-600">—</span>}
        </dd>
      </dl>
    </div>
  );
}

function formatUptime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

interface Visual {
  tone: "amber" | "rose" | "lime" | "neutral" | "sky" | "orange";
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
  if (w.state === "awaiting_input") {
    return {
      tone: "orange",
      pulsing: true,
      label: "needs Enter",
      labelClass: "text-orange-300",
      idleHint: "Prompt typed but not submitted.",
    };
  }
  if (isActivelyWorking(w)) {
    return {
      tone: "amber",
      pulsing: true,
      label: "working",
      labelClass: "text-amber-300",
      idleHint: "Thinking — no recent output yet.",
    };
  }
  if (w.running) {
    // Alive PTY but no live status row. If the visible tail is a
    // completion line ("Brewed for 2m 20s") show it as "done" so the
    // user can tell at a glance the last turn finished; otherwise it's
    // a fresh idle prompt.
    if (COMPLETION_RX.test(w.lastLine)) {
      return {
        tone: "lime",
        pulsing: false,
        label: "done",
        labelClass: "text-lime-400",
        idleHint: "Last task completed — ready for the next.",
      };
    }
    return {
      tone: "lime",
      pulsing: false,
      label: "ready",
      labelClass: "text-lime-400",
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
        : tone === "lime"
          ? "bg-lime-400"
          : tone === "sky"
            ? "bg-sky-400"
            : tone === "orange"
              ? "bg-orange-500"
              : "bg-neutral-700";
  const halo =
    tone === "amber"
      ? "bg-amber-400/60"
      : tone === "rose"
        ? "bg-rose-400/60"
        : tone === "lime"
          ? "bg-lime-400/60"
          : tone === "sky"
            ? "bg-sky-400/60"
            : tone === "orange"
              ? "bg-orange-500/60"
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
