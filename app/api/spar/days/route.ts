import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import type { SubjectEntry } from "@/lib/spar-subjects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DayRow {
  date_local: string;
  conversation_id: number;
  active: number;
  msg_count: number;
}
interface SummaryRow {
  date: string;
  summary: string;
  topics: string;
}
interface TopicChipRow {
  date_local: string;
  topic_id: number;
  slug: string;
  title: string;
}
interface DailySubjectsRow {
  date: string;
  subjects: string;
}

/**
 * Layer 5 — history "By day" tab. Aggregates daily_chats rows into
 * one entry per (user, date_local), joins the daily_summaries row if
 * post-day extraction has run, and pulls a deduped list of topic
 * chips for each day from spar_message_topics. Read-only.
 *
 * Why a separate route instead of extending /api/spar/conversations:
 * the conversations endpoint already powers the per-conversation
 * sidebar list and a `groupBy=day` mode would mean two completely
 * different response shapes behind one URL. Cleaner to give the
 * history view its own URL.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  if (user.role === "client") return new Response("forbidden", { status: 403 });

  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? 90) || 90, 1),
    365,
  );
  const q = (url.searchParams.get("q") ?? "").trim();

  const db = getDb();
  // One row per (date_local, conversation_id). We aggregate to date
  // in JS so the topic-chips join below stays simple. message_count
  // is summed across all conversations on that date, including
  // legacy active=0 rows from the Layer 3 backfill.
  const rows = db
    .prepare(
      `SELECT dc.date_local, dc.conversation_id, dc.active,
              (SELECT COUNT(*) FROM spar_messages m
                 WHERE m.conversation_id = dc.conversation_id) AS msg_count
         FROM daily_chats dc
        WHERE dc.user_id = ?
        ORDER BY dc.date_local DESC, dc.active DESC
        LIMIT ?`,
    )
    .all(user.id, limit * 4) as DayRow[];

  const byDate = new Map<
    string,
    {
      date: string;
      activeConversationId: number | null;
      conversationIds: number[];
      messageCount: number;
    }
  >();
  for (const r of rows) {
    const cur =
      byDate.get(r.date_local) ?? {
        date: r.date_local,
        activeConversationId: null,
        conversationIds: [],
        messageCount: 0,
      };
    cur.conversationIds.push(r.conversation_id);
    cur.messageCount += r.msg_count;
    if (r.active === 1 && cur.activeConversationId === null) {
      cur.activeConversationId = r.conversation_id;
    }
    byDate.set(r.date_local, cur);
  }
  const days = Array.from(byDate.values())
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);

  if (days.length === 0) {
    return Response.json({ days: [] });
  }

  const dateList = days.map((d) => d.date);
  const datePlaceholders = dateList.map(() => "?").join(",");

  const summaries = db
    .prepare(
      `SELECT date, summary, topics FROM daily_summaries
        WHERE user_id = ? AND date IN (${datePlaceholders})`,
    )
    .all(user.id, ...dateList) as SummaryRow[];
  const summaryByDate = new Map(summaries.map((s) => [s.date, s] as const));

  // Topic chips per date: pull every (date_local, topic) pair via
  // spar_message_topics → spar_messages → daily_chats (the message's
  // conversation has to belong to one of the day's conversations).
  // Dedupe in JS so a topic that appears 30 times on a day shows up
  // once. Caps at first 6 chips per day to keep the row compact.
  const allConvIds = days.flatMap((d) => d.conversationIds);
  const convPlaceholders = allConvIds.map(() => "?").join(",");
  // Smart Topic System final pass: include message counts per (date,
  // topic) so the chip strip can render `topic · 12` instead of bare
  // labels. COUNT(*) inside the join is cheap on this scale; we
  // already iterate the spar_message_topics rows anyway.
  const chips = db
    .prepare(
      `SELECT dc.date_local, t.id AS topic_id, t.slug, t.title,
              COUNT(*) AS message_count
         FROM spar_message_topics smt
         JOIN spar_messages m   ON m.id = smt.message_id
         JOIN daily_chats   dc  ON dc.conversation_id = m.conversation_id
         JOIN topics        t   ON t.id = smt.topic_id
        WHERE dc.user_id = ?
          AND m.conversation_id IN (${convPlaceholders})
        GROUP BY dc.date_local, t.id
        ORDER BY dc.date_local DESC, COUNT(*) DESC`,
    )
    .all(user.id, ...allConvIds) as Array<TopicChipRow & { message_count: number }>;

  const chipsByDate = new Map<
    string,
    Map<number, { slug: string; title: string; messageCount: number }>
  >();
  for (const c of chips) {
    const m = chipsByDate.get(c.date_local) ?? new Map();
    if (!m.has(c.topic_id)) {
      m.set(c.topic_id, {
        slug: c.slug,
        title: c.title,
        messageCount: c.message_count,
      });
    }
    chipsByDate.set(c.date_local, m);
  }

  // Include cached daily_subjects when present. Read-only — extraction is
  // never triggered from this endpoint; callers must hit /api/spar/subjects
  // to kick off extraction for a given day.
  const subjectsRows = db
    .prepare(
      `SELECT date, subjects FROM daily_subjects
        WHERE user_id = ? AND date IN (${datePlaceholders})`,
    )
    .all(user.id, ...dateList) as DailySubjectsRow[];
  const subjectsByDate = new Map<string, SubjectEntry[]>();
  for (const row of subjectsRows) {
    try {
      subjectsByDate.set(row.date, JSON.parse(row.subjects) as SubjectEntry[]);
    } catch {
      /* skip corrupt rows */
    }
  }

  // Build the full day objects first, then apply optional search filter.
  const allDayObjects = days.map((d) => {
    const summary = summaryByDate.get(d.date);
    const topicMap = chipsByDate.get(d.date);
    const topics = topicMap
      ? Array.from(topicMap.entries())
          .slice(0, 6)
          .map(([id, v]) => ({
            id,
            slug: v.slug,
            title: v.title,
            messageCount: v.messageCount,
          }))
      : [];
    return {
      date: d.date,
      activeConversationId: d.activeConversationId,
      conversationIds: d.conversationIds,
      messageCount: d.messageCount,
      summary: summary?.summary ?? null,
      topics,
      subjects: subjectsByDate.get(d.date) ?? null,
    };
  });

  if (!q) {
    return Response.json({ days: allDayObjects });
  }

  // Search filter: match on summary text OR topic titles OR message content.
  const qLower = q.toLowerCase();
  const likeParam = `%${q}%`;

  // Collect dates that have a matching message in any of their conversations.
  interface MessageDateRow { date_local: string }
  const msgDateRows = db
    .prepare(
      `SELECT DISTINCT dc.date_local
         FROM spar_messages m
         JOIN daily_chats dc ON dc.conversation_id = m.conversation_id
        WHERE dc.user_id = ? AND m.content LIKE ? LIMIT 100`,
    )
    .all(user.id, likeParam) as MessageDateRow[];
  const msgMatchDates = new Set(msgDateRows.map((r) => r.date_local));

  const filteredDays = allDayObjects.filter((d) => {
    if (d.summary && d.summary.toLowerCase().includes(qLower)) return true;
    if (d.topics.some((t) => t.title.toLowerCase().includes(qLower))) return true;
    if (msgMatchDates.has(d.date)) return true;
    return false;
  });

  return Response.json({ days: filteredDays });
}
