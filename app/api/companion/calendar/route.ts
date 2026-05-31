// GET /api/companion/calendar — upcoming Apple Calendar events (today→+7)
// for the current user, read off their connected companion Mac via
// icalBuddy. Read-only, privacy-friendly (no iCloud password stored).
// Item 10 / remark #496. The dashboard polls this (~every 15 min) and
// renders the events in the today view. Degrades gracefully: when no
// companion is connected or icalBuddy isn't installed, returns ok:false
// with an `error` code and an empty list — never a 500 that breaks a
// panel.

import { NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { fetchCompanionCalendar } from "@/lib/companion-calendar";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  const { ok, events, error } = await fetchCompanionCalendar(auth.user.id);

  // Always 200 with a typed body — the client decides how to surface the
  // "no companion" / "icalBuddy missing" states without treating them as
  // hard errors.
  return NextResponse.json({ ok, events, error: error ?? null });
}
