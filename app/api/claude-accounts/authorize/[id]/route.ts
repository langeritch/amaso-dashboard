// Per-OAuth-session routes. See app/api/claude-accounts/authorize/route.ts
// for the flow overview.
//
// GET    /api/claude-accounts/authorize/:id        — poll session state
// DELETE /api/claude-accounts/authorize/:id        — cancel + cleanup
// POST   /api/claude-accounts/authorize/:id/code   — submit pasted code
//   (handled in ./code/route.ts — separate file because Next.js routes
//    one HTTP method per path segment per file, and POST on the /:id
//    segment would conflict with cancel UX expectations.)

import { NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import {
  cancelOAuthSession,
  getOAuthSession,
} from "@/lib/claude-oauth-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const { id } = await params;
  const session = getOAuthSession(id);
  if (!session) {
    return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  }
  return NextResponse.json({ session });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const { id } = await params;
  const ok = cancelOAuthSession(id);
  if (!ok) {
    return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
