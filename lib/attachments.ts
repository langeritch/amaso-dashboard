import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getDb } from "./db";

export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_FILES_PER_REMARK = 5;

// Whitelist by mime type. Keeps binaries / executables out.
// image/svg+xml is intentionally excluded: SVG can carry <script> and
// executes in the dashboard origin when served inline, giving any uploader
// stored XSS against every viewer.
const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain",
  "text/markdown",
]);

const STORAGE_ROOT = path.resolve(process.cwd(), "data", "remarks");
const CHAT_STORAGE_ROOT = path.resolve(process.cwd(), "data", "chat");

export interface AttachmentRow {
  id: number;
  remark_id: number;
  filename: string;
  mime_type: string;
  size: number;
  storage_key: string;
  created_at: number;
}

export async function saveAttachment(
  remarkId: number,
  file: File,
): Promise<AttachmentRow> {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new AttachmentError(`unsupported_type:${file.type}`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new AttachmentError("file_too_large");
  }
  const ext = sanitiseExt(file.name);
  const storageKey = `${crypto.randomUUID()}${ext}`;
  const dir = path.join(STORAGE_ROOT, String(remarkId));
  await fs.mkdir(dir, { recursive: true });
  const abs = path.join(dir, storageKey);
  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(abs, buf);

  const now = Date.now();
  const safeName = sanitiseFilename(file.name);
  const result = getDb()
    .prepare(
      "INSERT INTO remark_attachments (remark_id, filename, mime_type, size, storage_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(remarkId, safeName, file.type, file.size, storageKey, now);
  return {
    id: Number(result.lastInsertRowid),
    remark_id: remarkId,
    filename: safeName,
    mime_type: file.type,
    size: file.size,
    storage_key: storageKey,
    created_at: now,
  };
}

export function attachmentsByRemark(remarkIds: number[]): Map<
  number,
  Array<{ id: number; filename: string; mimeType: string; size: number }>
> {
  const out = new Map<
    number,
    Array<{ id: number; filename: string; mimeType: string; size: number }>
  >();
  if (remarkIds.length === 0) return out;
  const placeholders = remarkIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT id, remark_id, filename, mime_type, size
         FROM remark_attachments
        WHERE remark_id IN (${placeholders})
        ORDER BY id ASC`,
    )
    .all(...remarkIds) as Array<{
    id: number;
    remark_id: number;
    filename: string;
    mime_type: string;
    size: number;
  }>;
  for (const r of rows) {
    const arr = out.get(r.remark_id) ?? [];
    arr.push({
      id: r.id,
      filename: r.filename,
      mimeType: r.mime_type,
      size: r.size,
    });
    out.set(r.remark_id, arr);
  }
  return out;
}

export async function readAttachment(
  attachmentId: number,
): Promise<{ row: AttachmentRow; data: Buffer } | null> {
  const row = getDb()
    .prepare(
      "SELECT id, remark_id, filename, mime_type, size, storage_key, created_at FROM remark_attachments WHERE id = ?",
    )
    .get(attachmentId) as AttachmentRow | undefined;
  if (!row) return null;
  const abs = path.join(STORAGE_ROOT, String(row.remark_id), row.storage_key);
  try {
    const data = await fs.readFile(abs);
    return { row, data };
  } catch {
    return null;
  }
}

export async function deleteAttachmentsOfRemark(remarkId: number) {
  // CASCADE handles the row. Just wipe the files off disk.
  const dir = path.join(STORAGE_ROOT, String(remarkId));
  await fs.rm(dir, { recursive: true, force: true });
}

// --- Chat message attachments -------------------------------------------
// Same storage contract as remarks: binaries live on disk under
// data/chat/<message_id>/<storage_key>, metadata lives in SQLite.

export interface ChatAttachmentRow {
  id: number;
  message_id: number;
  filename: string;
  mime_type: string;
  size: number;
  storage_key: string;
  created_at: number;
}

export async function saveChatAttachment(
  messageId: number,
  file: File,
): Promise<ChatAttachmentRow> {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new AttachmentError(`unsupported_type:${file.type}`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new AttachmentError("file_too_large");
  }
  const ext = sanitiseExt(file.name);
  const storageKey = `${crypto.randomUUID()}${ext}`;
  const dir = path.join(CHAT_STORAGE_ROOT, String(messageId));
  await fs.mkdir(dir, { recursive: true });
  const abs = path.join(dir, storageKey);
  const buf = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(abs, buf);

  const now = Date.now();
  const safeName = sanitiseFilename(file.name);
  const result = getDb()
    .prepare(
      "INSERT INTO chat_message_attachments (message_id, filename, mime_type, size, storage_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(messageId, safeName, file.type, file.size, storageKey, now);
  return {
    id: Number(result.lastInsertRowid),
    message_id: messageId,
    filename: safeName,
    mime_type: file.type,
    size: file.size,
    storage_key: storageKey,
    created_at: now,
  };
}

export function chatAttachmentsByMessage(messageIds: number[]): Map<
  number,
  Array<{ id: number; filename: string; mimeType: string; size: number }>
> {
  const out = new Map<
    number,
    Array<{ id: number; filename: string; mimeType: string; size: number }>
  >();
  if (messageIds.length === 0) return out;
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT id, message_id, filename, mime_type, size
         FROM chat_message_attachments
        WHERE message_id IN (${placeholders})
        ORDER BY id ASC`,
    )
    .all(...messageIds) as Array<{
    id: number;
    message_id: number;
    filename: string;
    mime_type: string;
    size: number;
  }>;
  for (const r of rows) {
    const arr = out.get(r.message_id) ?? [];
    arr.push({
      id: r.id,
      filename: r.filename,
      mimeType: r.mime_type,
      size: r.size,
    });
    out.set(r.message_id, arr);
  }
  return out;
}

export async function readChatAttachment(
  attachmentId: number,
): Promise<{ row: ChatAttachmentRow; data: Buffer } | null> {
  const row = getDb()
    .prepare(
      "SELECT id, message_id, filename, mime_type, size, storage_key, created_at FROM chat_message_attachments WHERE id = ?",
    )
    .get(attachmentId) as ChatAttachmentRow | undefined;
  if (!row) return null;
  const abs = path.join(CHAT_STORAGE_ROOT, String(row.message_id), row.storage_key);
  try {
    const data = await fs.readFile(abs);
    return { row, data };
  } catch {
    return null;
  }
}

export class AttachmentError extends Error {}

function sanitiseFilename(name: string): string {
  return name.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 120) || "file";
}

function sanitiseExt(name: string): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(name);
  return m ? `.${m[1].toLowerCase()}` : "";
}
