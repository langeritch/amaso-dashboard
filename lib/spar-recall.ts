/**
 * Smart Topic System — Layer 6: recall tool.
 *
 * Lets the spar assistant pull past context on demand when the user
 * says "last time", "on Tuesday", "what did we decide about pricing",
 * "remember when", or references a specific past date / topic /
 * keyword. The model invokes recall() once per qualifying turn — not
 * every turn — to keep cost bounded.
 *
 * Three lookup modes:
 *   - type='date'    → load that local-date's full conversation + facts.
 *   - type='topic'   → load every message linked to the topic across
 *                       days + extracted facts that mention it.
 *   - type='keyword' → LIKE-search messages + facts; group by date.
 *
 * Every invocation is audited in recall_invocations (user_id, ts,
 * type, value, result_count, total_messages, total_facts). The
 * existing /api/internal/spar-tools loopback authenticates the caller,
 * so user scoping is enforced by the caller's bearer-token user id.
 */

import { getDb } from "./db";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RecallType = "date" | "topic" | "keyword";

export interface RecallMessage {
  id: number;
  ts: number;
  speaker: "user" | "assistant";
  body: string;
}

export interface RecallFact {
  fact: string;
  classification: string;
  brainFile: string;
  section: string;
}

export interface RecallDayBucket {
  date: string;
  messages: RecallMessage[];
  facts: RecallFact[];
  truncated: boolean;
}

export interface RecallResult {
  query: { type: RecallType; value: string };
  results: RecallDayBucket[];
  totalMessages: number;
  totalFacts: number;
}

export interface RecallOptions {
  userId: number;
  type: RecallType;
  value: string;
  /** Max message lines included across all returned buckets. Default
   *  200, hard ceiling 600 — the cost discipline lives here, not at
   *  the model layer. */
  limit?: number;
  /** When true, skip the recall_invocations write (used by tests so
   *  they don't pollute the audit log). Defaults to false. */
  skipAudit?: boolean;
}

const DEFAULT_LIMIT = 200;
const HARD_CAP = 600;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RawMsgRow {
  id: number;
  role: string;
  content: string;
  created_at: number;
  date_local: string;
}

interface RawFactRow {
  fact: string;
  classification: string;
  brain_file: string;
  section: string;
  date: string;
}

function normaliseRole(r: string): "user" | "assistant" {
  return r === "assistant" ? "assistant" : "user";
}

function groupByDate(
  messages: RawMsgRow[],
  facts: RawFactRow[],
  limit: number,
): { buckets: RecallDayBucket[]; truncatedSomewhere: boolean } {
  const map = new Map<string, RecallDayBucket>();
  let remaining = limit;
  let truncatedSomewhere = false;
  for (const m of messages) {
    const bucket = map.get(m.date_local) ?? {
      date: m.date_local,
      messages: [],
      facts: [],
      truncated: false,
    };
    if (remaining > 0) {
      bucket.messages.push({
        id: m.id,
        ts: m.created_at,
        speaker: normaliseRole(m.role),
        body: m.content,
      });
      remaining--;
    } else {
      bucket.truncated = true;
      truncatedSomewhere = true;
    }
    map.set(m.date_local, bucket);
  }
  for (const f of facts) {
    const bucket = map.get(f.date) ?? {
      date: f.date,
      messages: [],
      facts: [],
      truncated: false,
    };
    bucket.facts.push({
      fact: f.fact,
      classification: f.classification,
      brainFile: f.brain_file,
      section: f.section,
    });
    map.set(f.date, bucket);
  }
  const buckets = Array.from(map.values()).sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );
  return { buckets, truncatedSomewhere };
}

