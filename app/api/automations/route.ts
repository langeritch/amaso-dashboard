import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { createAutomation, listAutomationsWithStats } from "@/lib/automations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  return NextResponse.json({ automations: listAutomationsWithStats() });
}

interface CreateBody {
  name?: unknown;
  description?: unknown;
  url?: unknown;
}

export async function POST(req: Request) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const body = (await req.json().catch(() => null)) as CreateBody | null;
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!name || !url) {
    return NextResponse.json(
      { error: "name_and_url_required" },
      { status: 400 },
    );
  }
  const description =
    typeof body.description === "string" ? body.description.trim() || null : null;
  const automation = createAutomation({
    name,
    description,
    kind: "url",
    payload: { url },
  });
  // New rows have no recordings yet; attach an empty stats block so
  // the client's typed shape (AutomationWithStats) stays consistent
  // without a re-fetch.
  return NextResponse.json({
    automation: {
      ...automation,
      stats: {
        lastRunAt: null,
        runCount: 0,
        failedRuns: 0,
        clarificationsNeeded: 0,
      },
    },
  });
}
