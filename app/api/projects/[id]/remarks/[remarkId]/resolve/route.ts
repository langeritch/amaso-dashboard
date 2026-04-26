import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiRequireAdmin } from "@/lib/guard";
import { broadcastRemark } from "@/lib/ws";

export const dynamic = "force-dynamic";

/** Toggle resolved state. Admin-only. */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; remarkId: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const { id, remarkId } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { resolved?: boolean }
    | null;
  const resolved = body?.resolved ?? true;
  const rid = Number(remarkId);
  const row = getDb()
    .prepare("SELECT path FROM remarks WHERE id = ? AND project_id = ?")
    .get(rid, id) as { path: string | null } | undefined;
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  getDb()
    .prepare("UPDATE remarks SET resolved_at = ? WHERE id = ?")
    .run(resolved ? Date.now() : null, rid);
  broadcastRemark(id, row.path ?? "", rid, "added"); // trigger a reload in connected clients
  return NextResponse.json({ ok: true, resolved });
}
