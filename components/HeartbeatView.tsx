"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, CheckCircle2, AlertTriangle, RefreshCw } from "lucide-react";
import { formatRelativeTime } from "@/lib/relative-time";

export interface Tier1Results {
  reasons?: string[];
  openRemarks?: number;
  hasTimeKeyword?: boolean;
  isStale?: boolean;
  staleHours?: number;
  idleTerminals?: string[];
}

export interface Tick {
  id: number;
  at: number;
  status: "ok" | "alert";
  tier1: Tier1Results | null;
  tier2Summary: string | null;
  notified: boolean;
}

export interface Section {
  title: string;
  items: string[];
}

export const SECTION_HEADERS = ["Now", "Today", "Open loops"] as const;

export function parseHeartbeat(body: string): Section[] {
  // The lean format is exactly three `## Header` blocks. Render whatever
  // the file contains; if the model has drifted we still want to show
  // something rather than blank out.
  const trimmed = body.trim();
  if (!trimmed) return [];
  const sections: Section[] = [];
  const lines = trimmed.split(/\r?\n/);
  let current: Section | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      if (current) sections.push(current);
      current = { title: headerMatch[1].trim(), items: [] };
      continue;
    }
    if (!current) {
      // Pre-header content — fold into a synthetic "Notes" section so it
      // surfaces instead of being silently dropped.
      current = { title: "Notes", items: [] };
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      current.items.push(bullet[1].trim());
    } else if (line.trim().length > 0) {
      current.items.push(line.trim());
    }
  }
  if (current) sections.push(current);
  return sections;
}

export function formatExactTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (sameDay) return `Today at ${time}`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday at ${time}`;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function inlineMarkdown(text: string): React.ReactNode[] {
  // Minimal **bold** support — that's the only inline syntax the lean
  // heartbeat format uses. Anything else renders as-is.
  const parts: React.ReactNode[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <strong key={key++} className="text-neutral-100">
        {m[1]}
      </strong>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function useTickHistory(
  userId: number,
  pollMs: number = 60_000,
  enabled: boolean = true,
) {
  const [ticks, setTicks] = useState<Tick[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/spar/heartbeat/ticks?user=${userId}&limit=200`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        setError(`Failed to load (${res.status})`);
        return;
      }
      const data = (await res.json()) as { ticks: Tick[] };
      setTicks(data.ticks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, pollMs);
    return () => window.clearInterval(iv);
  }, [load, pollMs, enabled]);

  return { ticks, loading, error, reload: load };
}

/** Lightweight latest-tick poller for the spar heartbeat button's status
 *  dot. Pulls a single row from the ticks endpoint and re-fetches on a
 *  one-minute timer so the indicator (green = ok / amber = alert) reflects
 *  the most recent cron tick without paying for the 200-row history. */
export function useLatestTick(
  userId: number,
  pollMs: number = 60_000,
): Tick | null {
  const [tick, setTick] = useState<Tick | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(
          `/api/spar/heartbeat/ticks?user=${userId}&limit=1`,
          { cache: "no-store" },
        );
        if (!res.ok) return;
        const data = (await res.json()) as { ticks: Tick[] };
        if (!cancelled) setTick(data.ticks?.[0] ?? null);
      } catch {
        /* non-fatal — the dot just stays in its previous state */
      }
    };
    void load();
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, pollMs);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [userId, pollMs]);

  return tick;
}

/** Fetches the user's heartbeat body, polling while `enabled`. Used by
 *  HeartbeatPanel so the parsed Now/Today/Open-loops view stays fresh
 *  without a manual refresh. /heartbeat continues to fetch on visibility
 *  events only — the page is rarely the foreground tab. */
export function useHeartbeatBody(
  userId: number,
  initialBody: string,
  pollMs: number = 60_000,
  enabled: boolean = true,
) {
  const [body, setBody] = useState(initialBody);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/spar/heartbeat?user=${userId}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { body: string };
      if (typeof data.body === "string") setBody(data.body);
    } catch {
      /* ignore */
    }
  }, [userId]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, pollMs);
    return () => window.clearInterval(iv);
  }, [load, pollMs, enabled]);

  return { body, setBody, reload: load };
}

export default function HeartbeatView({
  userId,
  initialBody,
  pollMs = 60_000,
}: {
  userId: number;
  initialBody: string;
  pollMs?: number;
}) {
  const [body, setBody] = useState(initialBody);
  const sections = useMemo(() => parseHeartbeat(body), [body]);
  const { ticks, loading, error, reload } = useTickHistory(userId, pollMs);

  // The current heartbeat file mtime updates on tier-2 model edits or
  // when the user (or other tooling) writes to it. Refetch on focus so
  // the rendered "now" stays in sync with disk.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch(`/api/spar/heartbeat?user=${userId}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { body: string };
        if (!cancelled && typeof data.body === "string") setBody(data.body);
      } catch {
        /* ignore */
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [userId]);

  return (
    <div className="flex flex-col gap-6">
      <CurrentHeartbeat sections={sections} />
      <Timeline
        ticks={ticks}
        loading={loading}
        error={error}
        onReload={reload}
      />
    </div>
  );
}

