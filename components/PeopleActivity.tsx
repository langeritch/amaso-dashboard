"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Circle, FolderKanban } from "lucide-react";

// Per-user activity view used on /admin/users and the team dashboard.
// Reuses the existing GET /api/admin/activity feed (super-user-only)
// but groups rows by user instead of showing the flat stream — lets
// you scan "what has each person been doing" at a glance.
//
// The full-screen flat-feed view lives in components/ActivityPanel,
// rendered on /admin/activity. Keep that for deep audits.

interface OnlineSession {
  presenceId: number;
  clientId: string;
  connectedAt: number;
  lastSeenAt: number;
  currentPath: string | null;
  userAgent: string | null;
}

interface OnlineUser {
  userId: number;
  name: string;
  email: string;
  role: string;
  liveSessions: number;
  totalSessions: number;
  oldestConnectedAt: number;
  latestSeenAt: number;
  sessions: OnlineSession[];
}

interface ActivityRow {
  id: number;
  userId: number;
  userName: string;
  userEmail: string;
  presenceId: number | null;
  kind: "page_visit" | "action";
  label: string;
  detail: unknown;
  at: number;
}

interface FeedResponse {
  online: OnlineUser[];
  recent: ActivityRow[];
  now: number;
}

export interface ProjectRef {
  id: string;
  name: string;
}

const REFRESH_MS = 30_000;
const PER_USER_ITEMS = 5;

interface UserGroup {
  userId: number;
  name: string;
  email: string;
  online: OnlineUser | null;
  latestAt: number;
  items: ActivityRow[];
}

interface PeopleActivityProps {
  /**
   * Optional project list used to translate `/projects/<id>` paths into
   * human-readable project names. When omitted, raw paths are shown.
   */
  projects?: ProjectRef[];
}

export default function PeopleActivity({ projects }: PeopleActivityProps = {}) {
  const [data, setData] = useState<FeedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/activity", { cache: "no-store" });
      if (res.status === 403) {
        setError("Activity feed is super-user only.");
        return;
      }
      if (!res.ok) {
        setError(`Could not load (${res.status})`);
        return;
      }
      const body = (await res.json()) as FeedResponse;
      setData(body);
      setError(null);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_MS);
    const onFocus = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const projectIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects ?? []) m.set(p.id, p.name);
    return m;
  }, [projects]);

  const groups = useMemo<UserGroup[]>(() => {
    if (!data) return [];
    const onlineByUser = new Map<number, OnlineUser>(
      data.online.map((o) => [o.userId, o]),
    );
    const map = new Map<number, UserGroup>();

    for (const row of data.recent) {
      let entry = map.get(row.userId);
      if (!entry) {
        entry = {
          userId: row.userId,
          name: row.userName,
          email: row.userEmail,
          online: onlineByUser.get(row.userId) ?? null,
          latestAt: row.at,
          items: [],
        };
        map.set(row.userId, entry);
      }
      if (row.at > entry.latestAt) entry.latestAt = row.at;
      entry.items.push(row);
    }

    // Catch online users who have no rows in the recent window.
    for (const o of data.online) {
      if (map.has(o.userId)) continue;
      map.set(o.userId, {
        userId: o.userId,
        name: o.name,
        email: o.email,
        online: o,
        latestAt: o.latestSeenAt,
        items: [],
      });
    }

    return [...map.values()].sort((a, b) => {
      const aOnline = (a.online?.liveSessions ?? 0) > 0;
      const bOnline = (b.online?.liveSessions ?? 0) > 0;
      if (aOnline !== bOnline) return aOnline ? -1 : 1;
      return b.latestAt - a.latestAt;
    });
  }, [data]);

  if (loading && !data) {
    return <p className="text-sm text-neutral-500">Loading activity…</p>;
  }
  if (error) {
    return (
      <div className="rounded-md border border-red-900/50 bg-red-900/20 px-3 py-2 text-xs text-red-300">
        {error}
      </div>
    );
  }
  if (!data || groups.length === 0) {
    return (
      <p className="rounded border border-dashed border-neutral-800 px-3 py-4 text-center text-sm text-neutral-500">
        No activity recorded yet.
      </p>
    );
  }

  const now = data.now;

  return (
    <ul className="space-y-2">
      {groups.map((g) => (
        <UserActivityCard
          key={g.userId}
          group={g}
          now={now}
          projectIndex={projectIndex}
        />
      ))}
    </ul>
  );
}

