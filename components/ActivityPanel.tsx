"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Circle, Monitor, Smartphone } from "lucide-react";

/**
 * Live super-user activity panel. Polls /api/admin/activity every
 * 3 s for online presence + recent activity rows. The endpoint is
 * super-user gated; non-super-users never see the page that mounts
 * this anyway, so a 403 here just means an auth lapse and the panel
 * goes empty.
 *
 * Why polling not WebSocket: this is a single observer (Sandra) and
 * a coarse view. 3 s polling is one round-trip per few seconds —
 * cheap, simple, and we avoid building a WS broadcast channel just
 * for the admin's benefit.
 */

interface OnlineUser {
  userId: number;
  name: string;
  email: string;
  role: string;
  liveSessions: number;
  totalSessions: number;
  oldestConnectedAt: number;
  latestSeenAt: number;
  sessions: Array<{
    presenceId: number;
    clientId: string;
    connectedAt: number;
    lastSeenAt: number;
    currentPath: string | null;
    userAgent: string | null;
  }>;
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

const POLL_MS = 3_000;

export default function ActivityPanel() {
  const [data, setData] = useState<FeedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filterUser, setFilterUser] = useState<number | null>(null);
  const tickingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (tickingRef.current) return;
    tickingRef.current = true;
    try {
      const res = await fetch("/api/admin/activity", { cache: "no-store" });
      if (res.status === 403) {
        setError("Forbidden — super-user only.");
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
      tickingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const recent = useMemo(() => {
    if (!data) return [];
    if (filterUser === null) return data.recent;
    return data.recent.filter((r) => r.userId === filterUser);
  }, [data, filterUser]);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
      <section>
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Online now
          </h2>
          <span className="text-xs text-neutral-500">
            {data ? `${data.online.length} user${data.online.length === 1 ? "" : "s"}` : "…"}
          </span>
        </header>
        {error && (
          <div className="mb-3 rounded-md border border-rose-900/50 bg-rose-900/20 px-3 py-2 text-xs text-rose-300">
            {error}
          </div>
        )}
        {data === null ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : data.online.length === 0 ? (
          <p className="rounded-xl border border-dashed border-neutral-800 px-4 py-6 text-center text-sm text-neutral-500">
            No live sessions right now.
          </p>
        ) : (
          <ul className="space-y-3">
            {data.online.map((u) => (
              <UserCard
                key={u.userId}
                user={u}
                now={data.now}
                selected={filterUser === u.userId}
                onSelect={() =>
                  setFilterUser((prev) => (prev === u.userId ? null : u.userId))
                }
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-400">
            Recent activity
          </h2>
          {filterUser !== null && (
            <button
              type="button"
              onClick={() => setFilterUser(null)}
              className="rounded px-2 py-0.5 text-xs text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200"
            >
              clear filter
            </button>
          )}
        </header>
        {data === null ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : recent.length === 0 ? (
          <p className="rounded-xl border border-dashed border-neutral-800 px-4 py-6 text-center text-sm text-neutral-500">
            No recorded activity yet.
          </p>
        ) : (
          <ol className="divide-y divide-neutral-800/70 rounded-xl border border-neutral-800/80 bg-neutral-950/50">
            {recent.map((r) => (
              <ActivityListItem key={r.id} row={r} now={data.now} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function UserCard({
  user,
  now,
  selected,
  onSelect,
}: {
  user: OnlineUser;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const sessionDuration = formatDuration(now - user.oldestConnectedAt);
  const lastSeen = formatRelative(now - user.latestSeenAt);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`block w-full rounded-lg border p-4 text-left transition ${
          selected
            ? "border-orange-700 bg-orange-900/15"
            : "border-neutral-800 bg-neutral-900/40 hover:border-neutral-700"
        }`}
      >
        <div className="flex items-start gap-3">
          <span className="relative mt-1 flex h-2 w-2 flex-shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-orange-500" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium text-neutral-100">
                {user.name}
              </span>
              <span className="flex-shrink-0 text-[10px] uppercase tracking-wider text-neutral-500">
                {user.role}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-neutral-500">
              {user.email}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-neutral-400">
              <span>
                <span className="text-neutral-500">live:</span>{" "}
                <span className="font-mono tabular-nums">{user.liveSessions}</span>
              </span>
              <span>
                <span className="text-neutral-500">total:</span>{" "}
                <span className="font-mono tabular-nums">{user.totalSessions}</span>
              </span>
              <span>
                <span className="text-neutral-500">duration:</span>{" "}
                <span className="font-mono tabular-nums">{sessionDuration}</span>
              </span>
              <span>
                <span className="text-neutral-500">last beat:</span>{" "}
                <span className="font-mono tabular-nums">{lastSeen}</span>
              </span>
            </div>
            {user.sessions.length > 0 && (
              <ul className="mt-3 space-y-1.5 border-l border-neutral-800 pl-3">
                {user.sessions.map((s) => (
                  <li key={s.presenceId} className="flex items-center gap-2 text-[11px]">
                    <DeviceGlyph ua={s.userAgent} />
                    <span className="truncate font-mono text-neutral-300">
                      {s.currentPath ?? "—"}
                    </span>
                    <span className="ml-auto flex-shrink-0 text-neutral-500">
                      {formatDuration(now - s.connectedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </button>
    </li>
  );
}

function ActivityListItem({ row, now }: { row: ActivityRow; now: number }) {
  const ago = formatRelative(now - row.at);
  const detailText = row.detail ? formatDetail(row.detail) : null;
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <span className="mt-1.5 flex-shrink-0">
        <Circle
          className={`h-2 w-2 ${
            row.kind === "action" ? "fill-amber-400 text-amber-400" : "fill-sky-400 text-sky-400"
          }`}
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm text-neutral-200">
            <span className="text-neutral-400">{row.userName}</span>{" "}
            <span className="text-neutral-500">
              {row.kind === "page_visit" ? "visited" : "did"}
            </span>{" "}
            <span className="font-mono">{row.label}</span>
          </span>
          <span className="flex-shrink-0 text-[10px] tabular-nums text-neutral-500">
            {ago}
          </span>
        </div>
        {detailText && (
          <p className="mt-0.5 truncate font-mono text-[10px] text-neutral-500">
            {detailText}
          </p>
        )}
      </div>
    </li>
  );
}

function DeviceGlyph({ ua }: { ua: string | null }) {
  const isMobile = !!ua && /Mobile|Android|iPhone|iPad/i.test(ua);
  const Glyph = isMobile ? Smartphone : Monitor;
  const label = uaShort(ua);
  return (
    <span className="flex items-center gap-1 text-neutral-500" title={ua ?? ""}>
      <Glyph className="h-3 w-3" />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

function uaShort(ua: string | null): string {
  if (!ua) return "unknown";
  if (/Edg\//.test(ua)) return "Edge";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Safari\//.test(ua)) return "Safari";
  return "browser";
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function formatRelative(ms: number): string {
  if (ms < 0) ms = 0;
  if (ms < 5_000) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatDetail(detail: unknown): string {
  try {
    const s = typeof detail === "string" ? detail : JSON.stringify(detail);
    return s.length > 160 ? s.slice(0, 157) + "…" : s;
  } catch {
    return "";
  }
}
