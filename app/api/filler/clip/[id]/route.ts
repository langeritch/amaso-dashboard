import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Streams a single filler-cache WAV to the browser. IDs come from
 * `/api/filler/clips` — never user-typed — but we still lock the
 * format down with a strict regex + a startsWith boundary check so
 * a bug anywhere upstream can't turn this into a file-read primitive.
 */

const CACHE_ROOT = path.resolve(process.cwd(), "telegram-voice", "filler-cache");
// id can be "news-<hex16>" | "silence-<ms>ms" — no slashes, no
// dots, no traversal. The route only serves files the Python side
// can legitimately have written.
const ID_RE = /^(?:news-[0-9a-f]{16}|silence-\d+ms)$/i;

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) {
    return new NextResponse("bad id", { status: 400 });
  }
  const target = path.join(CACHE_ROOT, `${id}.wav`);
  // Defence-in-depth: even with the strict regex above, double-check
  // that the resolved path stays inside the cache root.
  if (!target.startsWith(CACHE_ROOT + path.sep)) {
    return new NextResponse("bad id", { status: 400 });
  }
  let buf: Buffer;
  try {
    buf = await readFile(target);
  } catch {
    return new NextResponse("not found", { status: 404 });
  }
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(buf.byteLength),
      // Clips are content-addressed by hash, so once served they can
      // cache aggressively. The silence bridge is effectively static
      // too.
      "Cache-Control": "public, max-age=3600, immutable",
    },
  });
}
