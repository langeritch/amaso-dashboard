// Server-side implementations of the tools exposed to the spar MCP server.
// Each function takes a SparContext (with the acting user) and tool args,
// returns a JSON-serializable result, and throws on validation failures.
// The internal API route and any future in-process callers share this.

import fs from "node:fs/promises";
import { getProject, resolveInProject } from "./config";
import { visibleProjects, canAccessProject } from "./access";
import { readHeartbeat, writeHeartbeat } from "./heartbeat";
import { getHistory } from "./history";
import { getSession, write as writeTerminal } from "./terminal";
import { getDb, type User } from "./db";
import { dispatchToProject } from "./spar-dispatch";
import { readGraph, writeGraph, type SparGraph } from "./spar-graph";
import { broadcastRemark } from "./ws";
import { deleteAttachmentsOfRemark } from "./attachments";

const MAX_SCROLLBACK_TAIL = 262_144; // 256 KB — enough for any session the PTY ring holds
const DEFAULT_SCROLLBACK_TAIL = 16_000;
const MAX_FILE_BYTES = 32 * 1024;

// Strip ANSI escape sequences from raw PTY output so Haiku can actually
// read it. Covers CSI (ESC [ ...), OSC (ESC ] ... BEL), DCS/SOS/PM/APC,
// and simple two-char escapes.
export const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:\][^\x07]*\x07|[PX^_][^\x1B]*\x1B\\|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
// Braille spinner dots + Unicode box-drawing + block elements used by
// Claude Code's TUI chrome.
export const TUI_CHROME_REGEX = /[─-▟⠀-⣿]/g;
// eslint-disable-next-line no-control-regex
const CARRIAGE_OVERWRITE_REGEX = /^.*\r(?!\n)/gm;

// Whole lines to drop: Claude Code's status and chrome decorations.
// Each regex matches a single line after ANSI + box-drawing strip.
const LINE_NOISE_REGEXES: RegExp[] = [
  /^\s*(cogitat\w*|baking|thinking|churning|processing|pondering|musing|deliberating|crafting|scheming|simmering|brewing)\b.*for\s+\d.*$/i,
  /^\s*\*\s+(cogitat\w*|baking|thinking|churning|processing|pondering).*$/i,
  /^.*\(esc to interrupt\).*$/i,
  /^.*\(shift\+tab.*\).*$/i,
  /^.*\(ctrl\+c.*\).*$/i,
  /^.*press\s+(enter|return)\s+to.*$/i,
  /^\s*auto-update.*$/i,
  /^\s*welcome to claude code.*$/i,
  /^\s*\*\s*tip:\s+.*$/i,
  /^\s*learn more at .*anthropic.*$/i,
  /^\s*try\s+"\/".*$/i,
  /^\s*›\s*$/,
  /^\s*\$\s*$/,
];

export function cleanScrollback(raw: string): string {
  let s = raw.replace(ANSI_REGEX, "");
  // Collapse carriage-return overwrites (status lines that rewrite the
  // same row). Keep only the last version of each \r-overwritten line.
  s = s.replace(CARRIAGE_OVERWRITE_REGEX, "");
  s = s.replace(TUI_CHROME_REGEX, "");
  // Drop noise lines wholesale.
  s = s
    .split(/\r?\n/)
    .filter((line) => !LINE_NOISE_REGEXES.some((rx) => rx.test(line)))
    .join("\n");
  // Compress runs of blank lines.
  s = s.replace(/\n{3,}/g, "\n\n");
  // Trim trailing whitespace on each line.
  s = s.replace(/[ \t]+$/gm, "");
  return s.trimEnd();
}

