// Cross-team activity feed. Joins four data sources into a single
// reverse-chronological timeline, plus a per-user summary used by the
// People cards on /activity:
//
//   1. Dispatches  — recentDispatchesAllUsers from the in-memory log.
//   2. Remarks     — created/resolved events from the remarks table
//                    (one row produces up to two events).
//   3. File changes — getHistory().recent(projectId) per configured
//                    project, capped per-project so a hot watcher
//                    burst doesn't drown the rest of the feed.
//   4. Presence    — listOnlineUsers (drives the people-card "online"
//                    dot) and listRecentActivity (recent page-visit /
//                    action rows).
//
// Admin-gated rather than super-user — the existing /api/admin/activity
// stays super-user-only because it exposes per-tab session info that
// isn't relevant here. This endpoint surfaces team-wide activity
// counts + project context, no per-tab leaks.
//
// No WebSocket: 5-second polling on the client is plenty for a
// "what's been happening" view, and skips a whole layer of bus
// plumbing.

import { NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import { loadConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { getHistory } from "@/lib/history";
import {
  listOnlineUsers,
  listRecentActivity,
  OFFLINE_AFTER_MS,
} from "@/lib/presence";
import { recentDispatchesAllUsers } from "@/lib/spar-dispatch";

export const dynamic = "force-dynamic";

interface FeedItem {
  /** Stable composite id so the React key is deterministic across polls. */
  id: string;
  kind:
    | "dispatch"
    | "dispatch_completed"
    | "remark_created"
    | "remark_resolved"
    | "file_change"
    | "presence";
  ts: number;
  /** Project id when the event is project-scoped, null otherwise. */
  projectId: string | null;
  /** Friendly display name resolved server-side so the client doesn't
   *  need a project lookup table. Falls back to the raw id. */
  projectName: string | null;
  /** User who triggered the event when known. null for anonymous /
   *  system-driven events (file watcher, build/restart). */
  userId: number | null;
  userName: string | null;
  /** One-line summary suitable as a list row's main label. */
  summary: string;
  /** Optional structured payload — kind-specific extras the UI can
   *  surface inline (status, path, etc.). */
  detail?: Record<string, unknown>;
}

interface PeopleCard {
  userId: number;
  name: string;
  email: string;
  role: string;
  /** Activity events attributed to this user across the feed window. */
  activityCount: number;
  /** Most recent timestamp across any data source. */
  lastActiveAt: number | null;
  /** True if the user has at least one tab heartbeat within
   *  OFFLINE_AFTER_MS — matches the rest of the dashboard's online
   *  semantics (see lib/presence.ts). */
  online: boolean;
}

const FEED_LIMIT = 200;
const REMARKS_LIMIT = 80;
const PER_PROJECT_FILE_CHANGE_LIMIT = 20;

interface RemarkRow {
  id: number;
  user_id: number;
  project_id: string;
  path: string | null;
  body: string;
  created_at: number;
  updated_at: number | null;
  resolved_at: number | null;
  user_name: string | null;
}

function projectNameMap(): Map<string, string> {
  try {
    const cfg = loadConfig();
    return new Map(cfg.projects.map((p) => [p.id, p.name]));
  } catch {
    return new Map();
  }
}

function summarisePrompt(prompt: string, max = 140): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1).trimEnd() + "…";
}

