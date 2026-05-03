// Manual proactive-turn trigger.
//
// Cookie-authenticated POST endpoint that fires runProactiveTurn for
// the calling user. Useful for:
//   - Dashboard UI buttons ("ask spar to recap this terminal").
//   - Server-side cron tasks that already run inside the dashboard
//     process (those should call lib/spar-proactive directly — this
//     endpoint is for cross-process callers).
//   - Manual debugging via curl while iterating on the persona.
//
// The payload is intentionally narrow: a kind + minimal context. The
// rate-limit + skip-on-empty-reply guards live in the proactive
// helper, so a flood of POSTs from the same user can't spam them.

import { NextRequest, NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { runProactiveTurn, type ProactiveInput } from "@/lib/spar-proactive";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface IncomingBody {
  kind?: string;
  projectId?: string;
  dispatchId?: string;
  summary?: string;
  pushTitle?: string;
  pushBody?: string;
  directive?: string;
}

export async function POST(req: NextRequest) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  let body: IncomingBody | null = null;
  try {
    body = (await req.json()) as IncomingBody;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (!body || typeof body.kind !== "string") {
    return NextResponse.json({ error: "missing_kind" }, { status: 400 });
  }

  let input: ProactiveInput;
  if (body.kind === "dispatch_complete") {
    if (typeof body.projectId !== "string" || !body.projectId) {
      return NextResponse.json({ error: "missing_projectId" }, { status: 400 });
    }
    input = {
      kind: "dispatch_complete",
      userId: auth.user.id,
      projectId: body.projectId,
      dispatchId: body.dispatchId ?? null,
    };
  } else if (body.kind === "heartbeat") {
    if (
      typeof body.summary !== "string" ||
      typeof body.pushTitle !== "string" ||
      typeof body.pushBody !== "string"
    ) {
      return NextResponse.json(
        { error: "missing_heartbeat_fields" },
        { status: 400 },
      );
    }
    input = {
      kind: "heartbeat",
      userId: auth.user.id,
      summary: body.summary,
      pushTitle: body.pushTitle,
      pushBody: body.pushBody,
    };
  } else if (body.kind === "morning_briefing") {
    input = { kind: "morning_briefing", userId: auth.user.id };
  } else if (body.kind === "custom") {
    if (typeof body.directive !== "string" || !body.directive.trim()) {
      return NextResponse.json({ error: "missing_directive" }, { status: 400 });
    }
    input = {
      kind: "custom",
      userId: auth.user.id,
      directive: body.directive,
      pushTitle: body.pushTitle,
    };
  } else {
    return NextResponse.json({ error: "unknown_kind" }, { status: 400 });
  }

  // Fire-and-forget — the CLI call can take 1-3 seconds and the
  // caller doesn't need to block on the result. They'll see the
  // assistant message arrive over the spar:message WS broadcast.
  void runProactiveTurn(input).catch((err) => {
    console.warn(
      "[proactive] runProactiveTurn threw:",
      err instanceof Error ? err.message : String(err),
    );
  });
  return NextResponse.json({ accepted: true }, { status: 202 });
}
