import { NextResponse } from "next/server";
import { apiRequireSuperUser } from "@/lib/guard";
import { refreshClaudeMd } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/graph/refresh-claude-md — re-read CLAUDE.md for every
 *  project node from disk so a freshly-edited file shows up in the
 *  side panel without restarting the server.
 *
 *  Super-user only: this is a global rebuild that touches every
 *  project the dashboard knows about, and the resulting graph is
 *  visible to every signed-in user. Letting any logged-in account
 *  trigger it (the prior gate) was a production-audit finding. */
export async function POST() {
  const auth = await apiRequireSuperUser();
  if (!auth.ok) return auth.res;
  const updated = refreshClaudeMd();
  return NextResponse.json({ ok: true, updated });
}
