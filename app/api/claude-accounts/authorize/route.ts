// Start a fresh OAuth login session against the Claude CLI. The
// session lives in lib/claude-oauth-sessions.ts; this route is a thin
// admin-gated wrapper that kicks it off and returns the new session
// id + the auth URL once the CLI prints it.
//
// Usage from the UI:
//   1. POST /api/claude-accounts/authorize → { id, status: "spawning" }
//   2. GET  /api/claude-accounts/authorize/:id   → poll until authUrl
//      appears (status becomes "awaiting_code")
//   3. POST /api/claude-accounts/authorize/:id/code with the user's
//      pasted code from the Anthropic callback page
//   4. GET  …/:id again until status === "done", then refresh the
//      account list

import { NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import { registerAccountFromCredentialsDir } from "@/lib/claude-accounts";
import { startOAuthSession } from "@/lib/claude-oauth-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;

  let body: { name?: string } = {};
  try {
    body = (await req.json()) as { name?: string };
  } catch {
    /* name is optional — empty body is fine */
  }
  const suggestedName = body.name?.trim() || undefined;

  // Wait briefly for the CLI to print the URL so the first response
  // already carries it — avoids a UI poll loop in the common case.
  // The session also continues independently if we time out here.
  const session = startOAuthSession({
    suggestedName,
    finalize: (configDir, name) =>
      registerAccountFromCredentialsDir({ name, credentialsDir: configDir }),
  });
  const finalView = await waitForUrl(session.id, 4_000);
  return NextResponse.json({ session: finalView ?? session });
}

async function waitForUrl(id: string, maxMs: number) {
  const { getOAuthSession } = await import("@/lib/claude-oauth-sessions");
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const v = getOAuthSession(id);
    if (!v) return null;
    if (v.authUrl || v.status === "failed" || v.status === "cancelled") return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return getOAuthSession(id);
}
