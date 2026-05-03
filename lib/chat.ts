import { getDb } from "./db";
import { loadConfig } from "./config";
import { canAccessProject, visibleProjects } from "./access";
import { chatAttachmentsByMessage } from "./attachments";
import type { User } from "./db";

export type ChannelKind = "general" | "project" | "dm";

export interface ChannelRow {
  id: number;
  kind: ChannelKind;
  project_id: string | null;
  name: string | null;
  created_at: number;
}

export interface ChannelView {
  id: number;
  kind: ChannelKind;
  projectId: string | null;
  projectName?: string | null;
  name: string;
  /** For DMs: the peer user (not the current user). */
  peer?: { id: number; name: string; email: string };
  createdAt: number;
}

export interface MessageRow {
  id: number;
  channel_id: number;
  user_id: number;
  kind: "text" | "ai_session" | "system";
  body: string;
  meta: string | null;
  created_at: number;
}

export interface ChatAttachmentView {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MessageView {
  id: number;
  channelId: number;
  userId: number;
  userName: string;
  kind: "text" | "ai_session" | "system";
  body: string;
  meta: Record<string, unknown> | null;
  createdAt: number;
  attachments?: ChatAttachmentView[];
}

function safeJson(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Ensure a channel row exists for every project this user can see. */
export function ensureProjectChannels(user: User): void {
  const db = getDb();
  const projects = visibleProjects(user);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO chat_channels (kind, project_id, name, created_at) VALUES ('project', ?, ?, ?)",
  );
  const now = Date.now();
  const tx = db.transaction(() => {
    for (const p of projects) insert.run(p.id, p.name, now);
  });
  tx();
}

/** Channels visible to this user: general + all project channels they can access + DMs they're in. */
export function listChannelsForUser(user: User): ChannelView[] {
  ensureProjectChannels(user);
  const db = getDb();
  const cfg = loadConfig();
  const projectNameById = new Map(cfg.projects.map((p) => [p.id, p.name]));

  const rows = db
    .prepare(
      `SELECT c.id, c.kind, c.project_id, c.name, c.created_at
         FROM chat_channels c
        WHERE c.kind = 'general'
           OR (c.kind = 'project')
           OR (c.kind = 'dm' AND c.id IN (
               SELECT channel_id FROM chat_channel_members WHERE user_id = ?
             ))
        ORDER BY c.kind, c.created_at`,
    )
    .all(user.id) as ChannelRow[];

  const out: ChannelView[] = [];
  for (const r of rows) {
    if (r.kind === "project") {
      if (!r.project_id || !canAccessProject(user, r.project_id)) continue;
      out.push({
        id: r.id,
        kind: "project",
        projectId: r.project_id,
        projectName: projectNameById.get(r.project_id) ?? r.project_id,
        name: projectNameById.get(r.project_id) ?? r.name ?? r.project_id,
        createdAt: r.created_at,
      });
    } else if (r.kind === "general") {
      out.push({
        id: r.id,
        kind: "general",
        projectId: null,
        name: r.name ?? "General",
        createdAt: r.created_at,
      });
    } else if (r.kind === "dm") {
      const peer = db
        .prepare(
          `SELECT u.id, u.name, u.email
             FROM chat_channel_members m JOIN users u ON u.id = m.user_id
            WHERE m.channel_id = ? AND m.user_id != ?
            LIMIT 1`,
        )
        .get(r.id, user.id) as
        | { id: number; name: string; email: string }
        | undefined;
      if (!peer) continue;
      out.push({
        id: r.id,
        kind: "dm",
        projectId: null,
        name: peer.name,
        peer,
        createdAt: r.created_at,
      });
    }
  }
  return out;
}

/** Get or create a 1-1 DM channel between two users. */
export function getOrCreateDm(userA: number, userB: number): number {
  if (userA === userB) throw new Error("cannot_dm_self");
  const db = getDb();
  const [lo, hi] = userA < userB ? [userA, userB] : [userB, userA];
  const existing = db
    .prepare(
      `SELECT c.id FROM chat_channels c
        WHERE c.kind = 'dm'
          AND EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = c.id AND user_id = ?)
          AND EXISTS (SELECT 1 FROM chat_channel_members WHERE channel_id = c.id AND user_id = ?)
          AND (SELECT COUNT(*) FROM chat_channel_members WHERE channel_id = c.id) = 2
        LIMIT 1`,
    )
    .get(lo, hi) as { id: number } | undefined;
  if (existing) return existing.id;

  const now = Date.now();
  const result = db
    .prepare(
      "INSERT INTO chat_channels (kind, project_id, name, created_at) VALUES ('dm', NULL, NULL, ?)",
    )
    .run(now);
  const channelId = Number(result.lastInsertRowid);
  const ins = db.prepare(
    "INSERT INTO chat_channel_members (channel_id, user_id) VALUES (?, ?)",
  );
  db.transaction(() => {
    ins.run(channelId, lo);
    ins.run(channelId, hi);
  })();
  return channelId;
}

/** Return true if this user may read + post in the given channel. */
export function canUseChannel(user: User, channelId: number): ChannelRow | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, kind, project_id, name, created_at FROM chat_channels WHERE id = ?",
    )
    .get(channelId) as ChannelRow | undefined;
  if (!row) return null;
  if (row.kind === "general") return row;
  if (row.kind === "project") {
    if (!row.project_id) return null;
    return canAccessProject(user, row.project_id) ? row : null;
  }
  // dm
  const member = db
    .prepare(
      "SELECT 1 FROM chat_channel_members WHERE channel_id = ? AND user_id = ?",
    )
    .get(channelId, user.id);
  return member ? row : null;
}

