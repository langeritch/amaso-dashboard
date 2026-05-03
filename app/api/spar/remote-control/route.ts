// Remote-control endpoint. Lets the spar voice assistant (and any
// other authenticated caller) drive the dashboard UI for the
// signed-in user — toggling autopilot, opening sidebars, starting a
// fresh conversation, setting the autopilot directive — without the
// user having to click anything. Each accepted action is broadcast
// over WS as a `spar:remote_control` event the frontend listens for
// and applies in <SparProvider> / <SparPageShell>.
//
// Auth: standard apiRequireNonClient (session cookie). The MCP tool that
// fronts this for the spar agent reuses the user's bearer token via
// the loopback /api/internal/spar-tools dispatcher, which in turn
// has the acting user's id from the short-lived spar token. The
// route itself does not accept tokens — it stays consistent with
// every other /api/spar endpoint and only mutates the calling
// user's state.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { apiRequireNonClient } from "@/lib/guard";
import {
  enableAutopilot,
  disableAutopilot,
  writeAutopilotDirective,
} from "@/lib/autopilot";
import {
  broadcastSparRemoteControl,
  type SparRemoteControlAction,
  type SparRemoteControlPayload,
} from "@/lib/ws";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_DIRECTIVE_CHARS = 2000;

interface RawBody {
  action?: unknown;
  value?: unknown;
  side?: unknown;
}

function parseAction(body: RawBody): SparRemoteControlAction | { error: string } {
  const action = typeof body.action === "string" ? body.action : "";
  switch (action) {
    case "toggle_autopilot": {
      if (typeof body.value !== "boolean") {
        return { error: "value must be boolean" };
      }
      return { action, value: body.value };
    }
    case "open_sidebar":
    case "close_sidebar": {
      if (body.side !== "left" && body.side !== "right") {
        return { error: "side must be 'left' or 'right'" };
      }
      return { action, side: body.side };
    }
    case "new_conversation": {
      return { action };
    }
    case "set_directive": {
      if (typeof body.value !== "string") {
        return { error: "value must be string" };
      }
      if (body.value.length > MAX_DIRECTIVE_CHARS) {
        return { error: "directive too long" };
      }
      return { action, value: body.value };
    }
    default:
      return { error: `unknown action: ${action || "<missing>"}` };
  }
}

export async function POST(req: Request) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  let body: RawBody;
  try {
    body = (await req.json()) as RawBody;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const parsed = parseAction(body);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  // Server-side side-effects for actions that touch durable state.
  // The frontend mirror still applies on receipt — but we want the
  // database-of-record to reflect the action immediately so a tab
  // that connects later (or the proactive-loop, which reads the
  // table, not the WS) sees the new value.
  if (parsed.action === "toggle_autopilot") {
    if (parsed.value) enableAutopilot(auth.user.id);
    else disableAutopilot(auth.user.id);
  } else if (parsed.action === "set_directive") {
    writeAutopilotDirective(auth.user.id, parsed.value);
  }

  const payload: SparRemoteControlPayload = {
    id: randomUUID(),
    issuedAt: Date.now(),
    payload: parsed,
  };
  broadcastSparRemoteControl(auth.user.id, payload);

  return NextResponse.json({ ok: true, id: payload.id });
}
