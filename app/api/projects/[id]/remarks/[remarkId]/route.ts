import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import { broadcastRemark } from "@/lib/ws";
import { deleteAttachmentsOfRemark } from "@/lib/attachments";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; remarkId: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id, remarkId } = await ctx.params;
  if (!canAccessProject(auth.user, id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rid = Number(remarkId);
  const row = getDb()
    .prepare(
      "SELECT user_id, project_id, path FROM remarks WHERE id = ? AND project_id = ?",
    )
    .get(rid, id) as
    | { user_id: number; project_id: string; path: string | null }
    | undefined;
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (auth.user.role !== "admin" && row.user_id !== auth.user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // CASCADE removes the attachment rows; we still need to delete the files.
  await deleteAttachmentsOfRemark(rid);
  getDb().prepare("DELETE FROM remarks WHERE id = ?").run(rid);
  broadcastRemark(id, row.path ?? "", rid, "deleted");
  return NextResponse.json({ ok: true });
}