export function detectTerminalState(
  clean: string,
): { state: string; hint: string } {
  const tailLines = clean.split(/\r?\n/).slice(-40);
  const tailText = tailLines.join("\n");
  const lower = tailText.toLowerCase();

  const hasYesNoMenu =
    /\b1\.\s*yes\b/i.test(tailText) && /\b2\.\s*no\b/i.test(tailText);
  if (
    hasYesNoMenu ||
    /do you want to (proceed|make|run|continue)/i.test(tailText) ||
    /approve this (bash|edit|write|tool)/i.test(lower) ||
    /\bpermission to\b/i.test(lower)
  ) {
    return {
      state: "permission_gate",
      hint:
        "Claude Code is waiting on a permission prompt. Describe it plainly " +
        "('it's asking if it can run X') and ask the user how to respond. " +
        "If they approve, send '1' via send_keys_to_project.",
    };
  }
  if (/cogitat|baking|thinking|churning|processing/i.test(lower)) {
    return {
      state: "thinking",
      hint: "Claude Code is still processing — let it run, don't narrate the status line.",
    };
  }
  const lastLine = tailLines.map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (/^[>│▌]\s*$/.test(lastLine) || /^\s*>\s*$/.test(lastLine)) {
    return {
      state: "at_prompt",
      hint: "Claude Code is idle at its input prompt.",
    };
  }
  return {
    state: "unknown",
    hint: "State unclear from scrollback — summarize what's visible in plain prose.",
  };
}

export interface SparContext {
  user: User;
  /** The bearer token that scoped this CLI invocation. Kept in the
   *  context for future per-turn features; unused by current tools. */
  token: string;
}

function getStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`missing string arg: ${key}`);
  return v;
}

function getOptNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`bad number arg: ${key}`);
  return v;
}

export function listProjects(ctx: SparContext) {
  const projects = visibleProjects(ctx.user);
  return projects.map((p) => {
    const session = getSession(p.id);
    return {
      id: p.id,
      name: p.name,
      visibility: p.visibility,
      previewUrl: p.previewUrl ?? null,
      liveUrl: p.liveUrl ?? null,
      devPort: p.devPort ?? null,
      terminalRunning: !!session,
      terminalStartedAt: session ? session.startedAt : null,
    };
  });
}

export function readHeartbeatTool(ctx: SparContext) {
  const body = readHeartbeat(ctx.user.id);
  return { userId: ctx.user.id, body: body || "" };
}

export function readTerminalScrollback(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  const projectId = getStr(args, "project_id");
  if (!canAccessProject(ctx.user, projectId)) {
    throw new Error("forbidden: no access to this project");
  }
  const tailRaw = getOptNum(args, "tail_chars") ?? DEFAULT_SCROLLBACK_TAIL;
  const tail = Math.min(Math.max(500, Math.floor(tailRaw)), MAX_SCROLLBACK_TAIL);
  const raw = args.raw === true;
  const session = getSession(projectId);
  if (!session) {
    return {
      projectId,
      running: false,
      scrollback: "",
      note: "terminal not running — no scrollback available",
    };
  }
  const sb = session.scrollback;
  const rawTail = sb.slice(Math.max(0, sb.length - tail));
  // State detection always runs on the raw-tail minus ANSI — the TUI
  // jargon is exactly what gives the state away.
  const forState = rawTail.replace(ANSI_REGEX, "").replace(TUI_CHROME_REGEX, "");
  const { state, hint } = detectTerminalState(forState);
  const scrollback = raw ? rawTail : cleanScrollback(rawTail);
  return {
    projectId,
    running: true,
    startedAt: session.startedAt,
    scrollback,
    state,
    hint,
    raw,
    truncated: sb.length > tail,
    totalBytes: sb.length,
    tailBytes: tail,
  };
}

export function listRecentFileChanges(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  const projectId = getStr(args, "project_id");
  if (!canAccessProject(ctx.user, projectId)) {
    throw new Error("forbidden: no access to this project");
  }
  const limit = Math.min(50, Math.max(1, Math.floor(getOptNum(args, "limit") ?? 20)));
  const events = getHistory().recent(projectId, limit);
  return events.map((e) => ({
    id: e.id,
    type: e.type,
    path: e.path,
    ts: e.ts,
    hasDiff: e.previous !== null && e.current !== null,
  }));
}

interface RemarkRow {
  id: number;
  user_id: number;
  project_id: string;
  path: string | null;
  line: number | null;
  category: string;
  body: string;
  created_at: number;
  updated_at: number | null;
  resolved_at: number | null;
  tags: string | null; // JSON-encoded string array, nullable
  user_name: string | null;
}

