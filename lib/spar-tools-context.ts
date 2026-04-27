// Server-side implementations of the tools exposed to the spar MCP server.
// Each function takes a SparContext (with the acting user) and tool args,
// returns a JSON-serializable result, and throws on validation failures.
// The internal API route and any future in-process callers share this.

import fs from "node:fs/promises";
import { getProject, resolveInProject } from "./config";
import { visibleProjects, canAccessProject } from "./access";
import { readHeartbeat, writeHeartbeat, isSuperUser } from "./heartbeat";
import { getHistory } from "./history";
import {
  getSession,
  write as writeTerminal,
  start as startTerminal,
  stop as stopTerminalSession,
  getStatus as getTerminalStatus,
} from "./terminal";
import { getDb, type User } from "./db";
import { dispatchToProject } from "./spar-dispatch";
import { readGraph, writeGraph, type SparGraph } from "./spar-graph";
import { broadcastRemark, broadcastChatMessage } from "./ws";
import { deleteAttachmentsOfRemark } from "./attachments";
import {
  listChannelsForUser,
  canUseChannel,
  listMessages,
  insertMessage,
  recipientsForChannel,
  getOrCreateDm,
  getUnreadForUser,
} from "./chat";
import { listOnlineUsers, listRecentActivity } from "./presence";
import {
  createSession as createRecordingSession,
  listSessions as listRecordingSessions,
  endSession as endRecordingSession,
  findActiveSession as findActiveRecordingSession,
} from "./recording";
import { stopSession as stopLiveBrowserSession } from "./browser-stream";
import {
  getStatus as getTelegramStatusUpstream,
  startCall as startTelegramCall,
  hangup as hangupTelegramCall,
  speak as speakTelegram,
  TelegramVoiceUnavailable,
} from "./telegram-voice";
import {
  createAutomation,
  listAutomationsWithStats,
  patchAutomation,
  getAutomationStats,
} from "./automations";
import { commitAndPush } from "./git";
import { isCompanionConnected } from "./companion-ws";
import { pushToUsers } from "./push";
import { getKokoroPort } from "./kokoro";

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
  // At-prompt check runs before "thinking" so a stale completion line
  // ("✻ Cogitated for 1m 16s") above the live "❯" can't outrank the
  // prompt sitting below it.
  const nonEmpty = tailLines.map((l) => l.trim()).filter(Boolean);
  const lastLine = nonEmpty[nonEmpty.length - 1] ?? "";
  if (/^\s*[>│▌❯]\s*$/.test(lastLine)) {
    return {
      state: "at_prompt",
      hint: "Claude Code is idle at its input prompt.",
    };
  }
  // Active "-ing" forms only. Past tense ("Cogitated for 1m 16s",
  // "Baked for…") is a completion line, not in-progress work — so the
  // old `cogitat` stem produced false positives every time a task
  // finished.
  //
  // Two-pronged match. The first regex catches Claude Code's full
  // verb vocabulary structurally — any "-ing" word followed by a
  // parenthesised seconds timer like "(28s · …)". That's the shape of
  // every live status row regardless of which verb the TUI happened
  // to roll for this turn (Elucidating, Deliberating, Building, …).
  // The fallback word list keeps coverage for the rare line that has
  // a verb but no timer yet (first ~1s of a new task) so we don't
  // bounce to "unknown" mid-rotation.
  if (
    /\b[a-z]+ing\b[^\n]{0,80}\(\s*(?:\d+\s*m\s*)?\d+\s*s\b/i.test(tailText) ||
    /\b(cogitating|baking|thinking|churning|processing)\b/i.test(lower)
  ) {
    return {
      state: "thinking",
      hint: "Claude Code is still processing — let it run, don't narrate the status line.",
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

// ---- Extended tool surface ------------------------------------------------
//
// Coverage tools so the spar persona can reach the rest of the dashboard:
// chat, project actions, admin/presence, recordings, telegram voice,
// automations, push, and TTS. Each handler mirrors the corresponding
// `app/api/*` route's auth gate exactly so the spar surface can never
// grant access the HTTP route doesn't.

function requireAdminCtx(ctx: SparContext): void {
  if (ctx.user.role !== "admin") {
    throw new Error("forbidden: admin only");
  }
}

function requireSuperUserCtx(ctx: SparContext): void {
  if (!isSuperUser(ctx.user)) {
    throw new Error("forbidden: super-user only");
  }
}

// ---- Chat -----------------------------------------------------------------

function listChannelsTool(ctx: SparContext) {
  const channels = listChannelsForUser(ctx.user);
  const { byChannel: unreadByChannel } = getUnreadForUser(ctx.user);
  return channels.map((c) => ({
    id: c.id,
    kind: c.kind,
    name: c.name,
    projectId: c.projectId,
    projectName: c.projectName ?? null,
    peer: c.peer ?? null,
    createdAt: c.createdAt,
    unread: unreadByChannel[c.id] ?? 0,
  }));
}

function readMessagesTool(ctx: SparContext, args: Record<string, unknown>) {
  const channelId = Math.floor(getOptNum(args, "channel_id") ?? NaN);
  if (!Number.isFinite(channelId) || channelId <= 0) {
    throw new Error("channel_id must be a positive integer");
  }
  const channel = canUseChannel(ctx.user, channelId);
  if (!channel) throw new Error("forbidden: no access to this channel");
  const limit = Math.min(
    100,
    Math.max(1, Math.floor(getOptNum(args, "limit") ?? 20)),
  );
  const before = Math.floor(getOptNum(args, "before") ?? 0);

  // Inline cursor query so `before` actually paginates back through full
  // history. listMessages() caps at the most-recent N which is the wrong
  // shape for "give me the page before this id".
  const db = getDb();
  type Row = {
    id: number;
    channel_id: number;
    user_id: number;
    kind: "text" | "ai_session" | "system";
    body: string;
    meta: string | null;
    created_at: number;
    user_name: string;
  };
  const rows = (
    before > 0
      ? db
          .prepare(
            `SELECT m.id, m.channel_id, m.user_id, m.kind, m.body, m.meta, m.created_at,
                    u.name AS user_name
               FROM chat_messages m JOIN users u ON u.id = m.user_id
              WHERE m.channel_id = ? AND m.id < ?
              ORDER BY m.id DESC
              LIMIT ?`,
          )
          .all(channelId, before, limit)
      : db
          .prepare(
            `SELECT m.id, m.channel_id, m.user_id, m.kind, m.body, m.meta, m.created_at,
                    u.name AS user_name
               FROM chat_messages m JOIN users u ON u.id = m.user_id
              WHERE m.channel_id = ?
              ORDER BY m.id DESC
              LIMIT ?`,
          )
          .all(channelId, limit)
  ) as Row[];
  // Return chronological so the assistant reads them top-to-bottom.
  const chronological = rows.slice().reverse();
  return {
    channelId,
    channelKind: channel.kind,
    messages: chronological.map((r) => {
      let meta: unknown = null;
      if (r.meta) {
        try {
          meta = JSON.parse(r.meta);
        } catch {
          meta = null;
        }
      }
      return {
        id: r.id,
        userId: r.user_id,
        userName: r.user_name,
        kind: r.kind,
        body: r.body,
        meta,
        createdAt: r.created_at,
      };
    }),
    hasMore: rows.length === limit,
    nextBefore: chronological.length > 0 ? chronological[0].id : null,
  };
}

function sendMessageTool(ctx: SparContext, args: Record<string, unknown>) {
  const channelId = Math.floor(getOptNum(args, "channel_id") ?? NaN);
  if (!Number.isFinite(channelId) || channelId <= 0) {
    throw new Error("channel_id must be a positive integer");
  }
  const text = getStr(args, "text").trim();
  if (!text) throw new Error("text must not be empty");
  if (text.length > 10_000) throw new Error("text too long (>10000 chars)");
  const channel = canUseChannel(ctx.user, channelId);
  if (!channel) throw new Error("forbidden: no access to this channel");

  const msg = insertMessage(channelId, ctx.user.id, text, "text", null);
  broadcastChatMessage(channelId, msg);

  // Mirror the chat POST route's notification fan-out so a spar-sent
  // message wakes up the same recipients a user-typed one would.
  const recipients = recipientsForChannel(channelId, ctx.user.id);
  if (recipients.length > 0) {
    const preview = text.length > 140 ? text.slice(0, 140) + "…" : text;
    void pushToUsers(recipients, {
      title: msg.userName,
      body: preview,
      url: `/?channel=${channelId}`,
      tag: `chat-${channelId}`,
      data: { kind: "chat", channelId },
    });
  }
  return {
    id: msg.id,
    channelId: msg.channelId,
    userId: msg.userId,
    userName: msg.userName,
    body: msg.body,
    createdAt: msg.createdAt,
  };
}

function createDmTool(ctx: SparContext, args: Record<string, unknown>) {
  const userId = Math.floor(getOptNum(args, "user_id") ?? NaN);
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error("user_id must be a positive integer");
  }
  if (userId === ctx.user.id) throw new Error("cannot DM yourself");
  const target = getDb()
    .prepare("SELECT id, name FROM users WHERE id = ?")
    .get(userId) as { id: number; name: string } | undefined;
  if (!target) throw new Error(`user ${userId} not found`);
  const channelId = getOrCreateDm(ctx.user.id, userId);
  return { channelId, peer: { id: target.id, name: target.name } };
}

// ---- Project actions ------------------------------------------------------

async function deployProjectTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  // /api/projects/[id]/git/deploy is admin-only; mirror that here. The
  // push lands in a public remote, so spar can't deploy on behalf of a
  // non-admin even with an authenticated session.
  requireAdminCtx(ctx);
  const projectId = getStr(args, "project_id");
  if (!getProject(projectId)) throw new Error(`unknown project: ${projectId}`);
  const messageRaw = getOptStr(args, "message");
  const message =
    messageRaw && messageRaw.length <= 500
      ? messageRaw
      : `Deploy from spar @ ${new Date().toISOString()}`;
  const result = await commitAndPush(projectId, message);
  return { projectId, ...result };
}

function startTerminalTool(ctx: SparContext, args: Record<string, unknown>) {
  const projectId = getStr(args, "project_id");
  if (!canAccessProject(ctx.user, projectId)) {
    throw new Error("forbidden: no access to this project");
  }
  if (!getProject(projectId)) throw new Error(`unknown project: ${projectId}`);
  // Idempotent — startTerminal returns the existing session if one is
  // already running. Mirrors the WS-driven flow from the project page.
  const session = startTerminal(projectId);
  return {
    projectId,
    running: true,
    pid: session.proc.pid ?? null,
    startedAt: session.startedAt,
    cols: session.cols,
    rows: session.rows,
    alreadyRunning: session.startedAt < Date.now() - 1000,
  };
}

function stopTerminalTool(ctx: SparContext, args: Record<string, unknown>) {
  const projectId = getStr(args, "project_id");
  if (!canAccessProject(ctx.user, projectId)) {
    throw new Error("forbidden: no access to this project");
  }
  const stopped = stopTerminalSession(projectId);
  const status = getTerminalStatus(projectId);
  return { projectId, stopped, running: status.running };
}

// ---- Admin ----------------------------------------------------------------

function listUsersTool(ctx: SparContext) {
  // Match /api/admin/users GET — admin role gate.
  requireAdminCtx(ctx);
  const rows = getDb()
    .prepare(
      "SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC",
    )
    .all() as Array<{
    id: number;
    email: string;
    name: string;
    role: "admin" | "team" | "client";
    created_at: number;
  }>;
  const accessRows = getDb()
    .prepare("SELECT user_id, project_id FROM project_access")
    .all() as { user_id: number; project_id: string }[];
  const accessByUser = new Map<number, string[]>();
  for (const r of accessRows) {
    const arr = accessByUser.get(r.user_id) ?? [];
    arr.push(r.project_id);
    accessByUser.set(r.user_id, arr);
  }
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    createdAt: r.created_at,
    projects: accessByUser.get(r.id) ?? [],
  }));
}

