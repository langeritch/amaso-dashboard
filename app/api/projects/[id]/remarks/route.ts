import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import { broadcastRemark, broadcastChatRemark } from "@/lib/ws";
import { ensureProjectChannels } from "@/lib/chat";
import {
  AttachmentError,
  MAX_FILES_PER_REMARK,
  attachmentsByRemark,
  saveAttachment,
} from "@/lib/attachments";
import {
  MAX_BODY_TEXT_BYTES,
  MAX_MULTIPART_UPLOAD_BYTES,
  MAX_TEXT_JSON_BYTES,
  tooLargeByContentLength,
} from "@/lib/body-limit";

export const dynamic = "force-dynamic";

type Category = "frontend" | "backend" | "other";

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

interface RemarkRow {
  id: number;
  user_id: number;
  project_id: string;
  path: string | null;
  line: number | null;
  column: number | null;
  context: string | null;
  category: Category;
  body: string;
  created_at: number;
  resolved_at: number | null;
  user_name: string;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!canAccessProject(auth.user, id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const pathFilter = url.searchParams.get("path");
  const scope = url.searchParams.get("scope"); // "file" | "project" | null (all)
  const db = getDb();

  let rows: RemarkRow[];
  if (scope === "project") {
    rows = db
      .prepare(
        `SELECT r.id, r.user_id, r.project_id, r.path, r.line, r."column", r.context, r.category, r.body, r.created_at, r.resolved_at, u.name AS user_name
           FROM remarks r JOIN users u ON u.id = r.user_id
          WHERE r.project_id = ? AND r.path IS NULL
          ORDER BY r.created_at DESC`,
      )
      .all(id) as RemarkRow[];
  } else if (pathFilter) {
    rows = db
      .prepare(
        `SELECT r.id, r.user_id, r.project_id, r.path, r.line, r."column", r.context, r.category, r.body, r.created_at, r.resolved_at, u.name AS user_name
           FROM remarks r JOIN users u ON u.id = r.user_id
          WHERE r.project_id = ? AND r.path = ?
          ORDER BY r.created_at ASC`,
      )
      .all(id, pathFilter) as RemarkRow[];
  } else {
    rows = db
      .prepare(
        `SELECT r.id, r.user_id, r.project_id, r.path, r.line, r."column", r.context, r.category, r.body, r.created_at, r.resolved_at, u.name AS user_name
           FROM remarks r JOIN users u ON u.id = r.user_id
          WHERE r.project_id = ?
          ORDER BY r.created_at DESC`,
      )
      .all(id) as RemarkRow[];
  }

  const attachments = attachmentsByRemark(rows.map((r) => r.id));

  return NextResponse.json({
    remarks: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      path: r.path,
      line: r.line,
      column: r.column,
      context: r.context ? safeParseJson(r.context) : null,
      category: r.category,
      body: r.body,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
      attachments: attachments.get(r.id) ?? [],
    })),
  });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!canAccessProject(auth.user, id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const contentType = req.headers.get("content-type") ?? "";
  const isMultipart = contentType.includes("multipart/form-data");
  const tooLarge = tooLargeByContentLength(
    req,
    isMultipart ? MAX_MULTIPART_UPLOAD_BYTES : MAX_TEXT_JSON_BYTES,
  );
  if (tooLarge) return tooLarge;
  let body: string;
  let pathVal: string | null = null;
  let lineVal: number | null = null;
  let category: Category;
  let files: File[] = [];
  let contextJson: string | null = null;
  let columnVal: number | null = null;

  if (isMultipart) {
    const form = await req.formData();
    body = String(form.get("body") ?? "").trim();
    const p = form.get("path");
    pathVal = p && String(p).length > 0 ? String(p) : null;
    const l = form.get("line");
    const parsed = l ? Number(l) : NaN;
    lineVal = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
    const c = form.get("column");
    const parsedCol = c ? Number(c) : NaN;
    columnVal =
      Number.isFinite(parsedCol) && parsedCol > 0 ? Math.floor(parsedCol) : null;
    category = String(form.get("category") ?? "") as Category;
    const ctxRaw = form.get("context");
    if (typeof ctxRaw === "string" && ctxRaw.length > 0) {
      // Validate it's JSON; we don't want arbitrary strings in there
      try {
        JSON.parse(ctxRaw);
        contextJson = ctxRaw.length > 32_000 ? ctxRaw.slice(0, 32_000) : ctxRaw;
      } catch {
        /* ignore invalid context */
      }
    }
    for (const entry of form.getAll("files")) {
      if (entry instanceof File && entry.size > 0) files.push(entry);
    }
  } else {
    const json = (await req.json().catch(() => null)) as {
      path?: string | null;
      line?: number | null;
      column?: number | null;
      context?: unknown;
      category?: Category;
      body?: string;
    } | null;
    if (!json) {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    body = (json.body ?? "").trim();
    pathVal = json.path ?? null;
    columnVal =
      typeof json.column === "number" && Number.isFinite(json.column) && json.column > 0
        ? Math.floor(json.column)
        : null;
    if (json.context && typeof json.context === "object") {
      const s = JSON.stringify(json.context);
      contextJson = s.length > 32_000 ? s.slice(0, 32_000) : s;
    }
    lineVal =
      typeof json.line === "number" && Number.isFinite(json.line) && json.line > 0
        ? Math.floor(json.line)
        : null;
    category = (json.category ?? "other") as Category;
  }

  if (!body) {
    return NextResponse.json({ error: "body_required" }, { status: 400 });
  }
  // Post-parse cap on the user-typed text — defends against chunked
  // bodies that bypass the Content-Length pre-check above.
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_TEXT_BYTES) {
    return NextResponse.json({ error: "body_too_long" }, { status: 413 });
  }
  if (!["frontend", "backend", "other"].includes(category)) {
    return NextResponse.json({ error: "invalid_category" }, { status: 400 });
  }
  if (pathVal === null) {
    // line only meaningful on file-level remarks
    lineVal = null;
    columnVal = null;
  }
  if (files.length > MAX_FILES_PER_REMARK) {
    return NextResponse.json({ error: "too_many_files" }, { status: 400 });
  }

  const insert = getDb()
    .prepare(
      `INSERT INTO remarks
         (user_id, project_id, path, line, "column", context, category, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      auth.user.id,
      id,
      pathVal,
      lineVal,
      columnVal,
      contextJson,
      category,
      body,
      Date.now(),
    );
  const remarkId = Number(insert.lastInsertRowid);

  for (const file of files) {
    try {
      await saveAttachment(remarkId, file);
    } catch (err) {
      if (err instanceof AttachmentError) {
        // Partial failure: delete the remark so the client can retry cleanly.
        getDb().prepare("DELETE FROM remarks WHERE id = ?").run(remarkId);
        return NextResponse.json(
          { error: err.message },
          { status: 400 },
        );
      }
      throw err;
    }
  }

  broadcastRemark(id, pathVal ?? "", remarkId, "added");
  // Mirror into the project's chat channel so subscribers see remarks inline.
  ensureProjectChannels(auth.user);
  const ch = getDb()
    .prepare(
      "SELECT id FROM chat_channels WHERE kind = 'project' AND project_id = ?",
    )
    .get(id) as { id: number } | undefined;
  if (ch) broadcastChatRemark(ch.id, id, remarkId);
  return NextResponse.json({ id: remarkId });
}