type RemarkView = {
  id: number;
  projectId: string;
  author: string;
  path: string | null;
  line: number | null;
  category: string;
  body: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  resolved: boolean;
  resolvedAt: number | null;
};

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string")
      .map((t) => t.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function remarkRowToView(r: RemarkRow): RemarkView {
  const tags = parseTags(r.tags);
  return {
    id: r.id,
    projectId: r.project_id,
    author: r.user_name ?? `#${r.user_id}`,
    path: r.path,
    line: r.line,
    category: r.category,
    body: r.body,
    tags,
    createdAt: r.created_at,
    updatedAt: r.updated_at ?? r.created_at,
    resolved: r.resolved_at !== null,
    resolvedAt: r.resolved_at,
  };
}

const REMARK_SELECT = `
  SELECT r.id, r.user_id, r.project_id, r.path, r.line, r.category, r.body,
         r.created_at, r.updated_at, r.resolved_at, r.tags,
         u.name AS user_name
    FROM remarks r
    LEFT JOIN users u ON u.id = r.user_id
`;

function getRemarkOrThrow(ctx: SparContext, remarkId: number): RemarkRow {
  const row = getDb()
    .prepare(`${REMARK_SELECT} WHERE r.id = ?`)
    .get(remarkId) as RemarkRow | undefined;
  if (!row) throw new Error(`remark ${remarkId} not found`);
  if (!canAccessProject(ctx.user, row.project_id)) {
    throw new Error("forbidden: no access to this project");
  }
  return row;
}

export function listRecentRemarks(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  const limit = Math.min(50, Math.max(1, Math.floor(getOptNum(args, "limit") ?? 10)));
  const projectId =
    typeof args.project_id === "string" && args.project_id
      ? args.project_id
      : undefined;

  // `resolved`: true → only resolved, false → only open, undefined → both.
  const resolvedRaw = args.resolved;
  const resolvedFilter =
    typeof resolvedRaw === "boolean" ? resolvedRaw : undefined;

  const tagFilter =
    typeof args.tag === "string" && args.tag ? args.tag.trim().toLowerCase() : undefined;

  // Project access: if a specific project was requested, check that
  // project. If not, we'll filter results to projects the user can see.
  if (projectId && !canAccessProject(ctx.user, projectId)) {
    throw new Error("forbidden: no access to this project");
  }

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (projectId) {
    where.push("r.project_id = ?");
    params.push(projectId);
  }
  if (resolvedFilter === true) where.push("r.resolved_at IS NOT NULL");
  if (resolvedFilter === false) where.push("r.resolved_at IS NULL");
  // Grab an over-fetch window when tag filtering client-side, since
  // sqlite JSON_CONTAINS semantics aren't available on every build.
  const sql = `
    ${REMARK_SELECT}
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY r.created_at DESC
    LIMIT ?
  `;
  const fetchLimit = tagFilter ? Math.max(limit * 4, 50) : limit;
  const rows = getDb()
    .prepare(sql)
    .all(...params, fetchLimit) as RemarkRow[];

  let views = rows
    .filter((r) => (projectId ? true : canAccessProject(ctx.user, r.project_id)))
    .map(remarkRowToView);
  if (tagFilter) {
    views = views.filter((v) =>
      v.tags.some((t) => t.toLowerCase() === tagFilter),
    );
  }
  return views.slice(0, limit);
}

function normalizeTags(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) throw new Error("tags must be an array of strings");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (typeof t !== "string") throw new Error("tags must be an array of strings");
    const trimmed = t.trim();
    if (!trimmed) continue;
    if (trimmed.length > 40) throw new Error("tag too long (>40 chars)");
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  if (out.length > 20) throw new Error("too many tags (max 20)");
  return out;
}

export function createRemarkTool(
  ctx: SparContext,
  args: Record<string, unknown>,
): RemarkView {
  const projectId = getStr(args, "project_id");
  const content = getStr(args, "content").trim();
  if (!content) throw new Error("content must not be empty");
  if (content.length > 10_000) throw new Error("content too long (>10000 chars)");
  if (!canAccessProject(ctx.user, projectId)) {
    throw new Error("forbidden: no access to this project");
  }
  if (!getProject(projectId)) {
    throw new Error(`unknown project: ${projectId}`);
  }
  const tags = normalizeTags(args.tags) ?? [];
  // Category is required by the schema but not meaningful for
  // assistant-created remarks — default to "other" and let the UI
  // recategorise if needed.
  const now = Date.now();
  const info = getDb()
    .prepare(
      `INSERT INTO remarks (user_id, project_id, path, line, category, body,
                            created_at, updated_at, tags)
       VALUES (?, ?, NULL, NULL, 'other', ?, ?, ?, ?)`,
    )
    .run(ctx.user.id, projectId, content, now, now, JSON.stringify(tags));
  const id = Number(info.lastInsertRowid);
  broadcastRemark(projectId, "", id, "added");
  const row = getRemarkOrThrow(ctx, id);
  return remarkRowToView(row);
}

