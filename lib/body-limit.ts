import { NextResponse } from "next/server";

// Pre-parse body-size guard. Streaming the request body byte-by-byte
// would be the bulletproof option, but Next.js's `req.json()` and
// `req.formData()` already buffer the whole body in memory, so the
// only cheap defence is to look at the declared Content-Length and
// bail early. Chunked uploads without a Content-Length still pass —
// callers should also sanity-check the parsed body where it matters.
export function tooLargeByContentLength(
  req: Request,
  max: number,
): NextResponse | null {
  const raw = req.headers.get("content-length");
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= max) return null;
  return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
}

// Default caps. JSON bodies for chat/remarks/heartbeat carry only
// short text + a context blob, so 64 KB is plenty. Multipart uploads
// allow 5 files × 5 MB plus form overhead.
export const MAX_TEXT_JSON_BYTES = 64 * 1024;
export const MAX_HEARTBEAT_BYTES = 32 * 1024;
export const MAX_MULTIPART_UPLOAD_BYTES = 30 * 1024 * 1024;
// Cap on the user-typed body field after parsing — defends against
// chunked bodies that slipped past the Content-Length check.
export const MAX_BODY_TEXT_BYTES = 16 * 1024;
