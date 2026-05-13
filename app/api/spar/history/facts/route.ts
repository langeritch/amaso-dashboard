/**
 * Layer 5 — extracted-facts list for a single (user, date).
 *
 * Powers the "Facts extracted from this day" sidebar on the mobile
 * DayDetail view. Read-only.
 *
 * GET /api/spar/history/facts?date=YYYY-MM-DD[&user=<id|name>]
 *
 * Scoping:
 *   - Non-admin callers ignore &user= and always see their own facts.
 *   - Admin callers may pass &user= to scope to another user's row.
 *
 * Response shape (always returns the envelope, even when no extraction
 * has run yet — the UI uses `extraction:null` to render an empty state
 * with a "Run extraction" button):
 *
 *   {
 *     date: "YYYY-MM-DD",
 *     userId: number,
 *     extraction: { id, status, factCount, classifications, runAt, errorText } | null,
 *     facts: [{ id, fact, classification, brainFile, section, sourceMessageIds[] }]
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ExtractionRow {
  id: number;
  status: string;
  fact_count: number;
  classifications_json: string;
  run_at: number;
  error_text: string | null;
}

interface FactRow {
  id: number;
  fact: string;
  classification: string;
  brain_file: string;
  section: string;
  source_message_ids: string;
}

function resolveTargetUser(
  callerId: number,
  callerRole: string,
  rawUser: string | null,
): number | null {
  if (!rawUser || callerRole !== "admin") return callerId;
  const asNum = Number(rawUser);
  const db = getDb();
  if (Number.isFinite(asNum) && asNum > 0) {
    const row = db.prepare("SELECT id FROM users WHERE id = ?").get(asNum) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }
  const row = db
    .prepare("SELECT id FROM users WHERE LOWER(name) = LOWER(?)")
    .get(rawUser) as { id: number } | undefined;
  return row?.id ?? null;
}

export async function GET(req: NextRequest) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  const url = new URL(req.url);
  const date = (url.searchParams.get("date") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: "date must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  const targetUserId = resolveTargetUser(
    auth.user.id,
    auth.user.role,
    url.searchParams.get("user"),
  );
  if (targetUserId === null) {
    return NextResponse.json({ error: "unknown user" }, { status: 404 });
  }

  const db = getDb();
  let extraction = db
    .prepare(
      `SELECT id, status, fact_count, classifications_json, run_at, error_text
         FROM daily_extractions WHERE user_id = ? AND date = ?`,
    )
    .get(targetUserId, date) as ExtractionRow | undefined;

  // Remark #444 — lazy extraction trigger (third path).
  // Cron handles yesterday at 03:00 and the admin endpoint covers
  // manual reruns. The third trigger is "first time a user opens a
  // past day in the history UI": if the date has spar messages but
  // no extraction row yet, fire one inline. We block the response on
  // it so the sidebar that called this endpoint gets the populated
  // result on the first paint — no spinner-then-data-then-refetch
  // dance. Caller decides whether to opt out via &lazy=0.
  const wantLazy = url.searchParams.get("lazy") !== "0";
  if (!extraction && wantLazy) {
    const hasMessages = db
      .prepare(
        `SELECT 1 FROM daily_chats dc
           JOIN spar_messages m ON m.conversation_id = dc.conversation_id
          WHERE dc.user_id = ? AND dc.date_local = ?
          LIMIT 1`,
      )
      .get(targetUserId, date);
    if (hasMessages) {
      try {
        const { extractDailyFacts } = await import("@/lib/daily-extraction");
        await extractDailyFacts({ userId: targetUserId, date });
        extraction = db
          .prepare(
            `SELECT id, status, fact_count, classifications_json, run_at, error_text
               FROM daily_extractions WHERE user_id = ? AND date = ?`,
          )
          .get(targetUserId, date) as ExtractionRow | undefined;
      } catch (err) {
        // Surface as a soft warning header but don't 500 — the UI
        // can still render the empty state.
        console.warn(
          "[spar-history-facts] lazy extraction failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  const factRows = db
    .prepare(
      `SELECT id, fact, classification, brain_file, section, source_message_ids
         FROM extracted_facts WHERE user_id = ? AND date = ?
         ORDER BY id ASC`,
    )
    .all(targetUserId, date) as FactRow[];

  const facts = factRows.map((r) => {
    let smids: number[] = [];
    try {
      const parsed = JSON.parse(r.source_message_ids);
      if (Array.isArray(parsed)) {
        smids = parsed.filter((n) => typeof n === "number" && Number.isFinite(n));
      }
    } catch {
      /* tolerate corrupt JSON — leave smids empty */
    }
    return {
      id: r.id,
      fact: r.fact,
      classification: r.classification,
      brainFile: r.brain_file,
      section: r.section,
      sourceMessageIds: smids,
    };
  });

  let extractionView: {
    id: number;
    status: string;
    factCount: number;
    classifications: Record<string, number>;
    runAt: number;
    errorText: string | null;
  } | null = null;
  if (extraction) {
    let classifications: Record<string, number> = {};
    try {
      classifications = JSON.parse(extraction.classifications_json) as Record<
        string,
        number
      >;
    } catch {
      /* leave empty */
    }
    extractionView = {
      id: extraction.id,
      status: extraction.status,
      factCount: extraction.fact_count,
      classifications,
      runAt: extraction.run_at,
      errorText: extraction.error_text,
    };
  }

  return NextResponse.json({
    date,
    userId: targetUserId,
    extraction: extractionView,
    facts,
  });
}
