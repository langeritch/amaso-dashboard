import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import {
  canUseChannel,
  insertMessage,
  listMessages,
  recipientsForChannel,
  type ChatAttachmentView,
} from "@/lib/chat";
import { broadcastChatMessage } from "@/lib/ws";
import {
  AttachmentError,
  MAX_FILES_PER_REMARK,
  attachmentsByRemark,
  saveChatAttachment,
} from "@/lib/attachments";
import { getDb } from "@/lib/db";
import { pushToUsers } from "@/lib/push";

export const dynamic = "force-dynamic";

interface RemarkRow {
  id: number;
  user_id: number;
  project_id: string;
  path: string | null;
  line: number | null;
  column: number | null;
  context: string | null;
  category: "frontend" | "backend" | "other";
  body: string;
  created_at: number;
  resolved_at: number | null;
  user_name: string;
}

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  const channelId = Number(id);
  if (!Number.isFinite(channelId)) {
    return NextResponse.json({ error: "bad_channel" }, { status: 400 });
  }
  const channel = canUseChannel(auth.user, channelId);
  if (!channel) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const messages = listMessages(channelId);

  // For project channels, mix in the project's remarks (ordered together
  // client-side by createdAt). Client renders them as inline cards.
  let remarks: unknown[] = [];
  if (channel.kind === "project" && channel.project_id) {
    const rows = getDb()
      .prepare(
        `SELECT r.id, r.user_id, r.project_id, r.path, r.line, r."column", r.context, r.category, r.body, r.created_at, r.resolved_at, u.name AS user_name
           FROM remarks r JOIN users u ON u.id = r.user_id
          WHERE r.project_id = ?
          ORDER BY r.created_at DESC
          LIMIT 200`,
      )
      .all(channel.project_id) as RemarkRow[];
    const attachments = attachmentsByRemark(rows.map((r) => r.id));
    remarks = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      projectId: r.project_id,
      path: r.path,
      line: r.line,
      column: r.column,
      context: safeJson(r.context),
      category: r.category,
      body: r.body,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
      attachments: attachments.get(r.id) ?? [],
    }));
  }

  return NextResponse.json({
    channel: {
      id: channel.id,
      kind: channel.kind,
      projectId: channel.project_id,
    },
    messages,
    remarks,
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  const channelId = Number(id);
  if (!Number.isFinite(channelId)) {
    return NextResponse.json({ error: "bad_channel" }, { status: 400 });
  }
  const channel = canUseChannel(auth.user, channelId);
  if (!channel) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const contentType = req.headers.get("content-type") ?? "";

  let body = "";
  let kind: "text" | "ai_session" = "text";
  let meta: Record<string, unknown> | null = null;
  let files: File[] = [];
  let attachmentErrors: string[] = [];

  if (contentType.startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "bad_multipart" }, { status: 400 });
    }
    body = String(form.get("body") ?? "").trim();
    const kindField = form.get("kind");
    if (kindField === "ai_session") kind = "ai_session";
    const metaField = form.get("meta");
    if (typeof metaField === "string") {
      try {
        const parsed = JSON.parse(metaField);
        if (parsed && typeof parsed === "object") meta = parsed;
      } catch {
        /* ignore malformed meta */
      }
    }
    files = form
      .getAll("files")
      .filter((f): f is File => f instanceof File && f.size > 0)
      .slice(0, MAX_FILES_PER_REMARK);
    if (!body && files.length === 0) {
      return NextResponse.json({ error: "empty_message" }, { status: 400 });
    }
  } else {
    const json = (await req.json().catch(() => null)) as {
      body?: string;
      kind?: "text" | "ai_session";
      meta?: Record<string, unknown>;
    } | null;
    if (!json) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    body = (json.body ?? "").trim();
    if (!body) {
      return NextResponse.json({ error: "body_required" }, { status: 400 });
    }
    kind = json.kind === "ai_session" ? "ai_session" : "text";
    meta = json.meta && typeof json.meta === "object" ? json.meta : null;
  }

  const msg = insertMessage(channelId, auth.user.id, body, kind, meta);
  if (files.length > 0) {
    const saved: ChatAttachmentView[] = [];
    for (const file of files) {
      try {
        const row = await saveChatAttachment(msg.id, file);
        saved.push({
          id: row.id,
          filename: row.filename,
          mimeType: row.mime_type,
          size: row.size,
        });
      } catch (err) {
        attachmentErrors.push(
          err instanceof AttachmentError ? err.message : "save_failed",
        );
      }
    }
    msg.attachments = saved;
  }
  broadcastChatMessage(channelId, msg);

  // Fire-and-forget push delivery. WS already covers users with the app
  // open; push covers everyone else (closed PWA, backgrounded tab, etc.).
  const recipients = recipientsForChannel(channelId, auth.user.id);
  if (recipients.length > 0) {
    const attCount = msg.attachments?.length ?? 0;
    const attHint =
      attCount === 0
        ? ""
        : body
          ? ` · 📷 ${attCount}`
          : `📷 ${attCount === 1 ? "foto" : `${attCount} foto's`}`;
    const rawPreview = body || attHint.trim();
    const preview =
      rawPreview.length > 140 ? rawPreview.slice(0, 140) + "…" : rawPreview;
    // Chat is always the landing surface; clicking the notification opens
    // the chat page — the client figures out which channel to activate.
    void pushToUsers(recipients, {
      title: `${msg.userName} · ${channelLabel(channel)}`,
      body: attCount > 0 && body ? `${preview}${attHint}` : preview,
      url: `/?channel=${channelId}`,
      tag: `chat-${channelId}`,
      data: { kind: "chat", channelId },
    });
  }

  return NextResponse.json({
    message: msg,
    attachmentErrors: attachmentErrors.length > 0 ? attachmentErrors : undefined,
  });
}

function channelLabel(ch: { kind: string; name: string | null; project_id: string | null }): string {
  if (ch.kind === "general") return "General";
  if (ch.kind === "project") return ch.name ?? ch.project_id ?? "Project";
  return "Direct message";
}
