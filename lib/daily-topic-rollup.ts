/**
 * Smart Topic System — final pass: daily topic rollup.
 *
 * Aggregates spar_message_topics → daily_topic_stats per (user, date,
 * topic) so the spar prompt's "Active topics today" header, the
 * mobile By Day chip strip, and the list_topics tool can all answer
 * cheap indexed lookups instead of re-joining three tables on every
 * call.
 *
 * Refresh strategy:
 *   - Nightly: refreshRollupForDay(userId, yesterday) runs as part of
 *     extractDailyFacts so a finished day always has a current rollup.
 *   - Today: refreshRollupForDay(userId, todayLocalDate()) is cheap
 *     enough to call on every list_topics({scope:'today'}) read —
 *     the cost is one INSERT…SELECT with the partial index hitting
 *     today's daily_chats row only.
 *   - History UI: lazy refresh on /api/spar/history/facts + /topics
 *     so an older day the user opens has fresh chip counts even if
 *     the cron pass missed it.
 *
 * Idempotent: DELETE then INSERT inside a transaction keyed on
 * (user_id, date). Concurrent refreshes for the same key serialise
 * via better-sqlite3's per-DB lock; the result is the same.
 */

import { getDb } from "./db";
import { todayLocalDate } from "./local-date";

export interface DailyTopicStat {
  topicId: number;
  slug: string;
  title: string;
  status: "active" | "archived";
  messageCount: number;
  firstMessageId: number | null;
  lastMessageId: number | null;
  firstTs: number | null;
  lastTs: number | null;
  computedAt: number;
}

export interface TopicScopeRow extends DailyTopicStat {
  /** Brain files cross-referenced from this topic (lib/topics.ts → topic_brain_refs). */
  relatedBrainFiles: string[];
}

interface RawStatRow {
  topic_id: number;
  message_count: number;
  first_message_id: number | null;
  last_message_id: number | null;
  first_ts: number | null;
  last_ts: number | null;
}

interface RawTopicRow {
  id: number;
  slug: string;
  title: string;
  status: "active" | "archived";
  message_count: number;
  last_active_at: number;
}

interface RawScopeRow {
  topic_id: number;
  slug: string;
  title: string;
  status: "active" | "archived";
  message_count: number;
  first_message_id: number | null;
  last_message_id: number | null;
  first_ts: number | null;
  last_ts: number | null;
  computed_at: number;
}

interface RawBrainRefRow {
  topic_id: number;
  file_path: string;
}

/**
 * Recompute the rollup for one (user, date). Returns the number of
 * topic rows written. Safe to call repeatedly; the index keeps
 * concurrent callers honest.
 */
