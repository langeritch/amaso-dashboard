import { NextResponse } from "next/server";
import { getDb, publicUser } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { apiRequireAdmin } from "@/lib/guard";
import { setProjectAccess } from "@/lib/access";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const rows = getDb()
    .prepare(
      "SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC",
    )
    .all() as Array<{
    id: number;
    email: string;
    name: string;
    role: "admin" | "team" | "client";
    created_at: number;
  }>;
  const accessRows = getDb()
    .prepare("SELECT user_id, project_id FROM project_access")
    .all() as { user_id: number; project_id: string }[];
  const accessByUser = new Map<number, string[]>();
  for (const r of accessRows) {
    const arr = accessByUser.get(r.user_id) ?? [];
    arr.push(r.project_id);
    accessByUser.set(r.user_id, arr);
  }
  return NextResponse.json({
    users: rows.map((r) => ({
      ...publicUser(r),
      projects: accessByUser.get(r.id) ?? [],
    })),
  });
}

export async function POST(req: Request) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const body = (await req.json().catch(() => null)) as
    | {
        email?: string;
        password?: string;
        name?: string;
        role?: "admin" | "team" | "client";
        projects?: string[];
      }
    | null;
  if (
    !body?.email ||
    !body.password ||
    !body.name ||
    !body.role ||
    !["admin", "team", "client"].includes(body.role)
  ) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (body.password.length < 8) {
    return NextResponse.json({ error: "password_too_short" }, { status: 400 });
  }
  const hash = await hashPassword(body.password);
  try {
    const r = getDb()
      .prepare(
        "INSERT INTO users (email, password, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        body.email.toLowerCase().trim(),
        hash,
        body.name.trim(),
        body.role,
        Date.now(),
      );
    if (body.role === "client" && body.projects) {
      setProjectAccess(Number(r.lastInsertRowid), body.projects);
    }
    return NextResponse.json({ id: Number(r.lastInsertRowid) });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return NextResponse.json({ error: "email_taken" }, { status: 409 });
    }
    throw err;
  }
}
