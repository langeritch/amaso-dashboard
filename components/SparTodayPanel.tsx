"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Sparkles,
  Terminal,
} from "lucide-react";
import { formatRelativeTime } from "@/lib/relative-time";

// "Today at a glance" strip rendered above the spar chat. Three
// compact cards — terminals, open loops (heartbeat), unresolved
// remarks — keep the most actionable signals above the fold without
// pushing the chat composer off-screen. The whole strip is collapsible
// (state persisted in localStorage) so power users can hide it once
// they're heads-down in a conversation.

const COLLAPSE_KEY = "spar:todayPanelCollapsed:v1";
const POLL_MS = 5_000;

type TerminalState =
  | "thinking"
  | "permission_gate"
  | "at_prompt"
  | "awaiting_input"
  | "unknown"
  | "idle";

interface TerminalSummary {
  id: string;
  projectId: string;
  name: string;
  state: TerminalState;
  hint: string;
  running: boolean;
  startedAt: number | null;
}

interface RemarkSummary {
  id: number;
  projectId: string;
  projectName: string;
  userId: number;
  userName: string;
  category: "frontend" | "backend" | "other";
  body: string;
  createdAt: number;
  path: string | null;
  line: number | null;
}

interface TodayPayload {
  terminals: {
    items: TerminalSummary[];
    runningCount: number;
    busyCount: number;
    totalProjects: number;
  };
  openLoops: string[];
  remarks: RemarkSummary[];
}

export default function SparTodayPanel() {
  const [data, setData] = useState<TodayPayload | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [loadedPref, setLoadedPref] = useState(false);

  // Hydrate collapse pref. Done in an effect so SSR matches the first
  // client paint (always expanded on first render), then we sync to
  // storage on the next tick.
  useEffect(() => {
    try {
      if (window.localStorage.getItem(COLLAPSE_KEY) === "1") {
        setCollapsed(true);
      }
    } catch {
      /* private mode — fall back to default expanded */
    } finally {
      setLoadedPref(true);
    }
  }, []);
  useEffect(() => {
    if (!loadedPref) return;
    try {
      if (collapsed) window.localStorage.setItem(COLLAPSE_KEY, "1");
      else window.localStorage.removeItem(COLLAPSE_KEY);
    } catch {
      /* quota / private mode — non-fatal */
    }
  }, [collapsed, loadedPref]);

  // Skip polling entirely while collapsed — no point burning the
  // network if the data never paints.
  useEffect(() => {
    if (collapsed) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/spar/today", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as TodayPayload;
        if (!cancelled) setData(body);
      } catch {
        /* next tick will retry */
      }
    }
    void load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [collapsed]);

  return (
    <section
      aria-label="Today at a glance"
      className="flex-shrink-0 border-b border-neutral-800/70 bg-neutral-950/40"
    >
      {/* Left padding leaves room for SparPageShell's floating
          hamburger (`absolute top-2 left-2`) which would otherwise
          sit on top of the "Today at a glance" label. */}
      <header className="flex items-center justify-between gap-3 px-4 pt-3 pb-1.5 pl-12 sm:px-5 sm:pl-5">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500">
          <Sparkles className="h-3 w-3 text-orange-500/80" />
          <span>Today at a glance</span>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="amaso-fx amaso-press flex h-9 min-w-[44px] items-center gap-1 rounded-md px-2.5 text-[11px] text-neutral-500 hover:bg-neutral-900/60 hover:text-neutral-200 sm:h-7 sm:min-w-0"
          aria-expanded={!collapsed}
          aria-controls="spar-today-content"
        >
          {collapsed ? (
            <>
              <ChevronDown className="h-3 w-3" /> Show
            </>
          ) : (
            <>
              <ChevronUp className="h-3 w-3" /> Hide
            </>
          )}
        </button>
      </header>
      <div
        id="spar-today-content"
        data-open={collapsed ? "false" : "true"}
        // Smooth open/close instead of a hard conditional unmount.
        // max-height caps the panel at a value that comfortably fits
        // the cards on every breakpoint; when collapsed it eases to
        // zero. aria-hidden mirrors the visual state for SR/AX.
        aria-hidden={collapsed}
        className="amaso-collapse"
        style={{ maxHeight: collapsed ? 0 : 260 }}
      >
        <div
          // Mobile: horizontal swipe strip with snap points so all
          // three cards stay reachable without burning vertical
          // space (a stacked column would push the chat composer
          // below the fold on a phone). lg+: 3-column grid.
          className="amaso-snap-strip flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-3 sm:px-5 sm:pb-4 lg:grid lg:grid-cols-3 lg:overflow-visible lg:snap-none"
        >
          <TerminalsCard terminals={data?.terminals ?? null} />
          <OpenLoopsCard loops={data?.openLoops ?? null} />
          <RemarksCard remarks={data?.remarks ?? null} />
        </div>
      </div>
    </section>
  );
}

