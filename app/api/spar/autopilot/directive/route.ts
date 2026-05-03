// Per-user autopilot directive — the strategic mission/north star the
// autonomous loop reads when picking and creating tasks. GET returns
// the saved directive (empty string when unset); POST upserts it.
// Independent of the on/off toggle (`/api/spar/autopilot`), so the
// directive survives across enable/disable cycles.

import { NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import {
  readAutopilotDirective,
  writeAutopilotDirective,
} from "@/lib/autopilot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DIRECTIVE_CHARS = 2000;

export async function GET() {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  return NextResponse.json({ directive: readAutopilotDirective(auth.user.id) });
}

export async function POST(req: Request) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  const body = (await req.json().catch(() => null)) as {
    directive?: unknown;
  } | null;
  if (!body || typeof body.directive !== "string") {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (body.directive.length > MAX_DIRECTIVE_CHARS) {
    return NextResponse.json({ error: "too_long" }, { status: 400 });
  }
  writeAutopilotDirective(auth.user.id, body.directive);
  return NextResponse.json({ directive: readAutopilotDirective(auth.user.id) });
}
