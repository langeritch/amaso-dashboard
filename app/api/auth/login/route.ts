import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  createSession,
  setSessionCookie,
  verifyPassword,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { email?: string; password?: string }
    | null;
  if (!body?.email || !body.password) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const row = getDb()
    .prepare("SELECT id, password FROM users WHERE email = ?")
    .get(body.email.toLowerCase().trim()) as
    | { id: number; password: string }
    | undefined;
  if (!row || !(await verifyPassword(body.password, row.password))) {
    // Generic error — don't leak which half was wrong
    return NextResponse.json({ error: "invalid_credentials" }, { status: 401 });
  }
  const { id, expiresAt } = createSession(row.id);
  await setSessionCookie(id, expiresAt);
  return NextResponse.json({ ok: true });
}
