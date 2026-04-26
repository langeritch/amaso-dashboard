import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** DELETE /api/graph/edges/[id] — remove a single edge by row id. */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  const edgeId = Number(id);
  if (!Number.isFinite(edgeId)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }

  const result = getDb()
    .prepare("DELETE FROM graph_edges WHERE id = ?")
    .run(edgeId);
  if (result.changes === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
