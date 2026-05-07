// Loopback-only RPC endpoint the extension-mcp stdio server calls.
// Mirrors /api/internal/spar-tools — same bearer-token auth (the spar
// invocation mints a short-lived token tied to the acting user), but
// instead of running tool handlers in-process this one proxies the
// call out over the ext-bridge WebSocket to the user's connected
// browser extension and waits for its ack.
//
// The browser extension is the actual executor: it owns chrome.debugger
// on the target tab and translates each browser_* tool call into the
// matching Chrome DevTools Protocol commands.

import { NextRequest } from "next/server";
import { validateToken } from "@/lib/spar-token";
import { getDb } from "@/lib/db";
import { sendExtCommand, isExtensionConnected } from "@/lib/ext-bridge-ws";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ToolRequest {
  tool?: string;
  args?: Record<string, unknown>;
  /** Optional per-call timeout override in milliseconds. The bridge's
   *  default (60 s) is fine for most tools, but `browser_wait_for`
   *  with a long `time` arg can legitimately need more. */
  timeoutMs?: number;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return Response.json(
      { ok: false, error: "missing token" },
      { status: 401 },
    );
  }
  const userId = validateToken(token);
  if (!userId) {
    return Response.json(
      { ok: false, error: "invalid or expired token" },
      { status: 401 },
    );
  }
  // We don't need the full user row here, just the existence check —
  // the WS bridge keys on userId and the extension's cookie auth has
  // already proven that user is logged in.
  const exists = getDb()
    .prepare("SELECT 1 FROM users WHERE id = ?")
    .get(userId);
  if (!exists) {
    return Response.json(
      { ok: false, error: "unknown user" },
      { status: 401 },
    );
  }

  let body: ToolRequest;
  try {
    body = (await req.json()) as ToolRequest;
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const tool = typeof body.tool === "string" ? body.tool : "";
  if (!tool) {
    return Response.json(
      { ok: false, error: "missing tool name" },
      { status: 400 },
    );
  }
  if (!isExtensionConnected(userId)) {
    return Response.json({
      ok: false,
      error:
        "Amaso browser extension is not connected. Open Chrome with the extension installed and visit the dashboard once so it can authenticate.",
    });
  }

  const ack = await sendExtCommand(
    userId,
    { tool, args: body.args ?? {} },
    typeof body.timeoutMs === "number" && body.timeoutMs > 0
      ? Math.min(body.timeoutMs, 5 * 60_000)
      : undefined,
  );
  if (!ack.ok) {
    return Response.json({
      ok: false,
      error: ack.error ?? "extension returned error",
    });
  }
  return Response.json({ ok: true, result: ack.result });
}
