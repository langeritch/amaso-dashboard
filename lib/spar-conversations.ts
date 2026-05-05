import { getDb } from "./db";

/**
 * Server-side persistence for the spar chat. Conversations are scoped
 * per user: the spar page lists everyone's own threads in the
 * sidebar, hydrates the most recent on load, and appends each turn
 * here as it streams. Lives next to lib/db.ts so the schema migration
 * stays in one place — see `spar_conversations` / `spar_messages` in
 * the migrate() block.
 */

export type SparMessageRole = "user" | "assistant" | "system";

export interface SparConversationRow {
  id: number;
  userId: number;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  /** Soft notice surfaced in the chat when Haiku decides the thread
   *  has drifted from its title — drives a dismissible "maybe start a
   *  new chat" banner. NULL when nothing to flag. */
  driftNotice: string | null;
  /** True once the server's auto-namer has set the title. While
   *  false, the auto-namer is allowed to (re-)title; once true and
   *  the user has explicitly renamed (TODO: surface a rename UI),
   *  the auto-namer stays out. */
  autoNamed: boolean;
  /** Assistant message count at the moment of the last successful
   *  (re-)naming. Lets the trigger logic skip a slot it already
   *  honoured, so two tabs racing on the same turn can't double-fire
   *  the rename. */
  lastNamedAtCount: number;
  /** message count — populated by listConversations for the sidebar
   *  preview without forcing a second round-trip. Undefined elsewhere. */
  messageCount?: number;
  /** Preview of the latest user message — same idea as messageCount,
   *  populated lazily. */
  preview?: string | null;
}

export interface SparMessageRow {
  id: number;
  conversationId: number;
  role: SparMessageRole;
  content: string;
  /** Tool steps the assistant emitted on this turn (label/detail/
   *  status/summary). Stored as JSON so a hydrating client can re-paint
   *  the same step cards without hitting the streaming endpoint again. */
  toolCalls: unknown | null;
  createdAt: number;
}

const TITLE_MAX_CHARS = 80;

function deriveTitle(firstMessage: string | null): string {
  if (!firstMessage) return "New conversation";
  const cleaned = firstMessage.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New conversation";
  if (cleaned.length <= TITLE_MAX_CHARS) return cleaned;
  return cleaned.slice(0, TITLE_MAX_CHARS - 1).trimEnd() + "…";
}

interface RawConvRow {
  id: number;
  user_id: number;
  title: string | null;
  created_at: number;
  updated_at: number;
  drift_notice: string | null;
  auto_named: number;
  last_named_at_count: number;
}

interface RawMsgRow {
  id: number;
  conversation_id: number;
  role: SparMessageRole;
  content: string;
  tool_calls: string | null;
  created_at: number;
}

function rowToConv(r: RawConvRow): SparConversationRow {
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    driftNotice: r.drift_notice ?? null,
    autoNamed: !!r.auto_named,
    lastNamedAtCount: r.last_named_at_count ?? 0,
  };
}

function rowToMsg(r: RawMsgRow): SparMessageRow {
  let toolCalls: unknown | null = null;
  if (r.tool_calls) {
    try {
      toolCalls = JSON.parse(r.tool_calls);
    } catch {
      toolCalls = null;
    }
  }
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    toolCalls,
    createdAt: r.created_at,
  };
}

export function createConversation(userId: number, title?: string | null): SparConversationRow {
  const db = getDb();
  const now = Date.now();
  const info = db
    .prepare(
      "INSERT INTO spar_conversations (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(userId, title ?? null, now, now);
  return {
    id: Number(info.lastInsertRowid),
    userId,
    title: title ?? null,
    createdAt: now,
    updatedAt: now,
    driftNotice: null,
    autoNamed: false,
    lastNamedAtCount: 0,
  };
}

const CONV_COLS =
  "id, user_id, title, created_at, updated_at, drift_notice, auto_named, last_named_at_count";

export function listConversations(userId: number, limit = 100): SparConversationRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.id, c.user_id, c.title, c.created_at, c.updated_at,
              c.drift_notice, c.auto_named, c.last_named_at_count,
              (SELECT COUNT(*) FROM spar_messages m WHERE m.conversation_id = c.id) AS msg_count,
              (SELECT content FROM spar_messages m
                 WHERE m.conversation_id = c.id
                 ORDER BY m.id DESC LIMIT 1) AS last_content
         FROM spar_conversations c
         WHERE c.user_id = ?
         ORDER BY c.updated_at DESC
         LIMIT ?`,
    )
    .all(userId, limit) as Array<RawConvRow & { msg_count: number; last_content: string | null }>;
  return rows.map((r) => ({
    ...rowToConv(r),
    messageCount: r.msg_count,
    preview: r.last_content
      ? r.last_content.replace(/\s+/g, " ").trim().slice(0, 140)
      : null,
  }));
}

export function getConversation(userId: number, conversationId: number): SparConversationRow | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT ${CONV_COLS} FROM spar_conversations WHERE id = ? AND user_id = ?`,
    )
    .get(conversationId, userId) as RawConvRow | undefined;
  return row ? rowToConv(row) : null;
}

