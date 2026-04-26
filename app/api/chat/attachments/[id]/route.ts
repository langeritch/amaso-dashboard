import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { readChatAttachment } from "@/lib/attachments";
import { canUseChannel } from "@/lib/chat";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Serve a chat message attachment. Auth is enforced by channel membership:
 *  the caller must be allowed to read the channel the message belongs to. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;

  const { id } = await ctx.params;
  const attachmentId = Number(id);
  if (!Number.isFinite(attachmentId)) {
    return NextResponse.json({ error: "bad_attachment" }, { status: 400 });
  }

  const loaded = await readChatAttachment(attachmentId);
  if (!loaded) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const channelRow = getDb()
    .prepare(
      `SELECT m.channel_id
         FROM chat_messages m
        WHERE m.id = ?`,
    )
    .get(loaded.row.message_id) as { channel_id: number } | undefined;
  if (!channelRow) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!canUseChannel(auth.user, channelRow.channel_id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  return new NextResponse(new Uint8Array(loaded.data), {
    status: 200,
    headers: {
      "content-type": loaded.row.mime_type,
      "content-length": String(loaded.row.size),
      "content-disposition": `inline; filename="${loaded.row.filename.replace(/"/g, "")}"`,
      // Defense-in-depth: stop browsers from sniffing and re-interpreting
      // bytes as HTML/script, and sandbox any rendered content.
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      // Attachments are immutable once uploaded; aggressive cache is fine.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