export function editRemarkTool(
  ctx: SparContext,
  args: Record<string, unknown>,
): RemarkView {
  const remarkId = Math.floor(getOptNum(args, "remark_id") ?? NaN);
  if (!Number.isFinite(remarkId) || remarkId <= 0) {
    throw new Error("remark_id must be a positive integer");
  }
  const existing = getRemarkOrThrow(ctx, remarkId);

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (args.content !== undefined) {
    const content =
      typeof args.content === "string" ? args.content.trim() : "";
    if (!content) throw new Error("content must not be empty");
    if (content.length > 10_000) throw new Error("content too long (>10000 chars)");
    updates.push("body = ?");
    params.push(content);
  }
  if (args.tags !== undefined) {
    const tags = normalizeTags(args.tags);
    updates.push("tags = ?");
    params.push(tags ? JSON.stringify(tags) : null);
  }

  if (updates.length === 0) {
    // No-op edit — still return the current view so the assistant
    // can confirm nothing changed.
    return remarkRowToView(existing);
  }

  const now = Date.now();
  updates.push("updated_at = ?");
  params.push(now);
  params.push(remarkId);

  getDb()
    .prepare(`UPDATE remarks SET ${updates.join(", ")} WHERE id = ?`)
    .run(...params);

  const after = getRemarkOrThrow(ctx, remarkId);
  broadcastRemark(after.project_id, after.path ?? "", remarkId, "added");
  return remarkRowToView(after);
}

function setResolved(
  ctx: SparContext,
  args: Record<string, unknown>,
  resolved: boolean,
): RemarkView {
  const remarkId = Math.floor(getOptNum(args, "remark_id") ?? NaN);
  if (!Number.isFinite(remarkId) || remarkId <= 0) {
    throw new Error("remark_id must be a positive integer");
  }
  const existing = getRemarkOrThrow(ctx, remarkId);
  const now = Date.now();
  const resolvedAt = resolved ? now : null;
  getDb()
    .prepare(`UPDATE remarks SET resolved_at = ?, updated_at = ? WHERE id = ?`)
    .run(resolvedAt, now, remarkId);
  const after = getRemarkOrThrow(ctx, remarkId);
  broadcastRemark(existing.project_id, existing.path ?? "", remarkId, "added");
  return remarkRowToView(after);
}

export function resolveRemarkTool(
  ctx: SparContext,
  args: Record<string, unknown>,
): RemarkView {
  return setResolved(ctx, args, true);
}

export function unresolveRemarkTool(
  ctx: SparContext,
  args: Record<string, unknown>,
): RemarkView {
  return setResolved(ctx, args, false);
}

export async function deleteRemarkTool(
  ctx: SparContext,
  args: Record<string, unknown>,
): Promise<{ ok: true; deleted: number; projectId: string }> {
  const remarkId = Math.floor(getOptNum(args, "remark_id") ?? NaN);
  if (!Number.isFinite(remarkId) || remarkId <= 0) {
    throw new Error("remark_id must be a positive integer");
  }
  const existing = getRemarkOrThrow(ctx, remarkId);
  // CASCADE drops attachment rows; we still have to remove the files.
  await deleteAttachmentsOfRemark(remarkId);
  getDb().prepare("DELETE FROM remarks WHERE id = ?").run(remarkId);
  broadcastRemark(existing.project_id, existing.path ?? "", remarkId, "deleted");
  return { ok: true, deleted: remarkId, projectId: existing.project_id };
}

