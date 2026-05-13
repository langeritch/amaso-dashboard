/**
 * Admin endpoint: rerun the Layer 4 fact extractor for a chosen
 * (user, date) without waiting for the nightly cron. Returns the full
 * ExtractionResult so Santi can confirm fact counts + classifications
 * before brain files were touched.
 *
 * Body:
 *   {
 *     date?:   string  // YYYY-MM-DD (Europe/Amsterdam). Defaults to yesterday.
 *     userId?: number  // integer id from users table. Defaults to caller.
 *     force?:  boolean // bypass the "already successful" guard.
 *     dryRun?: boolean // build prompt + call model, skip brain + DB writes.
 *   }
 *
 * Wraps the same lib/daily-extraction core the CLI runs against, so
 * dashboard reruns and the cron job stay byte-identical.
 */

import { NextRequest, NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import { extractDailyFacts, yesterdayLocalDate } from "@/lib/daily-extraction";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  date?: unknown;
  userId?: unknown;
  force?: unknown;
  dryRun?: unknown;
}

export async function POST(req: NextRequest) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    // empty body is fine; defaults kick in.
  }

  const date =
    typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : yesterdayLocalDate();
  const userId =
    typeof body.userId === "number" && Number.isFinite(body.userId) && body.userId > 0
      ? body.userId
      : auth.user.id;
  const force = body.force === true;
  const dryRun = body.dryRun === true;

  try {
    const result = await extractDailyFacts({ userId, date, force, dryRun });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 },
    );
  }
}