export function listMessages(channelId: number, limit = 200): MessageView[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT m.id, m.channel_id, m.user_id, m.kind, m.body, m.meta, m.created_at,
              u.name AS user_name
         FROM chat_messages m JOIN users u ON u.id = m.user_id
        WHERE m.channel_id = ?
        ORDER BY m.created_at DESC
        LIMIT ?`,
    )
    .all(channelId, limit) as (MessageRow & { user_name: string })[];
  const attachments = chatAttachmentsByMessage(rows.map((r) => r.id));
  return rows
    .map((r) => ({
      id: r.id,
      channelId: r.channel_id,
      userId: r.user_id,
      userName: r.user_name,
      kind: r.kind,
      body: r.body,
      meta: safeJson(r.meta),
      createdAt: r.created_at,
      attachments: attachments.get(r.id) ?? [],
    }))
    .reverse();
}

/** Per-channel unread counts for a user — only counts messages from OTHER
 *  people posted after the user's last_seen_at for that channel. Missing
 *  read rows default to 0 (everything unread), but the migration backfill
 *  seeds one at install time so new rollouts don't spike. */
export function getUnreadForUser(user: User): {
  byChannel: Record<number, number>;
  total: number;
} {
  const channels = listChannelsForUser(user);
  if (channels.length === 0) return { byChannel: {}, total: 0 };
  const db = getDb();
  const stmt = db.prepare(
    `SELECT COUNT(*) AS n
       FROM chat_messages m
       LEFT JOIN chat_channel_reads r
         ON r.user_id = ? AND r.channel_id = m.channel_id
      WHERE m.channel_id = ?
        AND m.user_id   != ?
        AND m.created_at > COALESCE(r.last_seen_at, 0)`,
  );
  const byChannel: Record<number, number> = {};
  let total = 0;
  for (const ch of channels) {
    const row = stmt.get(user.id, ch.id, user.id) as { n: number };
    if (row.n > 0) {
      byChannel[ch.id] = row.n;
      total += row.n;
    }
  }
  return { byChannel, total };
}

/** Return the user_ids that should be notified when a new message lands
 *  in the given channel. Excludes the sender. Respects visibility:
 *    general → every user
 *    project → every user with project access (admin/team implicitly, clients
 *              via project_access rows)
 *    dm      → the other member of the pair
 */
export function recipientsForChannel(
  channelId: number,
  senderId: number,
): number[] {
  const db = getDb();
  const ch = db
    .prepare(
      "SELECT id, kind, project_id FROM chat_channels WHERE id = ?",
    )
    .get(channelId) as
    | { id: number; kind: ChannelKind; project_id: string | null }
    | undefined;
  if (!ch) return [];

  if (ch.kind === "dm") {
    const rows = db
      .prepare(
        "SELECT user_id FROM chat_channel_members WHERE channel_id = ? AND user_id != ?",
      )
      .all(channelId, senderId) as { user_id: number }[];
    return rows.map((r) => r.user_id);
  }

  if (ch.kind === "general") {
    const rows = db
      .prepare("SELECT id FROM users WHERE id != ?")
      .all(senderId) as { id: number }[];
    return rows.map((r) => r.id);
  }

  if (ch.kind === "project" && ch.project_id) {
    // admins + team users see every project; clients only their granted ones.
    const rows = db
      .prepare(
        `SELECT u.id, u.role
           FROM users u
          WHERE u.id != ?
            AND (
              u.role IN ('admin','team')
              OR (u.role = 'client' AND EXISTS (
                SELECT 1 FROM project_access pa
                 WHERE pa.user_id = u.id AND pa.project_id = ?
              ))
            )`,
      )
      .all(senderId, ch.project_id) as { id: number; role: string }[];
    return rows.map((r) => r.id);
  }

  return [];
}

/** Mark a channel read up to `ts` (defaults to now). Idempotent. */
export function markChannelRead(
  userId: number,
  channelId: number,
  ts?: number,
): void {
  const db = getDb();
  const when = ts ?? Date.now();
  db.prepare(
    `INSERT INTO chat_channel_reads (user_id, channel_id, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, channel_id)
     DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
  ).run(userId, channelId, when);
}

export function insertMessage(
  channelId: number,
  userId: number,
  body: string,
  kind: "text" | "ai_session" | "system" = "text",
  meta: Record<string, unknown> | null = null,
): MessageView {
  const db = getDb();
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO chat_messages (channel_id, user_id, kind, body, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(channelId, userId, kind, body, meta ? JSON.stringify(meta) : null, now);
  const id = Number(result.lastInsertRowid);
  const user = db
    .prepare("SELECT name FROM users WHERE id = ?")
    .get(userId) as { name: string };
  return {
    id,
    channelId,
    userId,
    userName: user.name,
    kind,
    body,
    meta,
    createdAt: now,
  };
}