export function getMessages(conversationId: number): SparMessageRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, conversation_id, role, content, tool_calls, created_at FROM spar_messages WHERE conversation_id = ? ORDER BY id ASC",
    )
    .all(conversationId) as RawMsgRow[];
  return rows.map(rowToMsg);
}

export interface AppendMessageInput {
  conversationId: number;
  userId: number;
  role: SparMessageRole;
  content: string;
  toolCalls?: unknown | null;
}

/**
 * Append a single message and bump the parent conversation's
 * updated_at. Refuses to write if the conversation isn't owned by the
 * supplied user — keeps cross-user writes from sneaking in via the
 * /messages POST. Returns null on ownership mismatch / unknown id;
 * callers translate that to a 404 / 403.
 *
 * Until the smart auto-namer fires (after the first assistant turn),
 * the title is left as a deterministic snippet of the user's first
 * message so a refreshing sidebar isn't full of "New chat" rows
 * staring back. setConversationTitle() overwrites this once Haiku
 * has named the thread; the auto_named flag flips to lock further
 * heuristic backfills out.
 */
export function appendMessage(input: AppendMessageInput): SparMessageRow | null {
  const db = getDb();
  const conv = db
    .prepare(
      "SELECT id, user_id, title, auto_named FROM spar_conversations WHERE id = ? AND user_id = ?",
    )
    .get(input.conversationId, input.userId) as
    | { id: number; user_id: number; title: string | null; auto_named: number }
    | undefined;
  if (!conv) return null;
  const now = Date.now();
  const toolCallsJson =
    input.toolCalls === undefined || input.toolCalls === null
      ? null
      : JSON.stringify(input.toolCalls);
  let row: SparMessageRow | null = null;
  db.transaction(() => {
    const info = db
      .prepare(
        "INSERT INTO spar_messages (conversation_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(conv.id, input.role, input.content, toolCallsJson, now);
    const id = Number(info.lastInsertRowid);
    if (
      !conv.title &&
      !conv.auto_named &&
      input.role === "user" &&
      input.content.trim()
    ) {
      // Provisional title from the user's words. The auto-namer
      // upgrades this within a few seconds; this just gives the
      // sidebar something readable to render in the meantime.
      db.prepare(
        "UPDATE spar_conversations SET title = ?, updated_at = ? WHERE id = ?",
      ).run(deriveTitle(input.content), now, conv.id);
    } else {
      db.prepare("UPDATE spar_conversations SET updated_at = ? WHERE id = ?").run(
        now,
        conv.id,
      );
    }
    row = {
      id,
      conversationId: conv.id,
      role: input.role,
      content: input.content,
      toolCalls: input.toolCalls ?? null,
      createdAt: now,
    };
  })();
  return row;
}

/** Overwrite the title from the auto-namer. Stamps `auto_named=1` so
 *  future heuristic backfills stay out of the way and records the
 *  assistant-message count we used as the trigger. Returns the fresh
 *  row so the caller can broadcast it. */
export function setConversationTitle(
  userId: number,
  conversationId: number,
  title: string,
  assistantMessageCount: number,
): SparConversationRow | null {
  const db = getDb();
  const trimmed = title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!trimmed) return null;
  const now = Date.now();
  const info = db
    .prepare(
      "UPDATE spar_conversations SET title = ?, auto_named = 1, last_named_at_count = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    )
    .run(trimmed, assistantMessageCount, now, conversationId, userId);
  if (info.changes === 0) return null;
  return getConversation(userId, conversationId);
}

/** Persist a drift notice (or clear it with `null`). Cleared when the
 *  user dismisses the banner client-side. */
export function setDriftNotice(
  userId: number,
  conversationId: number,
  notice: string | null,
): SparConversationRow | null {
  const db = getDb();
  const cleaned = notice ? notice.replace(/\s+/g, " ").trim().slice(0, 280) : null;
  const now = Date.now();
  const info = db
    .prepare(
      "UPDATE spar_conversations SET drift_notice = ?, updated_at = ? WHERE id = ? AND user_id = ?",
    )
    .run(cleaned, now, conversationId, userId);
  if (info.changes === 0) return null;
  return getConversation(userId, conversationId);
}

export function countAssistantMessages(conversationId: number): number {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM spar_messages WHERE conversation_id = ? AND role = 'assistant'",
    )
    .get(conversationId) as { n: number };
  return row.n;
}

/** Tail-N messages, oldest-first. Used by the auto-namer + drift
 *  detector so they don't have to re-load the whole transcript. */
export function getRecentMessages(
  conversationId: number,
  limit: number,
): SparMessageRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, conversation_id, role, content, tool_calls, created_at FROM (SELECT * FROM spar_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC",
    )
    .all(conversationId, limit) as RawMsgRow[];
  return rows.map(rowToMsg);
}

export function deleteConversation(userId: number, conversationId: number): boolean {
  const db = getDb();
  const info = db
    .prepare("DELETE FROM spar_conversations WHERE id = ? AND user_id = ?")
    .run(conversationId, userId);
  return info.changes > 0;
}

export function latestConversationId(userId: number): number | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id FROM spar_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(userId) as { id: number } | undefined;
  return row?.id ?? null;
}