function persistInvocation(args: {
  userId: number;
  type: RecallType;
  value: string;
  resultCount: number;
  totalMessages: number;
  totalFacts: number;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO recall_invocations
       (user_id, ts, type, value, result_count, total_messages, total_facts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.userId,
    Date.now(),
    args.type,
    args.value.slice(0, 200),
    args.resultCount,
    args.totalMessages,
    args.totalFacts,
  );
}

// ---------------------------------------------------------------------------
// Per-type implementations
// ---------------------------------------------------------------------------

function recallByDate(userId: number, date: string, limit: number): RecallResult {
  const db = getDb();
  const messages = db
    .prepare(
      `SELECT m.id, m.role, m.content, m.created_at, dc.date_local
         FROM spar_messages m
         JOIN daily_chats dc ON dc.conversation_id = m.conversation_id
        WHERE dc.user_id = ? AND dc.date_local = ?
          AND m.role IN ('user','assistant')
        ORDER BY m.created_at ASC, m.id ASC`,
    )
    .all(userId, date) as RawMsgRow[];
  const facts = db
    .prepare(
      `SELECT fact, classification, brain_file, section, date
         FROM extracted_facts
        WHERE user_id = ? AND date = ?
        ORDER BY id ASC`,
    )
    .all(userId, date) as RawFactRow[];

  const { buckets, truncatedSomewhere } = groupByDate(messages, facts, limit);
  void truncatedSomewhere;
  return {
    query: { type: "date", value: date },
    results: buckets,
    totalMessages: messages.length,
    totalFacts: facts.length,
  };
}

function recallByTopic(userId: number, value: string, limit: number): RecallResult {
  const db = getDb();
  // Match topic by slug OR by case-insensitive title contains. Many
  // topics in practice are keyword-flavoured ("hyet", "pricing"); the
  // title-contains match catches those without the user needing to
  // know the exact slug.
  const topic = db
    .prepare(
      `SELECT id, slug, title FROM topics
        WHERE user_id = ? AND (slug = ? OR LOWER(title) LIKE LOWER(?))
        ORDER BY (slug = ?) DESC, last_active_at DESC
        LIMIT 1`,
    )
    .get(userId, value, `%${value}%`, value) as
    | { id: number; slug: string; title: string }
    | undefined;
  if (!topic) {
    return {
      query: { type: "topic", value },
      results: [],
      totalMessages: 0,
      totalFacts: 0,
    };
  }
  const messages = db
    .prepare(
      `SELECT m.id, m.role, m.content, m.created_at, dc.date_local
         FROM spar_message_topics smt
         JOIN spar_messages m ON m.id = smt.message_id
         JOIN daily_chats dc ON dc.conversation_id = m.conversation_id
        WHERE smt.topic_id = ?
          AND dc.user_id = ?
          AND m.role IN ('user','assistant')
        ORDER BY m.created_at ASC, m.id ASC`,
    )
    .all(topic.id, userId) as RawMsgRow[];

  // Fact search uses the topic's TITLE (more readable substring) plus
  // the raw user input as a fallback. The slug is dash-joined and
  // unlikely to appear in a free-form fact body, but title tokens
  // ("HyET pricing") routinely do.
  const titleLike = `%${topic.title.replace(/[%_]/g, "\\$&")}%`;
  const valueLike = `%${value.replace(/[%_]/g, "\\$&")}%`;
  const facts = db
    .prepare(
      `SELECT fact, classification, brain_file, section, date
         FROM extracted_facts
        WHERE user_id = ?
          AND (fact LIKE ? ESCAPE '\\' OR fact LIKE ? ESCAPE '\\'
               OR section LIKE ? ESCAPE '\\' OR section LIKE ? ESCAPE '\\')
        ORDER BY date DESC, id ASC`,
    )
    .all(userId, titleLike, valueLike, titleLike, valueLike) as RawFactRow[];

  const { buckets } = groupByDate(messages, facts, limit);
  return {
    query: { type: "topic", value: topic.slug },
    results: buckets,
    totalMessages: messages.length,
    totalFacts: facts.length,
  };
}

function recallByKeyword(userId: number, value: string, limit: number): RecallResult {
  const db = getDb();
  const like = `%${value.replace(/[%_]/g, "\\$&")}%`;
  const messages = db
    .prepare(
      `SELECT m.id, m.role, m.content, m.created_at, dc.date_local
         FROM spar_messages m
         JOIN daily_chats dc ON dc.conversation_id = m.conversation_id
        WHERE dc.user_id = ?
          AND m.role IN ('user','assistant')
          AND m.content LIKE ? ESCAPE '\\'
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ?`,
    )
    .all(userId, like, Math.min(limit * 2, HARD_CAP)) as RawMsgRow[];
  const facts = db
    .prepare(
      `SELECT fact, classification, brain_file, section, date
         FROM extracted_facts
        WHERE user_id = ?
          AND fact LIKE ? ESCAPE '\\'
        ORDER BY date DESC, id DESC`,
    )
    .all(userId, like) as RawFactRow[];

  const { buckets } = groupByDate(messages, facts, limit);
  return {
    query: { type: "keyword", value },
    results: buckets,
    totalMessages: messages.length,
    totalFacts: facts.length,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function recall(opts: RecallOptions): RecallResult {
  const limitRaw = typeof opts.limit === "number" && Number.isFinite(opts.limit)
    ? Math.floor(opts.limit)
    : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(limitRaw, 1), HARD_CAP);
  const trimmed = opts.value.trim();
  if (!trimmed) {
    return {
      query: { type: opts.type, value: "" },
      results: [],
      totalMessages: 0,
      totalFacts: 0,
    };
  }

  let result: RecallResult;
  switch (opts.type) {
    case "date":
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        throw new Error("recall: type='date' requires YYYY-MM-DD");
      }
      result = recallByDate(opts.userId, trimmed, limit);
      break;
    case "topic":
      result = recallByTopic(opts.userId, trimmed, limit);
      break;
    case "keyword":
      result = recallByKeyword(opts.userId, trimmed, limit);
      break;
    default:
      throw new Error(`recall: unknown type "${String(opts.type)}"`);
  }

  if (!opts.skipAudit) {
    try {
      persistInvocation({
        userId: opts.userId,
        type: opts.type,
        value: trimmed,
        resultCount: result.results.length,
        totalMessages: result.totalMessages,
        totalFacts: result.totalFacts,
      });
    } catch {
      /* audit logging is best-effort */
    }
  }
  return result;
}
