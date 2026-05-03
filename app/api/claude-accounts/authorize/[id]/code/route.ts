// Submit the OAuth code the user copied from Anthropic's callback page.
// The session manager types the code into the running CLI's stdin; the
// CLI then exchanges the code, writes .credentials.json, and we
// finalize the new account on the next file-watcher tick.

import { NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import { submitOAuthCode } from "@/lib/claude-oauth-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const { id } = await params;
  let body: { code?: string };
  try {
    body = (await req.json()) as { code?: string };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const code = body.code?.trim();
  if (!code) {
    return NextResponse.json({ error: "missing_code" }, { status: 400 });
  }
  const session = submitOAuthCode(id, code);
  if (!session) {
    return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  }
  return NextResponse.json({ session });
}