function getPresenceTool(ctx: SparContext) {
  // /api/admin/activity GET (which exposes online users alongside
  // recent activity) is super-user-only. Stay aligned with that.
  requireSuperUserCtx(ctx);
  return { online: listOnlineUsers(), now: Date.now() };
}

function getActivityTool(ctx: SparContext, args: Record<string, unknown>) {
  requireSuperUserCtx(ctx);
  const limit = Math.min(
    500,
    Math.max(1, Math.floor(getOptNum(args, "limit") ?? 50)),
  );
  return { recent: listRecentActivity(limit), now: Date.now() };
}

// ---- Recordings -----------------------------------------------------------

function listRecordingsTool(ctx: SparContext, args: Record<string, unknown>) {
  const limit = Math.min(
    100,
    Math.max(1, Math.floor(getOptNum(args, "limit") ?? 20)),
  );
  const sessions = listRecordingSessions(ctx.user.id, limit);
  const active = findActiveRecordingSession(ctx.user.id);
  return { sessions, active };
}

function startRecordingTool(ctx: SparContext) {
  const session = createRecordingSession(ctx.user.id);
  return { session };
}

async function stopRecordingTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  const sessionId = getStr(args, "session_id");
  const session = endRecordingSession(sessionId, ctx.user.id);
  if (!session) throw new Error(`recording session ${sessionId} not found`);
  // Best-effort headless-browser teardown, matching the route handler.
  await stopLiveBrowserSession(ctx.user.id).catch(() => {});
  return { session };
}