export async function readProjectFile(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  const projectId = getStr(args, "project_id");
  const relPath = getStr(args, "rel_path");
  if (!canAccessProject(ctx.user, projectId)) {
    throw new Error("forbidden: no access to this project");
  }
  const abs = resolveInProject(projectId, relPath);
  if (!abs) throw new Error("invalid path (outside project root)");
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error("not a file");
  const size = stat.size;
  const truncated = size > MAX_FILE_BYTES;
  const fh = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
    await fh.read(buf, 0, buf.length, 0);
    const text = buf.toString("utf8");
    return { projectId, path: relPath, size, truncated, content: text };
  } finally {
    await fh.close();
  }
}

export function describeProject(ctx: SparContext, args: Record<string, unknown>) {
  const projectId = getStr(args, "project_id");
  if (!canAccessProject(ctx.user, projectId)) {
    throw new Error("forbidden: no access to this project");
  }
  const p = getProject(projectId);
  if (!p) throw new Error("unknown project");
  const session = getSession(projectId);
  const recent = getHistory().recent(projectId, 5);
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    subPath: p.subPath ?? null,
    previewUrl: p.previewUrl ?? null,
    liveUrl: p.liveUrl ?? null,
    devPort: p.devPort ?? null,
    visibility: p.visibility,
    terminal: session
      ? { running: true, startedAt: session.startedAt, bytes: session.scrollback.length }
      : { running: false },
    recentChanges: recent.map((e) => ({ type: e.type, path: e.path, ts: e.ts })),
  };
}

export function sendKeysToProjectTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  const projectId = getStr(args, "project_id");
  const keys = getStr(args, "keys");
  if (!canAccessProject(ctx.user, projectId)) {
    throw new Error("forbidden: no access to this project");
  }
  if (!getSession(projectId)) {
    throw new Error("terminal not running — nothing to send keys to");
  }
  // Translate named tokens to their control sequences. Everything else
  // passes through verbatim, so "1" or "y" goes through as-is. No auto-
  // Enter — caller must include <enter> if they want to submit.
  const translated = keys
    .replace(/<enter>/gi, "\r")
    .replace(/<up>/gi, "\x1b[A")
    .replace(/<down>/gi, "\x1b[B")
    .replace(/<right>/gi, "\x1b[C")
    .replace(/<left>/gi, "\x1b[D")
    .replace(/<esc>/gi, "\x1b")
    .replace(/<tab>/gi, "\t")
    .replace(/<bs>/gi, "\x7f")
    .replace(/<space>/gi, " ");
  if (translated.length > 500) throw new Error("keys too long (>500 chars)");
  const ok = writeTerminal(projectId, translated, ctx.user.id);
  if (!ok) throw new Error("failed to send keys");
  return { ok: true, sent: keys, bytes: translated.length };
}

export function dispatchToProjectTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  const projectId = getStr(args, "project_id");
  const prompt = getStr(args, "prompt");
  if (!canAccessProject(ctx.user, projectId)) {
    throw new Error("forbidden: no access to this project");
  }
  const entry = dispatchToProject(ctx.user.id, projectId, prompt);
  if (entry.status === "failed") {
    throw new Error(entry.error ?? "dispatch failed");
  }
  return {
    id: entry.id,
    projectId: entry.projectId,
    confirmedAt: entry.confirmedAt,
    bytes: entry.prompt.length,
  };
}

export function readGraphTool(ctx: SparContext) {
  return readGraph(ctx.user.id);
}

export function writeGraphTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  const graph = args.graph;
  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    throw new Error("graph arg must be a JSON object");
  }
  // Quick-reject absurd sizes so a runaway write can't bloat the file
  // beyond what read_graph can cheaply return each turn.
  const serialized = JSON.stringify(graph);
  if (serialized.length > 64 * 1024) {
    throw new Error("graph too large (>64 KB) — keep entries terse");
  }
  const next = writeGraph(ctx.user.id, graph as Partial<SparGraph>);
  return {
    ok: true,
    updatedAt: next.updatedAt,
    counts: {
      projects: Object.keys(next.projects).length,
      commitments: next.commitments.length,
      blockers: next.blockers.length,
      decisions: next.decisions.length,
      people: Object.keys(next.people).length,
      connections: next.connections.length,
      milestones: next.milestones.length,
    },
  };
}

export function updateHeartbeatTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  const body = getStr(args, "body");
  if (body.length > 16_000) throw new Error("heartbeat body too long (>16000 chars)");
  writeHeartbeat(ctx.user.id, body);
  return { ok: true, userId: ctx.user.id, bytes: body.length };
}

