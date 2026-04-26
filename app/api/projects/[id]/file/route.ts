import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInProject } from "@/lib/config";
import { apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";

export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024;
const BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".bin",
  ".woff",
  ".woff2",
  ".ttf",
  ".mp4",
  ".mov",
]);

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
  const relPath = url.searchParams.get("path") ?? "";
  if (!relPath) {
    return NextResponse.json({ error: "path_required" }, { status: 400 });
  }
  const abs = resolveInProject(id, relPath);
  if (!abs) {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!stat.isFile()) {
    return NextResponse.json({ error: "not_a_file" }, { status: 400 });
  }
  const ext = path.extname(abs).toLowerCase();
  if (BINARY_EXTS.has(ext)) {
    return NextResponse.json({
      path: relPath,
      size: stat.size,
      binary: true,
      content: null,
    });
  }
  if (stat.size > MAX_BYTES) {
    return NextResponse.json({
      path: relPath,
      size: stat.size,
      binary: false,
      truncated: true,
      content: null,
    });
  }
  const content = await fs.readFile(abs, "utf8");
  return NextResponse.json({
    path: relPath,
    size: stat.size,
    binary: false,
    content,
  });
}
