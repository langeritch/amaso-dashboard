/**
 * Remark #482 — brain markdown corpus search.
 *
 * Walks BRAIN_ROOT under a per-user allowlist, LIKE-matches the
 * query against each file's body, and returns ranked hits with
 * snippet + section anchor. Used by /api/spar/history/search to
 * unify subject + brain-file search alongside the existing message
 * + extracted-fact paths.
 *
 * Per-user scoping: the same allowlist semantics
 * /api/mobile/brain/route.ts already enforces — non-admins can only
 * see shared root-level files + their own users/<slug>/ subtree.
 * Admins can pass a target user to scope to that user's view.
 *
 * Cost discipline:
 *   - Caps the walked file count at MAX_FILES per call.
 *   - Caps total bytes read at MAX_TOTAL_BYTES so a runaway daily-log
 *     tree can't blow the request budget.
 *   - Skips daily/ logs older than DAILY_AGE_DAYS so 18 months of
 *     "what did I have for breakfast on 2025-07-14" don't dominate
 *     the result set.
 *   - Snippet renders +/- 80 chars around the match with <mark>
 *     wrapping; identical posture to message + fact search.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { BRAIN_ROOT, slugifyUser } from "./spar-brain";
import type { User } from "./db";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // 4 MB across the whole walk
const MAX_FILE_BYTES = 256 * 1024;       // cap per-file read
const SNIPPET_RADIUS = 80;
const DAILY_AGE_DAYS = 30;

// Mirror of SHARED_BRAIN_ALLOWLIST from lib/spar-tools-context.ts and
// app/api/mobile/brain/route.ts. Kept in sync by hand; if it ever
// diverges, the brain-acl tests in tests/brain-acl.test.ts catch the
// read/write side and this list will surface as "search returned a
// file the read endpoint refuses to load" — which is a louder failure
// than a silent drift.
const SHARED_BRAIN_ALLOWLIST: string[] = [
  "brain.md",
  "projects.md",
  "decisions.md",
  "lessons.md",
  "goals.md",
  "timeline.md",
  "people.md",
  "MEMORY.md",
  "daily/",
  "references/",
  "plans/",
];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BrainHit {
  /** Relative path from BRAIN_ROOT, forward slashes. */
  relPath: string;
  /** Section heading the match landed under (the nearest preceding
   *  H1/H2/H3), or null if the match was before any heading. */
  section: string | null;
  /** Snippet of the match with <mark>...</mark> wrapping the query. */
  snippet: string;
  /** Local date stamp parsed from daily/<date>.md or users/<slug>/daily/<date>.md.
   *  Null for non-daily-log files. */
  date: string | null;
  /** Total match count in this file (cap = 5 per file). */
  matches: number;
}

export interface BrainSearchOptions {
  /** Max files to read. Hard cap MAX_FILES. */
  maxFiles?: number;
  /** Optional per-search byte ceiling override. */
  maxTotalBytes?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build snippet centred on the first match in `text`. Returned as
 * already-escaped HTML with <mark>...</mark> around the matched
 * substring; consumer can drop into dangerouslySetInnerHTML.
 */
function buildSnippet(text: string, query: string): string {
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return escapeHtml(text.slice(0, 200));
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + query.length + SNIPPET_RADIUS);
  const before = text.slice(start, idx).replace(/\s+/g, " ");
  const hit = text.slice(idx, idx + query.length).replace(/\s+/g, " ");
  const after = text.slice(idx + query.length, end).replace(/\s+/g, " ");
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return (
    prefix +
    escapeHtml(before) +
    "<mark>" +
    escapeHtml(hit) +
    "</mark>" +
    escapeHtml(after) +
    suffix
  );
}

/** Extract the H1/H2/H3 heading immediately preceding the match
 *  index. Returns the raw heading text (without the leading '#'s) or
 *  null when the match sits before any heading. */
function nearestHeading(content: string, matchIndex: number): string | null {
  if (matchIndex <= 0) return null;
  const head = content.slice(0, matchIndex);
  const lines = head.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(#{1,3})\s+(.+?)\s*$/);
    if (m) return m[2].trim();
  }
  return null;
}

/** Pull the YYYY-MM-DD piece from daily log file paths.
 *  Matches "daily/2026-05-14.md" and "users/<slug>/daily/2026-05-14.md". */
function dateFromPath(rel: string): string | null {
  const m = rel.match(/\bdaily\/(\d{4}-\d{2}-\d{2})\.md$/);
  return m?.[1] ?? null;
}

/** Days-old-ness of a YYYY-MM-DD vs today's local date. */
function daysOld(date: string): number {
  const today = new Date().toLocaleDateString("en-CA");
  const [ty, tm, td] = today.split("-").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  if (!ty || !y) return 0;
  const a = Date.UTC(ty, tm - 1, td);
  const b = Date.UTC(y, mo - 1, d);
  return Math.floor((a - b) / (24 * 60 * 60_000));
}