// ---- YouTube filler tools -------------------------------------------------

function getOptStr(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

async function youtubeSearchTool(
  _ctx: SparContext,
  args: Record<string, unknown>,
) {
  const query = getStr(args, "query").trim();
  if (query.length > 200) throw new Error("query too long (>200 chars)");
  const { searchYouTube } = await import("./youtube-search");
  const results = await searchYouTube(query);
  return { query, results };
}

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_URL_ID_RE =
  /(?:youtube\.com\/(?:watch\?[^#]*?\bv=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

function extractVideoId(raw: string): string | null {
  const cleaned = raw.trim();
  if (YT_ID_RE.test(cleaned)) return cleaned;
  const m = cleaned.match(YT_URL_ID_RE);
  return m ? m[1] : null;
}

async function youtubePlayTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  // Accepts any of: { video_id } | { url } | { query }. Resolves to
  // a canonical 11-char id before hitting the state module. Also
  // flips the filler mode to "youtube" so the newly-selected video
  // actually takes effect on the dashboard — otherwise a "play
  // lo-fi beats" call would silently sit behind news mode.
  const rawVideoId = getOptStr(args, "video_id");
  const url = getOptStr(args, "url");
  const query = getOptStr(args, "query");
  let videoId: string | null = null;
  let resolvedTitle: string | null = getOptStr(args, "title");
  let resolvedDuration: number | null = null;
  let resolvedThumb: string | null = getOptStr(args, "thumbnail_url");

  if (rawVideoId) {
    videoId = extractVideoId(rawVideoId);
    if (!videoId) throw new Error(`invalid video_id: ${rawVideoId.slice(0, 40)}`);
  } else if (url) {
    videoId = extractVideoId(url);
    if (!videoId) throw new Error(`could not parse video id from url: ${url.slice(0, 80)}`);
  } else if (query) {
    const { searchYouTube } = await import("./youtube-search");
    const results = await searchYouTube(query, 1);
    if (results.length === 0) {
      throw new Error(`no YouTube results for query: ${query.slice(0, 80)}`);
    }
    const top = results[0];
    videoId = top.id;
    resolvedTitle = resolvedTitle ?? top.title;
    resolvedDuration = top.durationSec ?? null;
    resolvedThumb = resolvedThumb ?? top.thumbnailUrl;
  } else {
    throw new Error("one of video_id / url / query is required");
  }

  const durArg = getOptNum(args, "duration_sec");
  const finalDuration = durArg ?? resolvedDuration;

  // The video_id / url paths above don't go through search, so the
  // now-playing card would render "untitled video" unless the caller
  // happened to pass a title. Backfill via oEmbed before we commit
  // state so the dashboard always shows the real title.
  if (!resolvedTitle || !resolvedThumb) {
    const { fetchYouTubeMeta } = await import("./youtube-search");
    const meta = await fetchYouTubeMeta(videoId);
    resolvedTitle = resolvedTitle ?? meta.title;
    resolvedThumb = resolvedThumb ?? meta.thumbnailUrl;
  }

  const { playYouTube } = await import("./youtube-state");
  const state = playYouTube(ctx.user.id, {
    videoId,
    title: resolvedTitle,
    thumbnailUrl: resolvedThumb,
    durationSec: finalDuration,
  });
  // Flip filler mode to "youtube" so the selection actually plays.
  // Users can switch back with filler_set_mode({mode:"news"}) or
  // youtube_stop (which also resets mode).
  const { setFillerMode } = await import("./filler-mode");
  try {
    await setFillerMode("youtube");
  } catch (err) {
    // Non-fatal: the video state is set regardless; this only
    // affects which mode the browser respects.
    // eslint-disable-next-line no-console
    console.warn(`[youtube_play] setFillerMode failed: ${String(err).slice(0, 120)}`);
  }
  return { ok: true, videoId, mode: "youtube", state };
}

async function youtubeEnqueueTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  // Same arg surface as youtube_play (video_id | url | query) so users
  // can switch between "play this" and "queue this" without learning a
  // second syntax. If nothing is currently playing, the server promotes
  // the first enqueued item into now-playing — same behaviour as
  // /play, but without clearing any other queued tracks.
  const rawVideoId = getOptStr(args, "video_id");
  const url = getOptStr(args, "url");
  const query = getOptStr(args, "query");
  let videoId: string | null = null;
  let resolvedTitle: string | null = getOptStr(args, "title");
  let resolvedDuration: number | null = null;
  let resolvedThumb: string | null = getOptStr(args, "thumbnail_url");

  if (rawVideoId) {
    videoId = extractVideoId(rawVideoId);
    if (!videoId) throw new Error(`invalid video_id: ${rawVideoId.slice(0, 40)}`);
  } else if (url) {
    videoId = extractVideoId(url);
    if (!videoId) throw new Error(`could not parse video id from url: ${url.slice(0, 80)}`);
  } else if (query) {
    const { searchYouTube } = await import("./youtube-search");
    const results = await searchYouTube(query, 1);
    if (results.length === 0) {
      throw new Error(`no YouTube results for query: ${query.slice(0, 80)}`);
    }
    const top = results[0];
    videoId = top.id;
    resolvedTitle = resolvedTitle ?? top.title;
    resolvedDuration = top.durationSec ?? null;
    resolvedThumb = resolvedThumb ?? top.thumbnailUrl;
  } else {
    throw new Error("one of video_id / url / query is required");
  }

  const durArg = getOptNum(args, "duration_sec");
  const finalDuration = durArg ?? resolvedDuration;

  // Same backfill as youtube_play: the video_id / url paths skip
  // search, so resolve title + thumbnail before queuing or the
  // now-playing card shows "untitled video" once it promotes.
  if (!resolvedTitle || !resolvedThumb) {
    const { fetchYouTubeMeta } = await import("./youtube-search");
    const meta = await fetchYouTubeMeta(videoId);
    resolvedTitle = resolvedTitle ?? meta.title;
    resolvedThumb = resolvedThumb ?? meta.thumbnailUrl;
  }

  const { enqueueYouTube, getYouTubeState } = await import("./youtube-state");
  const before = getYouTubeState(ctx.user.id);
  const promotedToCurrent = !before.videoId;
  const state = enqueueYouTube(ctx.user.id, {
    videoId,
    title: resolvedTitle,
    thumbnailUrl: resolvedThumb,
    durationSec: finalDuration,
  });

  // If the enqueue promoted into now-playing, flip the filler mode
  // to "youtube" so playback actually takes effect. Otherwise leave
  // mode alone — user might be in news mode and just stacking up
  // tracks for later.
  if (promotedToCurrent) {
    const { setFillerMode } = await import("./filler-mode");
    try {
      await setFillerMode("youtube");
    } catch {
      /* non-fatal */
    }
  }
  return {
    ok: true,
    videoId,
    promotedToCurrent,
    queueLength: state.queue.length,
    state,
  };
}

async function youtubeStopTool(ctx: SparContext) {
  const { stopYouTube } = await import("./youtube-state");
  const state = stopYouTube(ctx.user.id);
  // Return the filler mode to the default so subsequent thinking
  // windows hear news instead of silence (youtube mode with no
  // video selected falls through to news automatically, but
  // explicit is kinder to the next reader of the config file).
  const { setFillerMode } = await import("./filler-mode");
  try {
    await setFillerMode("news");
  } catch {
    /* non-fatal */
  }
  return { ok: true, mode: "news", state };
}

async function fillerSetModeTool(
  _ctx: SparContext,
  args: Record<string, unknown>,
) {
  const { setFillerMode, FILLER_MODES } = await import("./filler-mode");
  const mode = getStr(args, "mode").trim();
  if (!(FILLER_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `invalid mode: ${mode}. Valid: ${FILLER_MODES.join(", ")}`,
    );
  }
  // Optional URL/topic. Accept either snake_case (MCP convention) or
  // camelCase so a hand-typed call from anywhere still works.
  const rawHint = args.url_or_topic ?? args.urlOrTopic;
  const urlOrTopic =
    typeof rawHint === "string" && rawHint.trim() ? rawHint.trim() : undefined;
  await setFillerMode(mode as import("./filler-mode").FillerMode, urlOrTopic);
  return { ok: true, mode, urlOrTopic: urlOrTopic ?? null };
}

async function fillerGetModeTool(ctx: SparContext) {
  const { getFillerConfig } = await import("./filler-mode");
  const { getYouTubeState } = await import("./youtube-state");
  const { mode, urlOrTopic } = await getFillerConfig();
  const yt = getYouTubeState(ctx.user.id);
  // activeSource reports what the browser would *actually* play
  // given the current mode + state, applying the SparProvider
  // fallback rules: youtube with no video → news; news/quiet/off
  // are literal; fun-facts/calendar pull from the dashboard's TTS
  // content system. Browser still has the final say (e.g. if news
  // pool is empty it falls back to hum) but this is the best read
  // we can give without polling the client.
  let activeSource: string;
  if (mode === "off") activeSource = "off";
  else if (mode === "quiet") activeSource = "quiet";
  else if (mode === "hum") activeSource = "hum";
  else if (mode === "youtube" && yt.videoId) activeSource = "youtube";
  else if (mode === "youtube") activeSource = "news"; // fallback
  else if (mode === "fun-facts") activeSource = "fun-facts";
  else if (mode === "calendar") activeSource = "calendar";
  else activeSource = "news";
  return {
    mode,
    urlOrTopic: urlOrTopic ?? null,
    activeSource,
    youtubeSelection: yt.videoId
      ? {
          videoId: yt.videoId,
          title: yt.title,
          status: yt.status,
          positionSec: yt.positionSec,
        }
      : null,
  };
}

async function youtubeStatusTool(ctx: SparContext) {
  const { getYouTubeState } = await import("./youtube-state");
  const state = getYouTubeState(ctx.user.id);
  const now = Date.now();
  // Stale if we have a selection but no recent position report — the
  // browser either hasn't loaded the iframe yet or isn't running.
  // Fresh 5 s window matches the 2 s report cadence with headroom.
  const positionStale =
    state.videoId === null
      ? false
      : state.positionReportedAt === null
      ? true
      : now - state.positionReportedAt > 5_000;
  return {
    isSelected: state.videoId !== null,
    videoId: state.videoId,
    title: state.title,
    durationSec: state.durationSec,
    status: state.status,
    positionSec: state.positionSec,
    positionStale,
    updatedAt: state.updatedAt,
  };
}

/** Registry of tool names → handler. Used by the internal API route. */
export const TOOL_HANDLERS: Record<
  string,
  (ctx: SparContext, args: Record<string, unknown>) => unknown | Promise<unknown>
> = {
  list_projects: (ctx) => listProjects(ctx),
  read_heartbeat: (ctx) => readHeartbeatTool(ctx),
  read_terminal_scrollback: (ctx, a) => readTerminalScrollback(ctx, a),
  list_recent_file_changes: (ctx, a) => listRecentFileChanges(ctx, a),
  list_recent_remarks: (ctx, a) => listRecentRemarks(ctx, a),
  create_remark: (ctx, a) => createRemarkTool(ctx, a),
  edit_remark: (ctx, a) => editRemarkTool(ctx, a),
  resolve_remark: (ctx, a) => resolveRemarkTool(ctx, a),
  unresolve_remark: (ctx, a) => unresolveRemarkTool(ctx, a),
  delete_remark: (ctx, a) => deleteRemarkTool(ctx, a),
  read_project_file: (ctx, a) => readProjectFile(ctx, a),
  describe_project: (ctx, a) => describeProject(ctx, a),
  dispatch_to_project: (ctx, a) => dispatchToProjectTool(ctx, a),
  send_keys_to_project: (ctx, a) => sendKeysToProjectTool(ctx, a),
  update_heartbeat: (ctx, a) => updateHeartbeatTool(ctx, a),
  read_graph: (ctx) => readGraphTool(ctx),
  write_graph: (ctx, a) => writeGraphTool(ctx, a),
  youtube_search: (ctx, a) => youtubeSearchTool(ctx, a),
  youtube_play: (ctx, a) => youtubePlayTool(ctx, a),
  youtube_enqueue: (ctx, a) => youtubeEnqueueTool(ctx, a),
  youtube_stop: (ctx) => youtubeStopTool(ctx),
  youtube_status: (ctx) => youtubeStatusTool(ctx),
  filler_set_mode: (ctx, a) => fillerSetModeTool(ctx, a),
  filler_get_mode: (ctx) => fillerGetModeTool(ctx),
};