export function CurrentHeartbeat({ sections }: { sections: Section[] }) {
  if (sections.length === 0) {
    return (
      <section className="rounded-xl border border-neutral-800/80 bg-neutral-950 p-4 text-sm text-neutral-500">
        Heartbeat is empty.
      </section>
    );
  }
  return (
    <section className="rounded-xl border border-neutral-800/80 bg-neutral-950 p-4 shadow-[0_1px_2px_rgba(0,0,0,0.2)] sm:p-5">
      <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-neutral-500">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.55)]" />
        </span>
        Live
      </div>
      <div className="flex flex-col gap-4">
        {sections.map((section, idx) => (
          <div key={`${section.title}-${idx}`}>
            <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400">
              {section.title}
            </h2>
            {section.items.length === 0 ? (
              <p className="text-sm italic text-neutral-600">— nothing —</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {section.items.map((item, i) => (
                  <li
                    key={i}
                    className="flex gap-2 text-sm leading-relaxed text-neutral-200"
                  >
                    <span className="mt-2 h-1 w-1 flex-shrink-0 rounded-full bg-neutral-600" />
                    <span>{inlineMarkdown(item)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      {!SECTION_HEADERS.every((h) => sections.some((s) => s.title === h)) && (
        <p className="mt-4 text-[11px] text-amber-500/70">
          Heartbeat drifted from the lean format. Expected sections: Now /
          Today / Open loops.
        </p>
      )}
    </section>
  );
}

export function Timeline({
  ticks,
  loading,
  error,
  onReload,
}: {
  ticks: Tick[] | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
}) {
  return (
    <section className="flex flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-neutral-300">
          Timeline
        </h2>
        <button
          type="button"
          onClick={onReload}
          disabled={loading}
          className="amaso-fx flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-950 px-2.5 py-1 text-xs text-neutral-400 hover:border-neutral-700 hover:text-neutral-100 disabled:opacity-50"
          aria-label="Refresh timeline"
        >
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>
      {error && (
        <div className="mb-3 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}
      {ticks === null ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : ticks.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No ticks recorded yet. The cron writes a row every ~30 minutes
          while you're active.
        </p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {ticks.map((tick) => (
            <TickRow key={tick.id} tick={tick} />
          ))}
        </ol>
      )}
    </section>
  );
}

export function TickRow({ tick }: { tick: Tick }) {
  const [expanded, setExpanded] = useState(false);
  const expandable = tick.status === "alert";
  const relative = formatRelativeTime(tick.at) ?? "";
  const exact = formatExactTime(tick.at);

  return (
    <li className="overflow-hidden rounded-lg border border-neutral-800/70 bg-neutral-950">
      <button
        type="button"
        onClick={() => expandable && setExpanded((v) => !v)}
        disabled={!expandable}
        className={`amaso-fx flex w-full items-center gap-3 px-3 py-2 text-left ${
          expandable ? "hover:bg-neutral-900/60" : "cursor-default"
        }`}
        aria-expanded={expandable ? expanded : undefined}
      >
        <StatusBadge status={tick.status} notified={tick.notified} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="text-neutral-200">{exact}</span>
            <span className="truncate text-xs text-neutral-500">
              {relative}
            </span>
          </div>
          {tick.status === "alert" && tick.tier1?.reasons?.length ? (
            <p className="mt-0.5 truncate text-xs text-neutral-400">
              {tick.tier1.reasons.join(" · ")}
            </p>
          ) : tick.status === "ok" ? (
            <p className="mt-0.5 text-xs text-neutral-500">
              No tier-1 signal
            </p>
          ) : null}
        </div>
        {expandable && (
          <ChevronRight
            className={`h-4 w-4 flex-shrink-0 text-neutral-500 transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
          />
        )}
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="border-t border-neutral-800/70 px-3 py-2.5 text-xs text-neutral-300">
            <TickDetails tick={tick} />
          </div>
        </div>
      </div>
    </li>
  );
}

export function TickDetails({ tick }: { tick: Tick }) {
  return (
    <div className="flex flex-col gap-2.5">
      {tick.tier1 && (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Tier-1 checks
          </div>
          <ul className="flex flex-col gap-0.5 text-neutral-300">
            {tick.tier1.hasTimeKeyword && (
              <li>· Time-sensitive content in heartbeat</li>
            )}
            {tick.tier1.isStale && (
              <li>
                · Heartbeat stale {tick.tier1.staleHours ?? "?"}h with open
                loops
              </li>
            )}
            {tick.tier1.idleTerminals && tick.tier1.idleTerminals.length > 0 && (
              <li>
                · Idle terminals: {tick.tier1.idleTerminals.join(", ")}
              </li>
            )}
            {(tick.tier1.openRemarks ?? 0) > 0 && (
              <li>
                · {tick.tier1.openRemarks} open remark
                {tick.tier1.openRemarks === 1 ? "" : "s"}
              </li>
            )}
          </ul>
        </div>
      )}
      {tick.tier2Summary && (
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
            Tier-2 verdict {tick.notified ? "· pushed" : "· silent"}
          </div>
          <p className="text-neutral-200">{tick.tier2Summary}</p>
        </div>
      )}
      {!tick.tier2Summary && tick.status === "alert" && (
        <p className="italic text-neutral-500">
          No tier-2 summary recorded.
        </p>
      )}
    </div>
  );
}

export function StatusBadge({
  status,
  notified,
}: {
  status: "ok" | "alert";
  notified: boolean;
}) {
  if (status === "ok") {
    return (
      <span
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400"
        title="No signal"
      >
        <CheckCircle2 className="h-4 w-4" />
      </span>
    );
  }
  return (
    <span
      className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${
        notified
          ? "bg-amber-500/15 text-amber-400"
          : "bg-amber-500/5 text-amber-500/70"
      }`}
      title={notified ? "Alert — pushed" : "Alert — silent"}
    >
      <AlertTriangle className="h-4 w-4" />
    </span>
  );
}