function UserActivityCard({
  group,
  now,
  projectIndex,
}: {
  group: UserGroup;
  now: number;
  projectIndex: Map<string, string>;
}) {
  const isOnline = (group.online?.liveSessions ?? 0) > 0;
  const currentPath = group.online?.sessions[0]?.currentPath ?? null;
  const location = describePath(currentPath, projectIndex);

  return (
    <li className="rounded border border-neutral-800 bg-neutral-950/50 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <Circle
            aria-hidden="true"
            className={`h-2 w-2 flex-shrink-0 ${
              isOnline
                ? "fill-orange-400 text-orange-400"
                : "fill-neutral-700 text-neutral-700"
            }`}
          />
          <span className="truncate text-sm font-medium text-neutral-100">
            {group.name}
          </span>
          <span className="hidden truncate text-xs text-neutral-500 sm:inline">
            {group.email}
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2 text-xs text-neutral-500">
          {isOnline ? (
            <>
              <span className="text-orange-400">Online</span>
              {location && <LocationChip location={location} />}
            </>
          ) : (
            <span>Last active {formatRelative(now - group.latestAt)}</span>
          )}
        </div>
      </div>

      {group.items.length > 0 ? (
        <ul className="mt-2 space-y-1 border-l border-neutral-800/70 pl-3">
          {group.items.slice(0, PER_USER_ITEMS).map((row) => (
            <ActivityLine
              key={row.id}
              row={row}
              now={now}
              projectIndex={projectIndex}
            />
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-neutral-600">
          No actions in the recent window.
        </p>
      )}
    </li>
  );
}

interface PathLocation {
  label: string;
  href: string | null;
  kind: "project" | "page";
}

function LocationChip({ location }: { location: PathLocation }) {
  const isProject = location.kind === "project";
  const className = `inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
    isProject
      ? "border-orange-900/60 bg-orange-900/20 text-orange-300"
      : "border-neutral-800 bg-neutral-900 text-neutral-400"
  }`;

  const inner = (
    <>
      {isProject && (
        <FolderKanban aria-hidden="true" className="h-3 w-3 flex-shrink-0" />
      )}
      <span className="max-w-[16ch] truncate">{location.label}</span>
    </>
  );

  if (location.href) {
    return (
      <Link href={location.href} className={`${className} hover:brightness-125`}>
        {inner}
      </Link>
    );
  }
  return <span className={className}>{inner}</span>;
}

function ActivityLine({
  row,
  now,
  projectIndex,
}: {
  row: ActivityRow;
  now: number;
  projectIndex: Map<string, string>;
}) {
  const pretty = prettyLabel(row.label, projectIndex);
  return (
    <li className="flex items-baseline gap-2 text-xs">
      <span className="w-12 flex-shrink-0 text-right font-mono tabular-nums text-neutral-600">
        {formatRelative(now - row.at)}
      </span>
      <span
        aria-hidden="true"
        className={
          row.kind === "action" ? "text-amber-400/80" : "text-sky-400/70"
        }
      >
        {row.kind === "action" ? "•" : "→"}
      </span>
      <span className="min-w-0 flex-1 truncate text-neutral-300">{pretty}</span>
    </li>
  );
}

/**
 * Translate a presence path into something readable. `/projects/<id>` becomes
 * "Working on <project name>" with a link; common top-level routes get
 * friendly labels; everything else falls back to the raw path.
 */
function describePath(
  raw: string | null,
  projectIndex: Map<string, string>,
): PathLocation | null {
  if (!raw) return null;
  const path = raw.split(/[?#]/, 1)[0] ?? raw;
  const projectMatch = path.match(/^\/projects\/([^/]+)/);
  if (projectMatch) {
    const id = decodeURIComponent(projectMatch[1] ?? "");
    if (id) {
      return {
        label: projectIndex.get(id) ?? id,
        href: `/projects/${id}`,
        kind: "project",
      };
    }
  }
  const pageLabel = pageLabelFor(path);
  return { label: pageLabel, href: null, kind: "page" };
}

function pageLabelFor(path: string): string {
  if (path === "/" || path === "") return "Chat";
  if (path.startsWith("/projects")) return "Projects";
  if (path.startsWith("/spar")) return "Spar";
  if (path.startsWith("/remarks")) return "Remarks";
  if (path.startsWith("/heartbeat")) return "Heartbeat";
  if (path.startsWith("/brain")) return "Brain";
  if (path.startsWith("/memory")) return "Memory";
  if (path.startsWith("/admin/users")) return "Admin · Users";
  if (path.startsWith("/admin/activity")) return "Admin · Activity";
  if (path.startsWith("/admin")) return "Admin";
  if (path.startsWith("/settings")) return "Settings";
  if (path.startsWith("/telegram")) return "Telegram";
  return path;
}

function prettyLabel(
  raw: string,
  projectIndex: Map<string, string>,
): React.ReactNode {
  // Page visit labels are stored as raw paths — translate them inline so
  // the activity feed reads as English.
  if (raw.startsWith("/")) {
    const loc = describePath(raw, projectIndex);
    if (!loc) return <span className="font-mono text-neutral-200">{raw}</span>;
    if (loc.kind === "project") {
      return (
        <span>
          <span className="text-neutral-500">opened </span>
          <span className="text-orange-300">{loc.label}</span>
        </span>
      );
    }
    return (
      <span>
        <span className="text-neutral-500">visited </span>
        <span className="text-neutral-200">{loc.label}</span>
      </span>
    );
  }
  return <span className="text-neutral-200">{raw}</span>;
}

function formatRelative(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 5_000) return "now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}