// ---- Telegram -------------------------------------------------------------

function explainTelegramError(err: unknown): never {
  if (err instanceof TelegramVoiceUnavailable) {
    throw new Error(`telegram-voice service unavailable: ${err.message}`);
  }
  throw err instanceof Error ? err : new Error(String(err));
}

async function telegramStatusTool(ctx: SparContext) {
  // Status is readable by any logged-in user, matching the route.
  void ctx;
  try {
    const status = await getTelegramStatusUpstream();
    return status;
  } catch (err) {
    if (err instanceof TelegramVoiceUnavailable) {
      return { state: "offline", detail: err.message };
    }
    throw err;
  }
}

async function telegramCallTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  requireAdminCtx(ctx);
  const phone = getOptStr(args, "phone") ?? undefined;
  const userIdRaw = getOptNum(args, "user_id");
  const userId = userIdRaw && Number.isFinite(userIdRaw)
    ? Math.floor(userIdRaw)
    : undefined;
  try {
    return await startTelegramCall({ phone, user_id: userId });
  } catch (err) {
    explainTelegramError(err);
  }
}

async function telegramHangupTool(ctx: SparContext) {
  requireAdminCtx(ctx);
  try {
    return await hangupTelegramCall();
  } catch (err) {
    explainTelegramError(err);
  }
}

