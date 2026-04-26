import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const rows = getDb()
    .prepare(
      "SELECT id, name, email, role FROM users WHERE id != ? ORDER BY name",
    )
    .all(auth.user.id) as {
    id: number;
    name: string;
    email: string;
    role: "admin" | "team" | "client";
  }[];
  return NextResponse.json({ users: rows });
}