export function refreshRollupForDay(userId: number, date: string): number {
  const db = getDb();
  const computedAt = Date.now();

  // Aggregate via the shared join. Use spar_message_topics as the
  // anchor so topics that exist but have no messages today don't
  // show up.
  const stats = db
    .prepare(
      `SELECT smt.topic_id            AS topic_id,
              COUNT(*)                AS message_count,
              MIN(m.id)               AS first_message_id,
              MAX(m.id)               AS last_message_id,
              MIN(m.created_at)       AS first_ts,
              MAX(m.created_at)       AS last_ts
         FROM spar_message_topics smt
         JOIN spar_messages       m  ON m.id  = smt.message_id
         JOIN daily_chats         dc ON dc.conversation_id = m.conversation_id
        WHERE dc.user_id    = ?
          AND dc.date_local = ?
          AND m.role IN ('user','assistant')
        GROUP BY smt.topic_id`,
    )
    .all(userId, date) as RawStatRow[];

  db.transaction(() => {
    db.prepare(
      "DELETE FROM daily_topic_stats WHERE user_id = ? AND date = ?",
    ).run(userId, date);
    if (stats.length === 0) return;
    const ins = db.prepare(
      `INSERT INTO daily_topic_stats
         (user_id, date, topic_id, message_count, first_message_id,
          last_message_id, first_ts, last_ts, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const s of stats) {
      ins.run(
        userId,
        date,
        s.topic_id,
        s.message_count,
        s.first_message_id,
        s.last_message_id,
        s.first_ts,
        s.last_ts,
        computedAt,
      );
    }
  })();

  return stats.length;
}

/**
 * Fetch the rollup rows for one (user, date) joined to the topics
 * table for slug + title. Sorted by message_count DESC. Used by the
 * chip strip + the prompt-injection helper.
 *
 * autoRefresh: when true (default), missing rollup rows are recomputed
 * on the spot. The cost is a single aggregate query.
 */
export function getDailyTopics(
  userId: number,
  date: string,
  opts: { autoRefresh?: boolean; limit?: number } = {},
): DailyTopicStat[] {
  const { autoRefresh = true, limit = 50 } = opts;
  const db = getDb();
  if (autoRefresh) {
    const existing = db
      .prepare(
        "SELECT 1 FROM daily_topic_stats WHERE user_id = ? AND date = ? LIMIT 1",
      )
      .get(userId, date);
    if (!existing) refreshRollupForDay(userId, date);
  }
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.slug AS slug, t.title AS title, t.status AS status,
              dts.message_count    AS message_count,
              dts.first_message_id AS first_message_id,
              dts.last_message_id  AS last_message_id,
              dts.first_ts         AS first_ts,
              dts.last_ts          AS last_ts,
              dts.computed_at      AS computed_at
         FROM daily_topic_stats dts
         JOIN topics t ON t.id = dts.topic_id
        WHERE dts.user_id = ? AND dts.date = ?
        ORDER BY dts.message_count DESC, dts.last_ts DESC
        LIMIT ?`,
    )
    .all(userId, date, Math.min(Math.max(limit, 1), 200)) as RawScopeRow[];
  return rows.map(rowToStat);
}

function rowToStat(r: RawScopeRow): DailyTopicStat {
  return {
    topicId: r.topic_id,
    slug: r.slug,
    title: r.title,
    status: r.status,
    messageCount: r.message_count,
    firstMessageId: r.first_message_id,
    lastMessageId: r.last_message_id,
    firstTs: r.first_ts,
    lastTs: r.last_ts,
    computedAt: r.computed_at,
  };
}

/**
 * Topic listing across a scope window. Drives the list_topics tool +
 * the /api/spar/topics?scope= endpoint. Each row gets its related
 * brain files joined in via topic_brain_refs (one extra batched
 * SELECT — cheaper than a per-row N+1).
 */
export function listTopicsForScope(
  userId: number,
  scope: "today" | "week" | "all",
  limit: number = 25,
): TopicScopeRow[] {
  const db = getDb();
  const today = todayLocalDate();
  const cappedLimit = Math.min(Math.max(limit, 1), 100);

  let rows: RawTopicRow[];

  if (scope === "all") {
    rows = db
      .prepare(
        `SELECT id, slug, title, status, message_count, last_active_at
           FROM topics
          WHERE user_id = ?
          ORDER BY last_active_at DESC
          LIMIT ?`,
      )
      .all(userId, cappedLimit) as RawTopicRow[];
  } else {
    // "today" / "week": ensure the relevant rollup rows are fresh,
    // then aggregate across the date window.
    const windowDays = scope === "today" ? 1 : 7;
    const dates: string[] = [];
    const todayDate = new Date(today + "T00:00:00");
    for (let i = 0; i < windowDays; i++) {
      const d = new Date(todayDate);
      d.setDate(d.getDate() - i);
      dates.push(d.toLocaleDateString("en-CA"));
    }
    for (const d of dates) {
      // Cheap to call — internal autoRefresh guard skips when fresh.
      const existing = db
        .prepare(
          "SELECT 1 FROM daily_topic_stats WHERE user_id = ? AND date = ? LIMIT 1",
        )
        .get(userId, d);
      if (!existing) refreshRollupForDay(userId, d);
    }
    const placeholders = dates.map(() => "?").join(",");
    // Disambiguate aliases: SQLite gets confused when the SELECT
    // alias matches a base-table column name (t.message_count exists
    // on topics). Name the rollup-summed column distinctly here and
    // surface it as message_count on the way out for the shared
    // RawTopicRow shape.
    rows = db
      .prepare(
        `SELECT t.id AS id, t.slug AS slug, t.title AS title, t.status AS status,
                COALESCE(SUM(dts.message_count), 0) AS msg_sum,
                MAX(dts.last_ts)                     AS last_active_at
           FROM topics t
           JOIN daily_topic_stats dts ON dts.topic_id = t.id
          WHERE t.user_id = ?
            AND dts.user_id = ?
            AND dts.date IN (${placeholders})
          GROUP BY t.id
         HAVING msg_sum > 0
          ORDER BY msg_sum DESC, last_active_at DESC
          LIMIT ?`,
      )
      .all(userId, userId, ...dates, cappedLimit)
      .map((r) => {
        const row = r as { id: number; slug: string; title: string; status: "active" | "archived"; msg_sum: number; last_active_at: number };
        return {
          id: row.id,
          slug: row.slug,
          title: row.title,
          status: row.status,
          message_count: row.msg_sum,
          last_active_at: row.last_active_at,
        } as RawTopicRow;
      });
  }

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const inPlaceholders = ids.map(() => "?").join(",");
  const refs = db
    .prepare(
      `SELECT topic_id, file_path FROM topic_brain_refs
        WHERE topic_id IN (${inPlaceholders})`,
    )
    .all(...ids) as RawBrainRefRow[];
  const byTopic = new Map<number, string[]>();
  for (const r of refs) {
    const arr = byTopic.get(r.topic_id) ?? [];
    arr.push(r.file_path);
    byTopic.set(r.topic_id, arr);
  }

  return rows.map((r) => ({
    topicId: r.id,
    slug: r.slug,
    title: r.title,
    status: r.status,
    messageCount: r.message_count,
    firstMessageId: null,
    lastMessageId: null,
    firstTs: null,
    lastTs: r.last_active_at,
    computedAt: Date.now(),
    relatedBrainFiles: byTopic.get(r.id) ?? [],
  }));
}

/**
 * Tiny string the spar route injects at the top of the system prompt.
 * Stays under ~200 tokens by capping at 5 entries with the most
 * recent message activity surfaced first. Returns the empty string
 * when there's nothing to surface so the prompt doesn't grow a
 * hollow header.
 */
export function formatActiveTopicsBlock(userId: number, date?: string): string {
  const stats = getDailyTopics(userId, date ?? todayLocalDate(), {
    autoRefresh: true,
    limit: 5,
  });
  if (stats.length === 0) return "";
  const lines = ["Active topics today:"];
  for (const s of stats) {
    lines.push(`  • ${s.title} (${s.messageCount})`);
  }
  return lines.join("\n");
}
