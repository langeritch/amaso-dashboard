import { getDb } from "./db";

/**
 * Super-user activity tracking helpers.
 *
 * Presence model: one row per live browser tab, identified by a random
 * `client_id` the tracker generates on first mount (and persists in
 * sessionStorage so reloads stay attached to the same row). The
 * heartbeat ping bumps `last_seen_at`; a row whose last_seen is older
 * than `OFFLINE_AFTER_MS` counts as ended for "currently online" but
 * is kept on disk for historical session counts.
 *
 * Activity model: append-only log keyed by user_id (and optionally the
 * presence row id). Two kinds:
 *   - "page_visit" — emitted by the tracker on every route change.
 *   - "action"     — emitted by callers via trackAction() helpers when
 *                    a notable feature is used (call started, dispatch
 *                    fired, deploy run, etc.).
 *
 * Threading: better-sqlite3 is synchronous and single-process, so no
 * locking dance is needed. The presence upsert is a single statement.
 */

export const PRESENCE_HEARTBEAT_MS = 30_000;
// Tab is "online" if its last heartbeat is within ~3× the heartbeat
// cadence — covers a missed beat without lying about presence.
export const OFFLINE_AFTER_MS = 90_000;

export interface PresenceRow {
  id: number;
  userId: number;
  clientId: string;
  connectedAt: number;
  lastSeenAt: number;
  currentPath: string | null;
  userAgent: string | null;
}

interface PresenceDbRow {
  id: number;
  user_id: number;
  client_id: string;
  connected_at: number;
  last_seen_at: number;
  current_path: string | null;
  user_agent: string | null;
}

function rowToPresence(r: PresenceDbRow): PresenceRow {
  return {
    id: r.id,
    userId: r.user_id,
    clientId: r.client_id,
    connectedAt: r.connected_at,
    lastSeenAt: r.last_seen_at,
    currentPath: r.current_path,
    userAgent: r.user_agent,
  };
}

/** Upsert a presence row keyed on (user_id, client_id). Returns the
 *  row, including whether `current_path` actually changed (so the
 *  caller can decide to log a page_visit event). */
export function upsertPresence(opts: {
  userId: number;
  clientId: string;
  path: string | null;
  userAgent: string | null;
  now?: number;
}): { presence: PresenceRow; pathChanged: boolean } {
  const now = opts.now ?? Date.now();
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id, user_id, client_id, connected_at, last_seen_at, current_path, user_agent
         FROM user_presence WHERE user_id = ? AND client_id = ?`,
    )
    .get(opts.userId, opts.clientId) as PresenceDbRow | undefined;

  if (!existing) {
    const info = db
      .prepare(
        `INSERT INTO user_presence
           (user_id, client_id, connected_at, last_seen_at, current_path, user_agent)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.userId,
        opts.clientId,
        now,
        now,
        opts.path,
        opts.userAgent,
      );
    const fresh = db
      .prepare(
        `SELECT id, user_id, client_id, connected_at, last_seen_at, current_path, user_agent
           FROM user_presence WHERE id = ?`,
      )
      .get(Number(info.lastInsertRowid)) as PresenceDbRow;
    return { presence: rowToPresence(fresh), pathChanged: opts.path !== null };
  }

  const pathChanged =
    opts.path !== null && opts.path !== existing.current_path;
  db.prepare(
    `UPDATE user_presence
        SET last_seen_at = ?,
            current_path = COALESCE(?, current_path),
            user_agent = COALESCE(?, user_agent)
      WHERE id = ?`,
  ).run(now, opts.path, opts.userAgent, existing.id);
  const refreshed: PresenceRow = {
    id: existing.id,
    userId: existing.user_id,
    clientId: existing.client_id,
    connectedAt: existing.connected_at,
    lastSeenAt: now,
    currentPath: opts.path ?? existing.current_path,
    userAgent: opts.userAgent ?? existing.user_agent,
  };
  return { presence: refreshed, pathChanged };
}