/** Frame each card uses so spacing / borders / blur stay coherent. */
function CardFrame({
  title,
  icon: Icon,
  badge,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="amaso-fx amaso-fade-in flex h-[180px] w-[82%] max-w-sm flex-shrink-0 snap-start snap-always flex-col overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-900/50 hover:border-neutral-700/80 sm:w-[60%] lg:h-[200px] lg:w-auto lg:max-w-none lg:flex-shrink">
      <div className="flex items-center gap-2 border-b border-neutral-800/70 px-3 py-2">
        <Icon className="h-3.5 w-3.5 text-neutral-400" />
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-neutral-400">
          {title}
        </h3>
        {badge && <span className="ml-auto">{badge}</span>}
      </div>
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm">
        {children}
      </div>
    </div>
  );
}

function TerminalsCard({
  terminals,
}: {
  terminals: TodayPayload["terminals"] | null;
}) {
  const summary = useMemo(() => {
    if (!terminals) return null;
    const { runningCount, busyCount, totalProjects } = terminals;
    return { runningCount, busyCount, totalProjects };
  }, [terminals]);

  return (
    <CardFrame
      title="Active terminals"
      icon={Terminal}
      badge={
        summary ? (
          <span className="inline-flex items-center gap-1 text-[10px] text-neutral-500">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                summary.busyCount > 0
                  ? "bg-orange-400 shadow-[0_0_4px_rgba(255,107,61,0.6)]"
                  : summary.runningCount > 0
                    ? "bg-lime-400"
                    : "bg-neutral-700"
              }`}
            />
            {summary.busyCount}/{summary.runningCount} busy
          </span>
        ) : null
      }
    >
      {!terminals ? (
        <div className="flex flex-col gap-1.5">
          <div className="amaso-skeleton h-4" />
          <div className="amaso-skeleton h-4 w-2/3" />
        </div>
      ) : terminals.items.length === 0 ? (
        <p className="text-sm italic text-neutral-600 sm:text-[12px]">
          No terminals running. Spawn one from a project page.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {terminals.items.map((t) => (
            <li key={t.id}>
              <Link
                href={`/projects/${t.projectId}`}
                className="amaso-fx amaso-press flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-neutral-800/50 active:bg-neutral-800/70"
              >
                <TerminalStateDot state={t.state} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-neutral-100 sm:text-[13px]">
                      {t.name}
                    </span>
                    <span
                      className={`flex-shrink-0 text-[10px] uppercase tracking-[0.12em] ${stateLabelClass(
                        t.state,
                      )}`}
                    >
                      {stateLabel(t.state)}
                    </span>
                  </div>
                  {t.hint && (
                    <p className="mt-0.5 truncate text-[11px] text-neutral-500">
                      {t.hint}
                    </p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </CardFrame>
  );
}

function TerminalStateDot({ state }: { state: TerminalState }) {
  const tone =
    state === "permission_gate"
      ? "bg-rose-400"
      : state === "awaiting_input"
        ? "bg-orange-400"
        : state === "thinking"
          ? "bg-amber-400"
          : state === "at_prompt"
            ? "bg-lime-400"
            : "bg-neutral-700";
  const halo =
    state === "permission_gate"
      ? "bg-rose-400/60"
      : state === "thinking"
        ? "bg-amber-400/60"
        : state === "awaiting_input"
          ? "bg-orange-400/60"
          : null;
  return (
    <span
      className="relative mt-1.5 inline-flex h-1.5 w-1.5 flex-shrink-0"
      aria-hidden
    >
      {halo && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full ${halo}`}
        />
      )}
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${tone}`} />
    </span>
  );
}

function stateLabel(state: TerminalState): string {
  switch (state) {
    case "permission_gate":
      return "needs you";
    case "awaiting_input":
      return "needs Enter";
    case "thinking":
      return "working";
    case "at_prompt":
      return "ready";
    case "idle":
      return "idle";
    default:
      return "unknown";
  }
}

function stateLabelClass(state: TerminalState): string {
  switch (state) {
    case "permission_gate":
      return "text-rose-300";
    case "awaiting_input":
      return "text-orange-300";
    case "thinking":
      return "text-amber-300";
    case "at_prompt":
      return "text-lime-300";
    default:
      return "text-neutral-500";
  }
}

function OpenLoopsCard({ loops }: { loops: string[] | null }) {
  return (
    <CardFrame
      title="Open loops"
      icon={Brain}
      badge={
        loops ? (
          <span className="text-[10px] text-neutral-500">{loops.length}</span>
        ) : null
      }
    >
      {!loops ? (
        <div className="flex flex-col gap-1.5">
          <div className="amaso-skeleton h-4" />
          <div className="amaso-skeleton h-4 w-3/4" />
        </div>
      ) : loops.length === 0 ? (
        <p className="text-sm italic text-neutral-600 sm:text-[12px]">
          Heartbeat is clear — no open loops right now.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {loops.map((loop, i) => (
            <li
              key={i}
              className="flex gap-2 text-sm leading-snug text-neutral-200 sm:text-[13px]"
            >
              <span className="mt-2 h-1 w-1 flex-shrink-0 rounded-full bg-orange-500/70" />
              <span className="break-words">{loop}</span>
            </li>
          ))}
        </ul>
      )}
    </CardFrame>
  );
}

function RemarksCard({ remarks }: { remarks: RemarkSummary[] | null }) {
  return (
    <CardFrame
      title="Open remarks"
      icon={MessageSquare}
      badge={
        remarks ? (
          <span className="text-[10px] text-neutral-500">{remarks.length}</span>
        ) : null
      }
    >
      {!remarks ? (
        <div className="flex flex-col gap-1.5">
          <div className="amaso-skeleton h-4" />
          <div className="amaso-skeleton h-4 w-2/3" />
        </div>
      ) : remarks.length === 0 ? (
        <p className="text-sm italic text-neutral-600 sm:text-[12px]">
          No unresolved remarks. Inbox zero.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {remarks.map((r) => (
            <li key={r.id}>
              <Link
                href={`/projects/${r.projectId}`}
                className="amaso-fx amaso-press block rounded-md px-2 py-1.5 hover:bg-neutral-800/50 active:bg-neutral-800/70"
              >
                <div className="flex items-baseline gap-2">
                  <CategoryPip category={r.category} />
                  <span className="truncate text-[11px] text-neutral-400">
                    {r.projectName}
                  </span>
                  <span className="ml-auto truncate text-[10px] text-neutral-600">
                    {formatRelativeTime(r.createdAt) ?? ""}
                  </span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-sm leading-snug text-neutral-200 sm:text-[13px]">
                  {r.body}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </CardFrame>
  );
}

function CategoryPip({
  category,
}: {
  category: RemarkSummary["category"];
}) {
  const tone =
    category === "frontend"
      ? "bg-orange-500"
      : category === "backend"
        ? "bg-sky-400"
        : "bg-neutral-500";
  return (
    <span
      aria-hidden
      title={category}
      className={`inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full ${tone}`}
    />
  );
}
