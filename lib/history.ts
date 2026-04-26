// Keep a bounded log of recent file changes per project, with the previous
// content so we can produce a diff. LRU by project, bounded memory.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { getProjectRoot, loadConfig } from "./config";

const MAX_EVENTS_PER_PROJECT = 100;
const MAX_CONTENT_BYTES = 128 * 1024; // 128 KB snapshots; bigger files skip the diff
// Hard ceiling on TOTAL bytes loaded into the snapshots Map by seedFromConfig.
// Seeding 6 codebases on this machine post-dedupe consumed ~2.3 GB of RSS at
// 256 KB/file with no global cap — close enough to the heap ceiling that one
// concurrent allocation OOM-killed the process. Bytes counted here are
// uncompressed UTF-8 file content; 200 MB lets us still seed thousands of
// real source files while leaving multi-GB headroom for everything else.
const MAX_SEED_BYTES_TOTAL = 200 * 1024 * 1024;
// Extensions worth seeding (text we'd realistically want a diff for). Anything
// not on this list still gets watched + reported as a change event — we just
// won't render a "previous content" diff. Keeps lock files, generated JSON,
// and exotic binary-ish text out of the snapshot Map.
const SEED_EXT_ALLOW = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".css", ".scss", ".sass", ".less",
  ".html", ".htm", ".xml", ".svg",
  ".vue", ".svelte", ".astro",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".php", ".sh",
  ".md", ".mdx", ".txt",
  ".yml", ".yaml", ".toml", ".ini", ".env",
  ".json", // common but capped via lockfile name skip below
]);
// Files whose content we never want in memory regardless of extension —
// they're huge, machine-generated, and useless as a diff target.
const SEED_NAME_SKIP = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock",
  "composer.lock", "Cargo.lock", "Gemfile.lock", "poetry.lock", "uv.lock",
]);
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

export interface HistoryEvent {
  id: number; // monotonic per process
  projectId: string;
  type: "add" | "change" | "unlink";
  path: string;
  ts: number;
  /** null = binary / oversized / no previous content */
  previous: string | null;
  current: string | null;
}

class HistoryStore extends EventEmitter {
  private byProject = new Map<string, HistoryEvent[]>();
  // previous content per "projectId\0relPath" so we can compute diffs on change
  private snapshots = new Map<string, string>();
  private idCounter = 0;

  async record(
    projectId: string,
    type: HistoryEvent["type"],
    relPath: string,
    absPath: string,
  ) {
    const key = `${projectId}\0${relPath}`;
    const ext = path.extname(relPath).toLowerCase();
    const binaryOrHidden = BINARY_EXTS.has(ext);

    let current: string | null = null;
    if (!binaryOrHidden && (type === "add" || type === "change")) {
      try {
        const stat = await fs.stat(absPath);
        if (stat.isFile() && stat.size <= MAX_CONTENT_BYTES) {
          current = await fs.readFile(absPath, "utf8");
        }
      } catch {
        /* race with unlink — ignore */
      }
    }
    const previous = this.snapshots.get(key) ?? null;
    if (type === "unlink") {
      this.snapshots.delete(key);
    } else if (current !== null) {
      this.snapshots.set(key, current);
    }

    const evt: HistoryEvent = {
      id: ++this.idCounter,
      projectId,
      type,
      path: relPath,
      ts: Date.now(),
      previous,
      current,
    };
    const arr = this.byProject.get(projectId) ?? [];
    arr.push(evt);
    if (arr.length > MAX_EVENTS_PER_PROJECT) {
      arr.splice(0, arr.length - MAX_EVENTS_PER_PROJECT);
    }
    this.byProject.set(projectId, arr);
    this.emit("event", evt);
    return evt;
  }

  recent(projectId: string, limit = 50): HistoryEvent[] {
    const arr = this.byProject.get(projectId) ?? [];
    return arr.slice(-limit).reverse();
  }

