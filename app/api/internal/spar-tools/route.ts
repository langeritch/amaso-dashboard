// Loopback-only RPC endpoint the spar MCP server calls into. Authenticated
// with a short-lived bearer token minted by the /api/spar route for each
// CLI invocation; the token carries the acting user's id, so every tool
// runs with that user's access scope (visible projects, heartbeat owner).
//
// External reachability: the dashboard binds to 0.0.0.0 for the local
// tunnel, so we can't rely on a remote-IP check. The token (32 random
// bytes, 10-minute TTL, only written to a per-invocation temp file) is
// the gate. Good enough for a single-user agent loop; revisit if this
// endpoint ever grows mutating tools that bypass the propose/confirm
// flow.

import { NextRequest } from "next/server";
import { validateToken } from "@/lib/spar-token";
import { getDb, publicUser } from "@/lib/db";
import { TOOL_HANDLERS, type SparContext } from "@/lib/spar-tools-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ToolRequest {
  tool?: string;
  args?: Record<string, unknown>;
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) {
    return Response.json({ ok: false, error: "missing token" }, { status: 401 });
  }
  const userId = validateToken(token);
  if (!userId) {
    return Response.json({ ok: false, error: "invalid or expired token" }, { status: 401 });
  }
  const row = getDb()
    .prepare("SELECT id, email, name, role, created_at FROM users WHERE id = ?")
    .get(userId) as
    | { id: number; email: string; name: string; role: "admin" | "team" | "client"; created_at: number }
    | undefined;
  if (!row) {
    return Response.json({ ok: false, error: "unknown user" }, { status: 401 });
  }

  let body: ToolRequest;
  try {
    body = (await req.json()) as ToolRequest;
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const toolName = typeof body.tool === "string" ? body.tool : "";
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    return Response.json({ ok: false, error: `unknown tool: ${toolName}` }, { status: 404 });
  }

  const ctx: SparContext = { user: publicUser(row), token };
  const args = body.args ?? {};
  try {
    const result = await handler(ctx, args);
    return Response.json({ ok: true, result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: msg });
  }
}