async function telegramSpeakTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  requireAdminCtx(ctx);
  const text = getStr(args, "text").trim();
  if (!text) throw new Error("text must not be empty");
  if (text.length > 4_000) throw new Error("text too long (>4000 chars)");
  const voice = getOptStr(args, "voice") ?? undefined;
  const speed = getOptNum(args, "speed");
  try {
    return await speakTelegram({ text, voice, speed });
  } catch (err) {
    explainTelegramError(err);
  }
}

// ---- Automations ----------------------------------------------------------

function listAutomationsTool(ctx: SparContext) {
  void ctx;
  return { automations: listAutomationsWithStats() };
}

function createAutomationTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  void ctx;
  const name = getStr(args, "name").trim();
  if (!name) throw new Error("name must not be empty");
  if (name.length > 200) throw new Error("name too long (>200 chars)");
  // The dashboard's only automation kind today is "url" — a saved
  // navigation target. Mirror /api/automations POST: the `url` arg
  // becomes the payload, `description` is optional. We accept the
  // user-facing `trigger` / `action` arg names from the spec but map
  // them onto the existing schema rather than inventing a new kind.
  const url =
    getOptStr(args, "url") ?? getOptStr(args, "action") ?? "";
  if (!url) throw new Error("url (or action) is required");
  if (url.length > 2_000) throw new Error("url too long (>2000 chars)");
  const description =
    getOptStr(args, "description") ?? getOptStr(args, "trigger");
  const automation = createAutomation({
    name,
    description,
    kind: "url",
    payload: { url },
  });
  return {
    automation: {
      ...automation,
      stats: {
        lastRunAt: null,
        runCount: 0,
        failedRuns: 0,
        clarificationsNeeded: 0,
      },
    },
  };
}

function updateAutomationTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  void ctx;
  const id = Math.floor(getOptNum(args, "id") ?? NaN);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error("id must be a positive integer");
  }
  const patch: Parameters<typeof patchAutomation>[1] = {};
  const name = getOptStr(args, "name");
  if (name !== null) patch.name = name;
  if (args.description !== undefined) {
    const d = getOptStr(args, "description");
    patch.description = d ?? null;
  }
  const url = getOptStr(args, "url") ?? getOptStr(args, "action");
  if (url !== null) patch.payload = { url };
  if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
  const updated = patchAutomation(id, patch);
  if (!updated) throw new Error(`automation ${id} not found`);
  return { automation: { ...updated, stats: getAutomationStats(id) } };
}

