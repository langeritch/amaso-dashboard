import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { getOrExtractSubjects, type SubjectEntry } from "@/lib/spar-subjects";
import { todayLocalDate } from "@/lib/local-date";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/spar/subjects?date=YYYY-MM-DD[&userId=<id>]
 *
 * Returns a consolidated list of SubjectEntry objects for the given day,
 * extracted from that day's spar messages via Claude. Results are cached
 * in daily_subjects so the first call pays the extraction cost and
 * subsequent calls are instant.
 *
 * Response shape:
 *   { subjects: SubjectEntry[], date: string, cached: boolean }
 *
 * 404 when no messages exist for the requested (user, date) pair.
 */
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  if (user.role === "client") return new Response("forbidden", { status: 403 });

  const url = new URL(req.url);
  const dateParam = url.searchParams.get("date") ?? todayLocalDate();

  // Admins may request another user's subjects via ?userId=<id>.
  let targetUserId = user.id;
  const userIdParam = url.searchParams.get("userId");
  if (userIdParam) {
    if (user.role !== "admin") {
      return new Response("forbidden", { status: 403 });
    }
    const parsed = parseInt(userIdParam, 10);
    if (isNaN(parsed) || parsed <= 0) {
      return new Response("invalid userId", { status: 400 });
    }
    targetUserId = parsed;
  }

  // Validate date format (YYYY-MM-DD).
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return new Response("invalid date format, expected YYYY-MM-DD", { status: 400 });
  }

  // Check whether there are any messages for this (user, date) at all.
  // If not, return 404 rather than asking Claude for nothing.
  const db = getDb();
  const hasMessages = db
    .prepare(
      `SELECT 1
         FROM daily_chats dc
         JOIN spar_messages m ON m.conversation_id = dc.conversation_id
        WHERE dc.user_id = ? AND dc.date_local = ?
        LIMIT 1`,
    )
    .get(targetUserId, dateParam);

  if (!hasMessages) {
    return new Response("no messages found for this date", { status: 404 });
  }

  // Check cache before extraction so we can return the `cached` flag.
  const cachedRow = db
    .prepare(
      `SELECT subjects FROM daily_subjects WHERE user_id = ? AND date = ?`,
    )
    .get(targetUserId, dateParam) as { subjects: string } | undefined;

  const wasCached = Boolean(cachedRow);

  let subjects: SubjectEntry[];
  if (cachedRow) {
    try {
      subjects = JSON.parse(cachedRow.subjects) as SubjectEntry[];
    } catch {
      // Corrupt cache — re-extract.
      subjects = await getOrExtractSubjects(targetUserId, dateParam);
    }
  } else {
    subjects = await getOrExtractSubjects(targetUserId, dateParam);
  }

  // Remark #431: hide weak-flagged subjects unless the caller opts
  // in. Useful default — search / recall / chip-strip readers want
  // clean signal; admin tooling can pass ?includeWeak=1 to see the
  // full set + investigate why something flagged.
  const includeWeak = url.searchParams.get("includeWeak") === "1";
  if (!includeWeak) {
    subjects = subjects.filter((s) => s.quality_flag !== "weak");
  }

  return Response.json({ subjects, date: dateParam, cached: wasCached });
}
