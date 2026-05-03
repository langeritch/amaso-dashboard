"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Circle,
  FileEdit,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
  Wrench,
} from "lucide-react";

/**
 * People & Activity feed for the /activity page.
 *
 * Polls /api/activity every 5s for a unified timeline + per-user
 * summary cards. Match the workers panel's chrome (rounded card,
 * neutral-800 borders, neutral-950/60 background) so the page reads
 * as a sibling surface.
 *
 * No WebSocket: a 5s poll is enough for a "what's been happening"
 * view and avoids building another bus subscriber.
 */

interface FeedItem {
  id: string;
  kind:
    | "dispatch"
    | "dispatch_completed"
    | "remark_created"
    | "remark_resolved"
    | "file_change"
    | "presence";
  ts: number;
  projectId: string | null;
  projectName: string | null;
  userId: number | null;
  userName: string | null;
  summary: string;
  detail?: Record<string, unknown>;
}

interface PeopleCard {
  userId: number;
  name: string;
  email: string;
  role: string;
  activityCount: number;
  lastActiveAt: number | null;
  online: boolean;
}

interface ApiResponse {
  now: number;
  feed: FeedItem[];
  people: PeopleCard[];
  onlineThresholdMs: number;
}

const POLL_MS = 5_000;

export default function UnifiedActivityFeed() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FeedItem["kind"] | "all">("all");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/activity", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as ApiResponse;
      setData(body);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_failed");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [refresh]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (filter === "all") return data.feed;
    return data.feed.filter((it) => it.kind === filter);
  }, [data, filter]);

  if (!data && !error) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-neutral-800/80 bg-neutral-950/60 px-4 py-6 text-sm text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading activity…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <PeopleRow people={data?.people ?? []} />

      <section className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-950/60 shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-800/70 px-3 py-2">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-500">
            Timeline
          </h2>
          <FilterChips active={filter} onChange={setFilter} />
        </div>

        {filtered.length === 0 ? (
          <div className="px-4 py-6 text-sm text-neutral-500">
            Nothing to show here yet.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-800/70">
            {filtered.map((it) => (
              <FeedRow key={it.id} item={it} now={data?.now ?? Date.now()} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PeopleRow({ people }: { people: PeopleCard[] }) {
  if (people.length === 0) {
    return (
      <section className="rounded-xl border border-neutral-800/80 bg-neutral-950/60 px-4 py-4 text-sm text-neutral-500">
        No team activity in the current window.
      </section>
    );
  }
  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-950/60 shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
      <h2 className="px-3 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-500">
        People
      </h2>
      <div className="grid gap-px border-t border-neutral-800/70 bg-neutral-800/70 sm:grid-cols-2 lg:grid-cols-3">
        {people.map((p) => (
          <PersonCard key={p.userId} person={p} />
        ))}
      </div>
    </section>
  );
}

function PersonCard({ person }: { person: PeopleCard }) {
  const initial = person.name.slice(0, 1).toUpperCase();
  return (
    <div className="flex items-center gap-3 bg-neutral-950/80 px-3 py-3">
      <div className="relative flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-neutral-700 to-neutral-800 text-base font-medium text-neutral-100 ring-1 ring-white/5">
        {initial}
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-neutral-950 ${
            person.online ? "bg-orange-500 shadow-[0_0_6px_rgba(255, 107, 61,0.55)]" : "bg-neutral-600"
          }`}
          aria-label={person.online ? "online" : "offline"}
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium text-neutral-200">
            {person.name}
          </span>
          <span className="rounded-full border border-neutral-700 px-1.5 text-[10px] uppercase tracking-wide text-neutral-500">
            {person.role}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-neutral-500">
          {person.activityCount} event{person.activityCount === 1 ? "" : "s"} ·{" "}
          {person.lastActiveAt
            ? `active ${formatRelative(person.lastActiveAt, Date.now())}`
            : "no recent activity"}
        </div>
      </div>
    </div>
  );
}

function FilterChips({
  active,
  onChange,
}: {
  active: FeedItem["kind"] | "all";
  onChange: (next: FeedItem["kind"] | "all") => void;
}) {
  const chips: Array<{ value: FeedItem["kind"] | "all"; label: string }> = [
    { value: "all", label: "All" },
    { value: "dispatch", label: "Dispatches" },
    { value: "remark_created", label: "Remarks" },
    { value: "file_change", label: "File changes" },
    { value: "presence", label: "Presence" },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((c) => {
        const isActive = c.value === active;
        return (
          <button
            key={c.value}
            type="button"
            onClick={() => onChange(c.value)}
            className={`amaso-fx rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] ${
              isActive
                ? "border-orange-500/40 bg-orange-500/15 text-orange-200 shadow-[0_0_0_1px_rgba(255, 107, 61,0.18)]"
                : "border-neutral-800 bg-neutral-950 text-neutral-500 hover:border-neutral-700 hover:text-neutral-200"
            }`}
            aria-pressed={isActive}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}

function FeedRow({ item, now }: { item: FeedItem; now: number }) {
  const visual = visualForKind(item.kind);
  const projectChip = item.projectId ? (
    <Link
      href={`/projects/${item.projectId}`}
      className="amaso-fx rounded-md border border-neutral-800 bg-neutral-900/60 px-1.5 py-0.5 font-mono text-[10px] text-neutral-300 hover:border-neutral-700 hover:bg-neutral-800 hover:text-neutral-100"
      title={item.projectId}
      onClick={(e) => e.stopPropagation()}
    >
      {item.projectName ?? item.projectId}
    </Link>
  ) : null;
  return (
    <li className="amaso-fx flex items-start gap-3 px-3 py-2.5 hover:bg-neutral-900/40">
      <span
        className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md ${visual.iconBg}`}
        aria-hidden
      >
        <visual.Icon className={`h-3.5 w-3.5 ${visual.iconColor}`} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {item.userName && (
            <span className="truncate text-sm font-medium text-neutral-200">
              {item.userName}
            </span>
          )}
          <span className="text-[11px] uppercase tracking-wider text-neutral-500">
            {visual.label}
          </span>
          {projectChip}
          <span className="ml-auto whitespace-nowrap text-[11px] text-neutral-500">
            {formatRelative(item.ts, now)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-neutral-400">
          {item.summary}
        </p>
      </div>
    </li>
  );
}

interface KindVisual {
  Icon: typeof Send;
  iconBg: string;
  iconColor: string;
  label: string;
}

function visualForKind(kind: FeedItem["kind"]): KindVisual {
  switch (kind) {
    case "dispatch":
      return {
        Icon: Send,
        iconBg: "bg-sky-900/40",
        iconColor: "text-sky-300",
        label: "Dispatched",
      };
    case "dispatch_completed":
      return {
        Icon: Sparkles,
        iconBg: "bg-orange-900/40",
        iconColor: "text-orange-300",
        label: "Finished",
      };
    case "remark_created":
      return {
        Icon: MessageSquare,
        iconBg: "bg-amber-900/40",
        iconColor: "text-amber-300",
        label: "Remark",
      };
    case "remark_resolved":
      return {
        Icon: Sparkles,
        iconBg: "bg-orange-900/40",
        iconColor: "text-orange-300",
        label: "Resolved",
      };
    case "file_change":
      return {
        Icon: FileEdit,
        iconBg: "bg-neutral-800/60",
        iconColor: "text-neutral-400",
        label: "File",
      };
    case "presence":
      return {
        Icon: Circle,
        iconBg: "bg-neutral-800/60",
        iconColor: "text-neutral-500",
        label: "Visited",
      };
    default:
      return {
        Icon: Wrench,
        iconBg: "bg-neutral-800/60",
        iconColor: "text-neutral-400",
        label: "Event",
      };
  }
}

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  if (diff < 60_000) return "just now";
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