// ---- Utility --------------------------------------------------------------

function companionStatusTool(ctx: SparContext) {
  return { connected: isCompanionConnected(ctx.user.id) };
}

async function sendPushTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  const title = getStr(args, "title").trim();
  if (!title) throw new Error("title must not be empty");
  if (title.length > 200) throw new Error("title too long (>200 chars)");
  const body = getStr(args, "body").trim();
  if (!body) throw new Error("body must not be empty");
  if (body.length > 1_000) throw new Error("body too long (>1000 chars)");
  const url = getOptStr(args, "url") ?? undefined;
  // Only fan out to the calling user's own subscribed devices —
  // avoids the spar surface becoming a way to ping arbitrary users.
  await pushToUsers([ctx.user.id], { title, body, url });
  return { ok: true, userId: ctx.user.id };
}

async function speakTtsTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  void ctx;
  // Mirrors /api/tts POST: synthesises through the local Kokoro sidecar
  // and returns metadata. Audio bytes don't round-trip through MCP, so
  // this is most useful when paired with a future WS broadcast that
  // plays the result on the dashboard. The synthesis itself still
  // succeeds and primes Kokoro's caches, which keeps subsequent reply-
  // path TTS warm.
  const text = getStr(args, "text").trim();
  if (!text) throw new Error("text must not be empty");
  if (text.length > 4_000) throw new Error("text too long (>4000 chars)");
  const voice = getOptStr(args, "voice") ?? undefined;
  const speed = getOptNum(args, "speed");
  const lang = getOptStr(args, "lang") ?? undefined;
  const payload: Record<string, unknown> = { text };
  if (voice) payload.voice = voice;
  if (typeof speed === "number") payload.speed = speed;
  if (lang) payload.lang = lang;
  const port = getKokoroPort();
  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${port}/synth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch (err) {
    throw new Error(
      `kokoro sidecar unreachable: ${String(err).slice(0, 120)}`,
    );
  }
  if (!upstream.ok) {
    const msg = await upstream.text().catch(() => "synth failed");
    throw new Error(`kokoro synth failed (${upstream.status}): ${msg.slice(0, 200)}`);
  }
  const bytes = Number(upstream.headers.get("Content-Length") ?? 0);
  // Drain the body so the connection can close cleanly even though we
  // throw the audio away.
  await upstream.arrayBuffer().catch(() => {});
  return { ok: true, bytes, voice: voice ?? null };
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
  // Chat
  list_channels: (ctx) => listChannelsTool(ctx),
  read_messages: (ctx, a) => readMessagesTool(ctx, a),
  send_message: (ctx, a) => sendMessageTool(ctx, a),
  create_dm: (ctx, a) => createDmTool(ctx, a),
  // Project actions
  deploy_project: (ctx, a) => deployProjectTool(ctx, a),
  start_terminal: (ctx, a) => startTerminalTool(ctx, a),
  stop_terminal: (ctx, a) => stopTerminalTool(ctx, a),
  // Admin
  list_users: (ctx) => listUsersTool(ctx),
  get_presence: (ctx) => getPresenceTool(ctx),
  get_activity: (ctx, a) => getActivityTool(ctx, a),
  // Recordings
  list_recordings: (ctx, a) => listRecordingsTool(ctx, a),
  start_recording: (ctx) => startRecordingTool(ctx),
  stop_recording: (ctx, a) => stopRecordingTool(ctx, a),
  // Telegram
  telegram_status: (ctx) => telegramStatusTool(ctx),
  telegram_call: (ctx, a) => telegramCallTool(ctx, a),
  telegram_hangup: (ctx) => telegramHangupTool(ctx),
  telegram_speak: (ctx, a) => telegramSpeakTool(ctx, a),
  // Automations
  list_automations: (ctx) => listAutomationsTool(ctx),
  create_automation: (ctx, a) => createAutomationTool(ctx, a),
  update_automation: (ctx, a) => updateAutomationTool(ctx, a),
  // Utility
  companion_status: (ctx) => companionStatusTool(ctx),
  send_push: (ctx, a) => sendPushTool(ctx, a),
  speak_tts: (ctx, a) => speakTtsTool(ctx, a),
};