export function recordActivity(opts: {
  userId: number;
  presenceId: number | null;
  kind: "page_visit" | "action";
  label: string;
  detail?: unknown;
  at?: number;
}): void {
  const at = opts.at ?? Date.now();
  const detail =
    opts.detail === undefined ? null : JSON.stringify(opts.detail);
  getDb()
    .prepare(
      `INSERT INTO user_activity (user_id, presence_id, kind, label, detail, at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(opts.userId, opts.presenceId, opts.kind, opts.label, detail, at);
}

export interface OnlineUserSummary {
  userId: number;
  name: string;
  email: string;
  role: string;
  /** Number of live tabs for this user. */
  liveSessions: number;
  /** Total number of presence rows ever recorded for this user
   *  (rough proxy for "how many times have they shown up"). */
  totalSessions: number;
  /** Earliest connected_at across this user's currently-live sessions. */
  oldestConnectedAt: number;
  /** Most recent heartbeat across this user's currently-live sessions. */
  latestSeenAt: number;
  /** Per-tab breakdown for the panel. */
  sessions: Array<{
    presenceId: number;
    clientId: string;
    connectedAt: number;
    lastSeenAt: number;
    currentPath: string | null;
    userAgent: string | null;
  }>;
}

export function listOnlineUsers(now: number = Date.now()): OnlineUserSummary[] {
  const cutoff = now - OFFLINE_AFTER_MS;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.id, p.user_id, p.client_id, p.connected_at, p.last_seen_at,
              p.current_path, p.user_agent,
              u.name AS user_name, u.email AS user_email, u.role AS user_role
         FROM user_presence p
         JOIN users u ON u.id = p.user_id
        WHERE p.last_seen_at >= ?
        ORDER BY p.last_seen_at DESC`,
    )
    .all(cutoff) as Array<
    PresenceDbRow & {
      user_name: string;
      user_email: string;
      user_role: string;
    }
  >;

  const totalsRows = db
    .prepare(
      `SELECT user_id, COUNT(*) AS total
         FROM user_presence
        GROUP BY user_id`,
    )
    .all() as Array<{ user_id: number; total: number }>;
  const totals = new Map<number, number>(
    totalsRows.map((r) => [r.user_id, r.total]),
  );

  const grouped = new Map<number, OnlineUserSummary>();
  for (const r of rows) {
    let entry = grouped.get(r.user_id);
    if (!entry) {
      entry = {
        userId: r.user_id,
        name: r.user_name,
        email: r.user_email,
        role: r.user_role,
        liveSessions: 0,
        totalSessions: totals.get(r.user_id) ?? 0,
        oldestConnectedAt: r.connected_at,
        latestSeenAt: r.last_seen_at,
        sessions: [],
      };
      grouped.set(r.user_id, entry);
    }
    entry.liveSessions += 1;
    if (r.connected_at < entry.oldestConnectedAt) {
      entry.oldestConnectedAt = r.connected_at;
    }
    if (r.last_seen_at > entry.latestSeenAt) {
      entry.latestSeenAt = r.last_seen_at;
    }
    entry.sessions.push({
      presenceId: r.id,
      clientId: r.client_id,
      connectedAt: r.connected_at,
      lastSeenAt: r.last_seen_at,
      currentPath: r.current_path,
      userAgent: r.user_agent,
    });
  }
  // Most-recently-active users first.
  return [...grouped.values()].sort(
    (a, b) => b.latestSeenAt - a.latestSeenAt,
  );
}

export interface ActivityRow {
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

export function listRecentActivity(limit: number = 200): ActivityRow[] {
  const rows = getDb()
    .prepare(
      `SELECT a.id, a.user_id, a.presence_id, a.kind, a.label, a.detail, a.at,
              u.name AS user_name, u.email AS user_email
         FROM user_activity a
         JOIN users u ON u.id = a.user_id
        ORDER BY a.at DESC
        LIMIT ?`,
    )
    .all(Math.max(1, Math.min(1000, limit))) as Array<{
    id: number;
    user_id: number;
    presence_id: number | null;
    kind: "page_visit" | "action";
    label: string;
    detail: string | null;
    at: number;
    user_name: string;
    user_email: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    userEmail: r.user_email,
    presenceId: r.presence_id,
    kind: r.kind,
    label: r.label,
    detail: r.detail ? safeParse(r.detail) : null,
    at: r.at,
  }));
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
