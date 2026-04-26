// Filesystem-level snapshot + rollback for the dashboard's own code.
//
// Used as a safety net when Claude edits this repo (the one running the
// dashboard itself): if the admin doesn't approve the resulting remarks
// within a grace window, we undo every file Claude touched so the
// dashboard doesn't get stuck in a broken state the admin can no longer
// interact with.
//
// Scope: text files only, bounded size, walking a conservative ignore
// list. Binaries, the SQLite DB, and generated output are left alone.

import fs from "node:fs/promises";
import path from "node:path";

const MAX_BYTES = 512 * 1024;

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".pdf", ".zip", ".tar", ".gz", ".exe", ".dll", ".bin",
  ".woff", ".woff2", ".ttf", ".mp4", ".mov",
  ".db", ".db-journal", ".sqlite", ".sqlite-journal",
]);

const IGNORE_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".stfolder",
  ".stversions",
  ".vercel",
  ".claude",
  "dist",
  "build",
  "coverage",
  "data",
  "logs",
]);

async function walk(
  root: string,
  rel: string,
  out: string[],
  depth = 0,
): Promise<void> {
  if (depth > 10) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, childRel, out, depth + 1);
    else if (e.isFile()) out.push(childRel);
  }
}

export async function snapshotProject(
  root: string,
): Promise<Map<string, string>> {
  const rels: string[] = [];
  await walk(root, "", rels);
  const map = new Map<string, string>();
  await Promise.all(
    rels.map(async (rel) => {
      const ext = path.extname(rel).toLowerCase();
      if (BINARY_EXTS.has(ext)) return;
      const abs = path.join(root, rel);
      try {
        const stat = await fs.stat(abs);
        if (!stat.isFile() || stat.size > MAX_BYTES) return;
        map.set(rel, await fs.readFile(abs, "utf8"));
      } catch {
        /* race with deletion — skip */
      }
    }),
  );
  return map;
}

/**
 * Restore every file in `snapshot` to its captured content, and delete any
 * newly-created text file that wasn't in the snapshot. Returns the list of
 * relative paths that were actually changed so callers can log a summary.
 */
export async function restoreSnapshot(
  root: string,
  snapshot: Map<string, string>,
): Promise<string[]> {
  const touched: string[] = [];

  for (const [rel, original] of snapshot) {
    const abs = path.join(root, rel);
    let current: string | null = null;
    try {
      current = await fs.readFile(abs, "utf8");
    } catch {
      current = null; // file was deleted — recreate it
    }
    if (current === original) continue;
    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, original, "utf8");
      touched.push(rel);
    } catch {
      /* ignore per-file failures; best effort */
    }
  }

  const now: string[] = [];
  await walk(root, "", now);
  for (const rel of now) {
    if (snapshot.has(rel)) continue;
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXTS.has(ext)) continue;
    const abs = path.join(root, rel);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      await fs.unlink(abs);
      touched.push(rel);
    } catch {
      /* ignore */
    }
  }

  return touched;
}