/**
 * Decide whether a rel-path is visible to the given user. Mirrors
 * the ACL semantics enforced by lib/spar-tools-context.ts:resolveInBrain
 * but for read-only listing — no exceptions, returns true/false.
 */
function isVisibleTo(rel: string, user: User): boolean {
  const isAdmin = user.role === "admin";
  if (isAdmin) return true;
  if (rel.startsWith("users/")) {
    const slug = slugifyUser(user.name);
    return rel === `users/${slug}` || rel.startsWith(`users/${slug}/`);
  }
  for (const entry of SHARED_BRAIN_ALLOWLIST) {
    if (entry.endsWith("/")) {
      if (rel === entry.slice(0, -1) || rel.startsWith(entry)) return true;
    } else if (rel === entry) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public: searchBrain
// ---------------------------------------------------------------------------

interface WalkContext {
  user: User;
  query: string;
  qLower: string;
  hits: BrainHit[];
  bytesRead: number;
  filesRead: number;
  maxFiles: number;
  maxTotalBytes: number;
}

async function walk(dirAbs: string, dirRel: string, ctx: WalkContext): Promise<void> {
  if (ctx.filesRead >= ctx.maxFiles || ctx.bytesRead >= ctx.maxTotalBytes) return;

  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dirAbs, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (ctx.filesRead >= ctx.maxFiles || ctx.bytesRead >= ctx.maxTotalBytes) return;
    if (e.name.startsWith(".")) continue;
    const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
    const abs = path.join(dirAbs, e.name);

    if (e.isDirectory()) {
      // Prune subtrees the user can't see — both an ACL + a perf win.
      if (!isVisibleTo(rel, ctx.user) && !isPrefixOfVisible(rel, ctx.user)) {
        continue;
      }
      await walk(abs, rel, ctx);
      continue;
    }
    if (!e.isFile()) continue;
    if (!rel.endsWith(".md")) continue;
    if (!isVisibleTo(rel, ctx.user)) continue;

    // Daily-log freshness cap: skip files older than 30 days.
    const date = dateFromPath(rel);
    if (date && daysOld(date) > DAILY_AGE_DAYS) continue;

    let content: string;
    try {
      const buf = await fs.readFile(abs);
      const slice = buf.subarray(0, Math.min(buf.byteLength, MAX_FILE_BYTES));
      content = slice.toString("utf8");
      ctx.bytesRead += slice.byteLength;
      ctx.filesRead++;
    } catch {
      continue;
    }

    const lowered = content.toLowerCase();
    if (!lowered.includes(ctx.qLower)) continue;

    // Count matches (cap 5 per file) and emit a hit for the FIRST match
    // location — multi-match-per-file would explode result count for
    // dense daily logs.
    let count = 0;
    let from = 0;
    while (count < 5) {
      const idx = lowered.indexOf(ctx.qLower, from);
      if (idx < 0) break;
      count++;
      from = idx + ctx.qLower.length;
    }
    ctx.hits.push({
      relPath: rel,
      section: nearestHeading(content, lowered.indexOf(ctx.qLower)),
      snippet: buildSnippet(content, ctx.query),
      date,
      matches: count,
    });
  }
}

/** True when `rel` is a prefix of some path the user can see — used
 *  to keep walking shallower-than-visible directories (e.g. "users/"
 *  is not visible itself but contains "users/<slug>/" which is). */
function isPrefixOfVisible(rel: string, user: User): boolean {
  if (user.role === "admin") return true;
  // Empty rel = root → always recurse.
  if (!rel) return true;
  // users/ is a prefix of users/<slug>/ — recurse.
  if (rel === "users") return true;
  // The allowlisted directory prefixes (daily, references, plans) ARE
  // themselves visible by isVisibleTo, so this only catches "users".
  return false;
}

export async function searchBrain(
  user: User,
  query: string,
  opts: BrainSearchOptions = {},
): Promise<BrainHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const ctx: WalkContext = {
    user,
    query: q,
    qLower: q.toLowerCase(),
    hits: [],
    bytesRead: 0,
    filesRead: 0,
    maxFiles: Math.min(Math.max(opts.maxFiles ?? MAX_FILES, 1), MAX_FILES),
    maxTotalBytes: Math.min(
      Math.max(opts.maxTotalBytes ?? MAX_TOTAL_BYTES, 1),
      MAX_TOTAL_BYTES,
    ),
  };
  try {
    await walk(BRAIN_ROOT, "", ctx);
  } catch (err) {
    console.warn(
      "[brain-search] walk failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  // Sort: dated daily-log hits first (newest day descending), then
  // non-dated files alphabetical. Within the same file we already
  // emit only one hit so global ordering by rel-path is fine.
  ctx.hits.sort((a, b) => {
    if (a.date && b.date) return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    if (a.date) return -1;
    if (b.date) return 1;
    return a.relPath.localeCompare(b.relPath);
  });
  return ctx.hits;
}