export async function GET() {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;

  const now = Date.now();
  const names = projectNameMap();
  const items: FeedItem[] = [];

  // 1. Dispatches across all users — both the firing event and the
  //    completion event when the terminal eventually goes idle.
  const dispatches = recentDispatchesAllUsers(80);
  const dispatchUserNames = new Map<number, string>();
  for (const { userId } of dispatches) {
    if (!dispatchUserNames.has(userId)) {
      const u = getDb()
        .prepare("SELECT name FROM users WHERE id = ?")
        .get(userId) as { name: string } | undefined;
      if (u) dispatchUserNames.set(userId, u.name);
    }
  }
  for (const { userId, entry } of dispatches) {
    const projectName = names.get(entry.projectId) ?? entry.projectId;
    items.push({
      id: `dispatch:${entry.id}`,
      kind: "dispatch",
      ts: entry.confirmedAt,
      projectId: entry.projectId,
      projectName,
      userId,
      userName: dispatchUserNames.get(userId) ?? null,
      summary: summarisePrompt(entry.prompt, 160),
      detail: {
        status: entry.status,
        ...(entry.error ? { error: entry.error } : {}),
      },
    });
    if (entry.completedAt && entry.completedAt > entry.confirmedAt) {
      items.push({
        id: `dispatch_completed:${entry.id}`,
        kind: "dispatch_completed",
        ts: entry.completedAt,
        projectId: entry.projectId,
        projectName,
        userId,
        userName: dispatchUserNames.get(userId) ?? null,
        summary: `Finished — ${summarisePrompt(entry.prompt, 120)}`,
        detail: {
          tookMs: entry.completedAt - entry.confirmedAt,
        },
      });
    }
  }

  // 2. Remarks — both creation and resolution count as separate feed
  //    events. Pulling the join in a single query keeps the round-trips
  //    bounded; the LIMIT caps blast radius if someone has hundreds of
  //    open remarks.
  const remarkRows = getDb()
    .prepare(
      `SELECT r.id, r.user_id, r.project_id, r.path, r.body,
              r.created_at, r.updated_at, r.resolved_at,
              u.name AS user_name
         FROM remarks r
         LEFT JOIN users u ON u.id = r.user_id
        ORDER BY COALESCE(r.resolved_at, r.updated_at, r.created_at) DESC
        LIMIT ?`,
    )
    .all(REMARKS_LIMIT) as RemarkRow[];
  for (const r of remarkRows) {
    const projectName = names.get(r.project_id) ?? r.project_id;
    const bodySnippet = summarisePrompt(r.body, 160);
    items.push({
      id: `remark_created:${r.id}`,
      kind: "remark_created",
      ts: r.created_at,
      projectId: r.project_id,
      projectName,
      userId: r.user_id,
      userName: r.user_name,
      summary: bodySnippet,
      detail: r.path ? { path: r.path } : undefined,
    });
    if (r.resolved_at) {
      items.push({
        id: `remark_resolved:${r.id}`,
        kind: "remark_resolved",
        ts: r.resolved_at,
        projectId: r.project_id,
        projectName,
        userId: r.user_id,
        userName: r.user_name,
        summary: `Resolved: ${bodySnippet}`,
        detail: r.path ? { path: r.path } : undefined,
      });
    }
  }

  // 3. File changes per configured project. The watcher's history is
  //    in-memory and capped per project, so iterating is O(projects ×
  //    PER_PROJECT_FILE_CHANGE_LIMIT) — bounded and fast. We don't
  //    expose previous/current diff bodies here; the feed only needs
  //    the path + change type.
  let cfgProjects: ReturnType<typeof loadConfig>["projects"] = [];
  try {
    cfgProjects = loadConfig().projects;
  } catch {
    /* config read failure already surfaces elsewhere */
  }
  const history = getHistory();
  for (const project of cfgProjects) {
    const events = history.recent(project.id, PER_PROJECT_FILE_CHANGE_LIMIT);
    for (const e of events) {
      items.push({
        id: `file:${project.id}:${e.id}`,
        kind: "file_change",
        ts: e.ts,
        projectId: project.id,
        projectName: project.name,
        userId: null,
        userName: null,
        summary: `${e.type} ${e.path}`,
        detail: { type: e.type, path: e.path },
      });
    }
  }

  // 4. Presence-driven activity rows (page visits, recorded actions).
  //    Folded in so the feed's "most recent" sort surfaces who's
  //    poking around right now, not just who shipped code.
  const recentActivity = listRecentActivity(150);
  for (const a of recentActivity) {
    // Page visits to /projects/<id> get the project tagged so the
    // feed row carries the same chip as everything else.
    let pId: string | null = null;
    let pName: string | null = null;
    const projMatch =
      typeof a.label === "string" ? a.label.match(/^\/projects\/([^/?#]+)/) : null;
    if (projMatch) {
      pId = projMatch[1] ?? null;
      pName = pId ? (names.get(pId) ?? pId) : null;
    }
    items.push({
      id: `presence:${a.id}`,
      kind: "presence",
      ts: a.at,
      projectId: pId,
      projectName: pName,
      userId: a.userId,
      userName: a.userName,
      summary: a.label,
      detail: { presenceKind: a.kind },
    });
  }

  // Newest-first; cap so a chatty watcher run can't push older
  // dispatches out of view entirely (they're still in the response,
  // just below the cap).
  items.sort((a, b) => b.ts - a.ts);
  const feed = items.slice(0, FEED_LIMIT);

  // People cards — every user who appears in the feed window OR is
  // currently online. Activity count = number of feed events
  // attributed to them. lastActiveAt = most recent ts across all of
  // their events + their latest presence heartbeat.
  const online = listOnlineUsers(now);
  const onlineMap = new Map(online.map((u) => [u.userId, u]));
  const peopleAcc = new Map<number, PeopleCard>();
  function ensure(
    userId: number,
    name: string | null,
    email: string,
    role: string,
  ): PeopleCard {
    let p = peopleAcc.get(userId);
    if (!p) {
      p = {
        userId,
        name: name ?? `user-${userId}`,
        email,
        role,
        activityCount: 0,
        lastActiveAt: null,
        online: false,
      };
      peopleAcc.set(userId, p);
    }
    return p;
  }
  // Seed cards from anyone currently online so the row shows even
  // when they haven't fired a feed event recently.
  for (const u of online) {
    const p = ensure(u.userId, u.name, u.email, u.role);
    p.online = true;
    if (u.latestSeenAt > (p.lastActiveAt ?? 0)) {
      p.lastActiveAt = u.latestSeenAt;
    }
  }
  // Then walk the feed for activity attribution. We need email/role
  // for users who appear in the feed but aren't online — fetch in one
  // batch to keep this O(1) DB round-trip.
  const feedUserIds = new Set<number>();
  for (const it of feed) {
    if (typeof it.userId === "number") feedUserIds.add(it.userId);
  }
  if (feedUserIds.size > 0) {
    const placeholders = [...feedUserIds].map(() => "?").join(",");
    const userRows = getDb()
      .prepare(
        `SELECT id, name, email, role FROM users WHERE id IN (${placeholders})`,
      )
      .all(...feedUserIds) as Array<{
      id: number;
      name: string;
      email: string;
      role: string;
    }>;
    for (const u of userRows) {
      // Don't overwrite the online-derived card; just make sure it
      // exists with proper email/role for offline users.
      if (!peopleAcc.has(u.id)) {
        ensure(u.id, u.name, u.email, u.role);
      }
    }
  }
  for (const it of feed) {
    if (typeof it.userId !== "number") continue;
    const p = peopleAcc.get(it.userId);
    if (!p) continue;
    p.activityCount += 1;
    if (it.ts > (p.lastActiveAt ?? 0)) {
      p.lastActiveAt = it.ts;
    }
  }
  const people = [...peopleAcc.values()].sort((a, b) => {
    // Online first, then by recency.
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0);
  });

  return NextResponse.json({
    now,
    feed,
    people,
    onlineThresholdMs: OFFLINE_AFTER_MS,
  });
}
