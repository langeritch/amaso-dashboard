import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getTopicBySlug, listMessagesForTopic } from "@/lib/topics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Layer 5 — topic detail. listMessagesForTopic returns rows ordered
 * by created_at DESC; we re-sort ascending here so the renderer can
 * paint the conversation chronologically without an extra pass.
 *
 * Final pass: optional ?date=YYYY-MM-DD narrows the result to
 * messages whose conversation maps to that local date in daily_chats.
 * Drives the "click chip on day card → filter that day's transcript
 * to this topic" flow.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  if (user.role === "client") return new Response("forbidden", { status: 403 });

  const { slug } = await params;
  if (!slug) return new Response("bad slug", { status: 400 });

  const topic = getTopicBySlug(user.id, slug);
  if (!topic) return new Response("not found", { status: 404 });

  const url = new URL(req.url);
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? 200) || 200, 1),
    500,
  );
  const dateFilter = url.searchParams.get("date");
  const dateValid = dateFilter && /^\d{4}-\d{2}-\d{2}$/.test(dateFilter)
    ? dateFilter
    : null;

  let rows = listMessagesForTopic(topic.id, { limit });
  if (dateValid) {
    // Narrow to messages whose conversation belongs to the (user,
    // date) bucket in daily_chats. One indexed lookup per surviving
    // row; the topic's tag set is small enough that this stays cheap.
    const convIds = new Set<number>();
    const dailyRows = getDb()
      .prepare(
        `SELECT conversation_id FROM daily_chats
          WHERE user_id = ? AND date_local = ?`,
      )
      .all(user.id, dateValid) as Array<{ conversation_id: number }>;
    for (const r of dailyRows) convIds.add(r.conversation_id);
    rows = rows.filter((m) => convIds.has(m.conversation_id));
  }
  rows.sort((a, b) => a.created_at - b.created_at);

  return Response.json({
    topic: {
      id: topic.id,
      slug: topic.slug,
      title: topic.title,
      summary: topic.summary,
      status: topic.status,
      messageCount: topic.message_count,
      lastActiveAt: topic.last_active_at,
    },
    messages: rows.map((m) => {
      let toolCalls: unknown | null = null;
      if (m.tool_calls) {
        try {
          toolCalls = JSON.parse(m.tool_calls);
        } catch {
          toolCalls = null;
        }
      }
      return {
        id: m.id,
        conversationId: m.conversation_id,
        role: m.role,
        content: m.content,
        toolCalls,
        createdAt: m.created_at,
        relevance: m.relevance,
      };
    }),
  });
}
