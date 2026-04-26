import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiRequireAdmin } from "@/lib/guard";
import { setProjectAccess } from "@/lib/access";
import { hashPassword } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  const userId = Number(id);
  if (userId === auth.user.id) {
    return NextResponse.json({ error: "cannot_delete_self" }, { status: 400 });
  }
  getDb().prepare("DELETE FROM users WHERE id = ?").run(userId);
  return NextResponse.json({ ok: true });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  const userId = Number(id);
  const body = (await req.json().catch(() => null)) as
    | {
        name?: string;
        role?: "admin" | "team" | "client";
        password?: string;
        projects?: string[];
      }
    | null;
  if (!body) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const db = getDb();
  if (body.name !== undefined) {
    db.prepare("UPDATE users SET name = ? WHERE id = ?").run(
      body.name.trim(),
      userId,
    );
  }
  if (body.role !== undefined) {
    if (!["admin", "team", "client"].includes(body.role)) {
      return NextResponse.json({ error: "invalid_role" }, { status: 400 });
    }
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(body.role, userId);
  }
  if (body.password !== undefined) {
    if (body.password.length < 8) {
      return NextResponse.json(
        { error: "password_too_short" },
        { status: 400 },
      );
    }
    const hash = await hashPassword(body.password);
    db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hash, userId);
    // Invalidate any active sessions for this user
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
  if (body.projects !== undefined) {
    setProjectAccess(userId, body.projects);
  }
  return NextResponse.json({ ok: true });
}
