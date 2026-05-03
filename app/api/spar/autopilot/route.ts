// Per-user autopilot toggle. Autopilot is now a mode switch on the
// auto-report path (not a cron dispatcher): when enabled, the prompt
// the assistant gets after a dispatched terminal goes idle includes
// the autonomous-loop directive. The directive (north star) lives at
// /api/spar/autopilot/directive and persists across enable/disable.

import { NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import {
  disableAutopilot,
  enableAutopilot,
  isAutopilotEnabled,
} from "@/lib/autopilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  return NextResponse.json({ enabled: isAutopilotEnabled(auth.user.id) });
}

export async function POST(req: Request) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  const body = (await req.json().catch(() => null)) as {
    enabled?: unknown;
  } | null;
  if (!body || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.enabled) enableAutopilot(auth.user.id);
  else disableAutopilot(auth.user.id);
  return NextResponse.json({ enabled: body.enabled });
}