  // Cumulative bytes loaded into snapshots across all seed() calls. Used to
  // enforce MAX_SEED_BYTES_TOTAL so a freshly-cloned monorepo doesn't blow
  // the heap on first boot.
  private seedBytesLoaded = 0;

  /** Initial warm-up: read current file contents so diffs work from first change. */
  async seed(projectId: string, absRoot: string, relPaths: string[]) {
    let processed = 0;
    for (const rel of relPaths) {
      if (this.seedBytesLoaded >= MAX_SEED_BYTES_TOTAL) {
        // Hit the global byte budget. Stop seeding — affected files will
        // simply have previous=null on their first change event, which is
        // identical to how brand-new files behave.
        return;
      }
      // Yield to the event loop every 25 files so health probes, WS pings,
      // and HTTP requests don't queue up behind the seed read flood. Without
      // this the process hung the event loop long enough that the watchdog's
      // 8s probe-timeout fired and killed the task mid-seed.
      if (processed > 0 && processed % 25 === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
      processed++;
      const base = path.basename(rel);
      if (SEED_NAME_SKIP.has(base)) continue;
      const ext = path.extname(rel).toLowerCase();
      if (BINARY_EXTS.has(ext)) continue;
      if (!SEED_EXT_ALLOW.has(ext)) continue;
      const abs = path.join(absRoot, rel);
      try {
        const stat = await fs.stat(abs);
        if (stat.isFile() && stat.size <= MAX_CONTENT_BYTES) {
          const text = await fs.readFile(abs, "utf8");
          this.snapshots.set(`${projectId}\0${rel}`, text);
          this.seedBytesLoaded += text.length;
        }
      } catch {
        /* ignore */
      }
    }
  }
}

// Pin to globalThis so Next.js API routes (compiled in their own module
// context) see the same store the custom server is writing to.
declare global {
  // eslint-disable-next-line no-var
  var __amasoHistory: HistoryStore | undefined;
}

export function getHistory(): HistoryStore {
  if (!globalThis.__amasoHistory) {
    globalThis.__amasoHistory = new HistoryStore();
  }
  return globalThis.__amasoHistory;
}

/** Run once after the watcher is ready to preload current contents. */
export async function seedFromConfig() {
  const store = getHistory();
  const config = loadConfig();

  // Multiple project entries commonly point at the same codebase with a
  // different id + subPath (e.g. amaso-dashboard is split into 3 logical
  // "projects"; woonklasse-badkamerstijl hosts two subfolders). Walking the
  // same tree 3× and re-reading every file into the snapshot Map blew our
  // startup past the watchdog's probe timeout. Cache walks by resolved root
  // so each physical directory is read once.
  const walkCache = new Map<string, string[]>();
  const ignoreDirs = new Set(
    (config.ignore ?? []).filter((p) => !p.includes("*") && !p.includes(".")),
  );
  // Always exclude these, even if not in config.ignore — they never contain
  // project source and would dominate the walk.
  for (const d of ["node_modules", ".git", ".next", ".nuxt", ".output", ".vercel", ".claude", ".stfolder", ".stversions", "dist", "build", "coverage"]) {
    ignoreDirs.add(d);
  }

  for (const project of config.projects) {
    const root = getProjectRoot(project);
    let paths = walkCache.get(root);
    if (!paths) {
      paths = [];
      await walk(root, "", paths, 0, ignoreDirs);
      walkCache.set(root, paths);
    }
    await store.seed(project.id, root, paths);
  }
}

async function walk(
  root: string,
  rel: string,
  out: string[],
  depth: number,
  ignoreDirs: Set<string>,
): Promise<void> {
  if (depth > 8) return; // Keep this bounded
  const abs = path.join(root, rel);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (ignoreDirs.has(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(root, childRel, out, depth + 1, ignoreDirs);
    else if (e.isFile()) out.push(childRel);
  }
}
