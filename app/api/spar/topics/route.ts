import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { listTopics } from "@/lib/topics";
import { listTopicsForScope } from "@/lib/daily-topic-rollup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Topic listing.
 *
 * Layer 5 / By topic tab: GET /api/spar/topics?limit=&offset=&status=
 * — flat list of the user's topics sorted by last_active_at, no scope
 * filter.
 *
 * Final pass / Part B: GET /api/spar/topics?scope=today|week|all[&limit=]
 * — scope-aware list that reads daily_topic_stats so the chip strip
 * + list_topics tool + sticky history strip can all surface counts
 * for "today", "this week", or "all-time" in one call. Includes
 * related_brain_files for each topic (joined from topic_brain_refs).
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  if (user.role === "client") return new Response("forbidden", { status: 403 });

  const url = new URL(req.url);
  const scopeRaw = url.searchParams.get("scope");
  const scope =
    scopeRaw === "today" || scopeRaw === "week" || scopeRaw === "all"
      ? scopeRaw
      : null;

  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? (scope ? 25 : 50)) || (scope ? 25 : 50), 1),
    200,
  );

  if (scope) {
    const rows = listTopicsForScope(user.id, scope, limit);
    return Response.json({
      scope,
      topics: rows.map((t) => ({
        topicId: t.topicId,
        slug: t.slug,
        title: t.title,
        status: t.status,
        messageCount: t.messageCount,
        lastTouchedAt: t.lastTs,
        relatedBrainFiles: t.relatedBrainFiles,
      })),
    });
  }

  // Legacy code path — flat By topic tab list.
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam === "active" || statusParam === "archived"
      ? statusParam
      : undefined;

  const rows = listTopics(user.id, { limit, offset, status });
  return Response.json({
    topics: rows.map((t) => ({
      id: t.id,
      slug: t.slug,
      title: t.title,
      summary: t.summary,
      status: t.status,
      messageCount: t.message_count,
      lastActiveAt: t.last_active_at,
      createdAt: t.created_at,
    })),
  });
}
