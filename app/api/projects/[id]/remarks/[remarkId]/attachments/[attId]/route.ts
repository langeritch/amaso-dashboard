import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import { readAttachment } from "@/lib/attachments";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; remarkId: string; attId: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id, remarkId, attId } = await ctx.params;
  if (!canAccessProject(auth.user, id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rid = Number(remarkId);
  const aid = Number(attId);

  // Verify the attachment really belongs to a remark in this project
  const row = getDb()
    .prepare(
      `SELECT a.id FROM remark_attachments a
         JOIN remarks r ON r.id = a.remark_id
        WHERE a.id = ? AND r.id = ? AND r.project_id = ?`,
    )
    .get(aid, rid, id);
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const result = await readAttachment(aid);
  if (!result) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(result.data), {
    headers: {
      "content-type": result.row.mime_type,
      "content-length": String(result.row.size),
      "content-disposition": `inline; filename="${result.row.filename.replace(/"/g, "")}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      "cache-control": "private, max-age=3600",
    },
  });
}
