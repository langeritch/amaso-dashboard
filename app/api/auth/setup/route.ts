import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  createSession,
  hashPassword,
  setSessionCookie,
  userCount,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Only valid when no users exist — otherwise it's a privilege escalation.
  if (userCount() > 0) {
    return NextResponse.json({ error: "already_initialised" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | { email?: string; password?: string; name?: string }
    | null;
  if (!body?.email || !body.password || !body.name) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (body.password.length < 8) {
    return NextResponse.json({ error: "password_too_short" }, { status: 400 });
  }

  const hash = await hashPassword(body.password);
  const r = getDb()
    .prepare(
      "INSERT INTO users (email, password, name, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
    )
    .run(body.email.toLowerCase().trim(), hash, body.name.trim(), Date.now());

  const { id, expiresAt } = createSession(Number(r.lastInsertRowid));
  await setSessionCookie(id, expiresAt);
  return NextResponse.json({ ok: true });
}
