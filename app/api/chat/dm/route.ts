import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { getOrCreateDm } from "@/lib/chat";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const json = (await req.json().catch(() => null)) as {
    userId?: number;
  } | null;
  if (!json || typeof json.userId !== "number") {
    return NextResponse.json({ error: "user_id_required" }, { status: 400 });
  }
  if (json.userId === auth.user.id) {
    return NextResponse.json({ error: "cannot_dm_self" }, { status: 400 });
  }
  const target = getDb()
    .prepare("SELECT id FROM users WHERE id = ?")
    .get(json.userId);
  if (!target) {
    return NextResponse.json({ error: "user_not_found" }, { status: 404 });
  }
  const channelId = getOrCreateDm(auth.user.id, json.userId);
  return NextResponse.json({ channelId });
}
