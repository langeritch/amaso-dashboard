// Server-side implementations of the tools exposed to the spar MCP server.
// Each function takes a SparContext (with the acting user) and tool args,
// returns a JSON-serializable result, and throws on validation failures.
// The internal API route and any future in-process callers share this.

import fs from "node:fs/promises";
import nodeFs from "node:fs";
import path from "node:path";
import {
  addProject,
  getProject,
  removeProject,
  resolveInProject,
  type ProjectConfig,
  type ProjectVisibility,
} from "./config";
import { visibleProjects, canAccessProject } from "./access";
import { readHeartbeat, writeHeartbeat, isSuperUser } from "./heartbeat";
import { readProfile, writeProfile } from "./user-profile";
import { BRAIN_ROOT } from "./spar-brain";
import { getHistory } from "./history";
import {
  getSession,
  write as writeTerminal,
  start as startTerminal,
  stop as stopTerminalSession,
  getStatus as getTerminalStatus,
} from "./terminal-backend";
import { getDb, type User } from "./db";
import { dispatchToProject } from "./spar-dispatch";
import { readGraph, writeGraph, type SparGraph } from "./spar-graph";
import {
  broadcastRemark,
  broadcastChatMessage,
  broadcastSparRemoteControl,
  type SparRemoteControlAction,
  type SparRemoteControlPayload,
} from "./ws";
import {
  enableAutopilot,
  disableAutopilot,
  isAutopilotEnabled,
  readAutopilotDirective,
  writeAutopilotDirective,
} from "./autopilot";
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
// Strips every CR-overwritten segment on a line, keeping only the last
// (visible) write. The previous form `/^.*\r(?!\n)/gm` only stripped the
// FIRST overwrite per line in JS — `^` in m-mode anchors only after `\n`,
// not after a lone `\r`, so `Thinking (1s)\rThinking (2s)\rThinking (3s)`
// only lost the leading "Thinking (1s)" segment. Non-anchored form
// catches every overwrite. The `(?!\n)` lookahead leaves CRLF row
// separators alone.
// eslint-disable-next-line no-control-regex
export const CARRIAGE_OVERWRITE_REGEX = /[^\r\n]*\r(?!\n)/g;

// Per-line carriage-return collapse. Splits each \n-delimited row on \r
// and returns the last non-empty segment — what the user actually sees
// after Claude Code rewrites a status line in place. Used by both
// cleanScrollback and detectTerminalState so the visible text and the
// state heuristic always agree on "what's on screen right now".
export function collapseCarriageReturns(text: string): string {
  return text
    .split("\n")
    .map((row) => {
      if (!row.includes("\r")) return row;
      const segs = row.split("\r");
      for (let i = segs.length - 1; i >= 0; i--) {
        if (segs[i].length > 0) return segs[i];
      }
      return "";
    })
    .join("\n");
}

// Whole lines to drop: Claude Code's status and chrome decorations.
// Each regex matches a single line after ANSI + box-drawing strip.
// Completion lines ("Cogitated for 2s") must survive cleaning — see
// COMPLETION_KEEP_RX below. The noise regexes intentionally use the
// present-participle form ("cogitating", not "cogitat\w*") so they
// never accidentally swallow a past-tense completion line when the
// spinner character is a plain asterisk.
const COMPLETION_KEEP_RX = /\w+(?:ed|t)\s+for\s+(?:\d+\s*m\s+)?\d+\s*s/i;
const LINE_NOISE_REGEXES: RegExp[] = [
  /^\s*(cogitating|baking|thinking|churning|processing|pondering|musing|deliberating|crafting|scheming|simmering|brewing)\b.*for\s+\d.*$/i,
  /^\s*\*\s+(cogitating|baking|thinking|churning|processing|pondering).*$/i,
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
  // Collapse carriage-return overwrites per-line so only the final
  // visible segment of a rewritten status row survives.
  s = collapseCarriageReturns(s);
  s = s.replace(TUI_CHROME_REGEX, "");
  // Drop noise lines wholesale.
  s = s
    .split(/\r?\n/)
    .filter((line) => {
      if (COMPLETION_KEEP_RX.test(line)) return true;
      return !LINE_NOISE_REGEXES.some((rx) => rx.test(line));
    })
    .join("\n");
  // Compress runs of blank lines.
  s = s.replace(/\n{3,}/g, "\n\n");
  // Trim trailing whitespace on each line.
  s = s.replace(/[ \t]+$/gm, "");
  return s.trimEnd();
}

// Patterns shared across detection passes. Hoisted out of the function
// so worker-status / autopilot can reuse them if needed and so the JIT
// doesn't recompile them per call.
//
// Active "thinking" status row. Two shapes:
//   • verb-only with ellipsis for the first ~1s before the timer kicks in
//     ("✻ Tomfoolering…", "★ Sublimating...")
//   • verb + parenthesised timer once Claude has elapsed seconds to show
//     ("✢ Tomfoolering… (9s · ↓ 312 tokens)", "Cogitating (1m 4s · esc to interrupt)")
// Anchoring on a leading word boundary or one of Claude Code's spinner
// glyphs avoids false-positives like "during" or "going" appearing
// mid-sentence in streamed response text.
const THINKING_VERB_PREFIX = `(?:^|[\\s★⟡✻✢✦✶✽◆◉●○◦·*])`;
const THINKING_TIMER_RX = new RegExp(
  `${THINKING_VERB_PREFIX}\\s*[A-Za-z][a-zA-Z]+ing\\b[^\\n]{0,120}\\(\\s*(?:[^()]*?\\s)?\\d+\\s*s\\b`,
  "i",
);
const THINKING_ELLIPSIS_RX = new RegExp(
  `${THINKING_VERB_PREFIX}\\s*[A-Za-z][a-zA-Z]+ing(?:…|\\.\\.\\.)`,
  "i",
);
// Past-tense completion summary printed when the turn ends. Match \w+ed
// or \w+t for irregulars ("dealt", "built"). Excludes the in-flight form
// (no "ing\b" before "for") so this never accidentally fires on a
// "Cogitating … for 9s" status line.
const COMPLETION_RX =
  /\b(?!\w+ing\b)\w+(?:ed|t)\s+for\s+(?:\d+\s*m\s+)?\d+\s*s\b/i;
// Bare input prompt (just the chevron, no typed text).
const BARE_PROMPT_RX = /^\s*[>│▌❯›]\s*$/;
// Input prompt with text already typed but not submitted.
const TYPED_PROMPT_RX = /^\s*[>❯›]\s+\S/;
// Tool-use callout printed by Claude Code while running a tool. The
// glyph + tool-name pattern is stable across the supported tools.
const TOOL_USE_RX =
  /^\s*[●⏺⎯○◯◉]\s*(?:Read|Edit|Write|Bash|Grep|Glob|Update|MultiEdit|NotebookEdit|TodoWrite|WebFetch|WebSearch|Task|Agent)\s*\(/;
// Lines that are TUI chrome / footer decorations rather than content;
// skipped when we walk back from the buffer end looking for the actual
// last visible row of output.
const FOOTER_SKIP_RX: RegExp[] = [
  /\bbypass\s+permissions\b/i,
  /\(shift\+tab/i,
  /shift\+tab\s+to\s+cycle/i,
  /\besc\s+to\s+interrupt/i,
  /\(ctrl\+c/i,
  /accept edits/i,
  /MCP\s+server\s+needs\s+auth/i,
  /^\s*[◉◯●○]\s*\w+\s*·/,
];

export function detectTerminalState(
  clean: string,
): { state: string; hint: string } {
  // (0) Per-line CR collapse. Claude Code rewrites status text in place
  // via \r; if a row holds "Thinking (1s)\rThinking (2s)\rThinking (3s)"
  // we want to detect on "Thinking (3s)" — the visible segment — not
  // accidentally match a stale earlier write.
  const collapsed = collapseCarriageReturns(clean);
  const allRows = collapsed.split("\n");
  const tailRows = allRows.slice(-60);
  const tailText = tailRows.join("\n");
  const lower = tailText.toLowerCase();

  // (1) Permission gate first — most urgent.
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

  // (2) Footer "esc to interrupt" is Claude Code's definitive busy
  // signal — it's printed in the bottom hint row only while a turn is
  // actively running (thinking, tool use, or response stream). But the
  // tail will hold many stale footer copies from earlier frames in a
  // long turn, so we have to look at the LATEST footer line, not just
  // any footer in the buffer. Walk back from the end until we hit the
  // bottom-most line that looks like a Claude Code footer; if THAT
  // one mentions "esc to interrupt", the current turn is still alive.
  const FOOTER_SHAPE_RX = /\bbypass\s+permissions\b|shift\+tab\s+to\s+cycle/i;
  for (let i = tailRows.length - 1; i >= 0; i--) {
    const t = tailRows[i].trim();
    if (!t) continue;
    if (FOOTER_SHAPE_RX.test(t)) {
      if (/\besc\s+to\s+interrupt\b/i.test(t)) {
        return {
          state: "thinking",
          hint:
            "Claude Code is still processing — let it run, don't narrate the status line.",
        };
      }
      break;
    }
  }

  // (3) Scan tail for the latest signals. We want positions, not just
  // booleans, so we can disambiguate "thinking line above input box"
  // from "completion line above input box" (both have the bare ❯ below).
  let lastThinkingIdx = -1;
  let lastCompletionIdx = -1;
  let lastBarePromptIdx = -1;
  let lastTypedPromptIdx = -1;
  let lastToolUseIdx = -1;
  for (let i = 0; i < tailRows.length; i++) {
    const t = tailRows[i].trim();
    if (!t) continue;
    if (THINKING_TIMER_RX.test(t) || THINKING_ELLIPSIS_RX.test(t)) {
      lastThinkingIdx = i;
    }
    if (COMPLETION_RX.test(t)) lastCompletionIdx = i;
    if (BARE_PROMPT_RX.test(t)) lastBarePromptIdx = i;
    if (TYPED_PROMPT_RX.test(t)) lastTypedPromptIdx = i;
    if (TOOL_USE_RX.test(t)) lastToolUseIdx = i;
  }

  // (4) Active thinking pattern, with no NEWER completion line — Claude
  // is still mid-turn. Note we deliberately ignore lastBarePromptIdx
  // here: Claude Code redraws the input box (a bare ❯) BELOW the status
  // row on every status tick, so a bare prompt appearing after a
  // thinking line doesn't mean idle. Only a completion line ("Cogitated
  // for Xs") means the thinking block actually ended.
  if (lastThinkingIdx >= 0 && lastThinkingIdx >= lastCompletionIdx) {
    return {
      state: "thinking",
      hint:
        "Claude Code is still processing — let it run, don't narrate the status line.",
    };
  }

  // (5) Find the bottom-most visible non-footer row. This is what the
  // user actually sees as the last meaningful line, after we strip
  // chrome decorations like the bypass-permissions footer.
  let bottomIdx = -1;
  for (let i = tailRows.length - 1; i >= 0; i--) {
    const t = tailRows[i].trim();
    if (!t) continue;
    if (FOOTER_SKIP_RX.some((rx) => rx.test(t))) continue;
    bottomIdx = i;
    break;
  }
  const bottom = bottomIdx >= 0 ? tailRows[bottomIdx].trim() : "";

  // (6) A completion line ("Cogitated for Xs") is "ready" only when
  // followed by the input box. If there's NO bare prompt below the
  // completion, the input box hasn't redrawn yet — Claude is still
  // running (about to call a tool, stream more text, etc.).
  if (lastCompletionIdx >= 0 && lastBarePromptIdx <= lastCompletionIdx) {
    return {
      state: "thinking",
      hint:
        "Claude Code finished one thinking block but the input prompt isn't back yet — still working.",
    };
  }

  // (7) Tool-use callout below any prompt or completion → mid-task.
  if (
    lastToolUseIdx >= 0 &&
    lastToolUseIdx > lastBarePromptIdx &&
    lastToolUseIdx > lastCompletionIdx
  ) {
    return {
      state: "thinking",
      hint: "Claude Code is mid-tool-call — let it finish.",
    };
  }

  // (8) Bare prompt visible (input box drawn below idle/done content).
  if (lastBarePromptIdx >= 0 || BARE_PROMPT_RX.test(bottom)) {
    return {
      state: "at_prompt",
      hint: "Claude Code is idle at its input prompt.",
    };
  }

  // (9) Typed-but-not-submitted input. worker-status promotes this to
  // "awaiting_input" via detectStuckPrompt; here we surface as at_prompt
  // since the PTY itself isn't busy.
  if (lastTypedPromptIdx >= 0 || TYPED_PROMPT_RX.test(bottom)) {
    return {
      state: "at_prompt",
      hint: "Claude Code is at its prompt with typed text — input may be waiting.",
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
  const forState = rawTail.replace(ANSI_REGEX, "").replace(CARRIAGE_OVERWRITE_REGEX, "").replace(TUI_CHROME_REGEX, "");
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

export function readUserProfileTool(ctx: SparContext) {
  const body = readProfile(ctx.user.id);
  return { userId: ctx.user.id, body: body || "" };
}

export function updateUserProfileTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  const body = getStr(args, "body");
  if (body.length > 16_000) throw new Error("profile body too long (>16000 chars)");
  writeProfile(ctx.user.id, body);
  return { ok: true, userId: ctx.user.id, bytes: body.length };
}

// ---- Brain file tools ---------------------------------------------------
//
// Direct read / write / list against the structured brain markdown tree
// at BRAIN_ROOT. Closes the gap where the spar (phone/voice channel)
// could only route durable facts through wrapper tools (update_user_
// profile, update_heartbeat, write_graph) or by creating remarks
// tagged 'brain' for the next CLI session to flush.
//
// Path safety: every relPath is normalised, joined to BRAIN_ROOT, then
// confirmed to still resolve INSIDE BRAIN_ROOT. Anything that escapes
// (`..`, an absolute path, a symlink target outside) is rejected with
// a hard error. Only `.md` is writable; reads accept any extension so
// the spar can still inspect any non-md scaffolding the user adds.

const BRAIN_FILE_MAX_BYTES = 256 * 1024;

function resolveInBrain(relPathRaw: string): string {
  // Reject absolute inputs early so we never accidentally break out of
  // the root via path.resolve absorbing an absolute second arg.
  if (path.isAbsolute(relPathRaw)) {
    throw new Error("brain path must be relative (got absolute)");
  }
  // Normalise separators — the brain root is on Windows but the spar
  // CLI on macOS / Linux speaks forward slashes. Mixing both used to
  // make path.resolve produce surprises on Windows; normalising up
  // front keeps the safety check below honest.
  const normalised = relPathRaw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalised) throw new Error("brain path required");
  const candidate = path.resolve(BRAIN_ROOT, normalised);
  // path.resolve already collapses `..`, but a sibling directory whose
  // name STARTS with the root prefix could still pass a `startsWith`
  // check (`/braintest` vs `/brain`). Add the trailing separator to
  // close that hole.
  const rootWithSep = BRAIN_ROOT.endsWith(path.sep) ? BRAIN_ROOT : BRAIN_ROOT + path.sep;
  if (candidate !== BRAIN_ROOT && !candidate.startsWith(rootWithSep)) {
    throw new Error("brain path escapes the brain root");
  }
  return candidate;
}

export async function readBrainFileTool(
  _ctx: SparContext,
  args: Record<string, unknown>,
) {
  const relPath = getStr(args, "rel_path");
  const abs = resolveInBrain(relPath);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error("brain file not found");
  }
  const truncated = stat.size > BRAIN_FILE_MAX_BYTES;
  const fh = await fs.open(abs, "r");
  try {
    const buf = Buffer.alloc(Math.min(stat.size, BRAIN_FILE_MAX_BYTES));
    await fh.read(buf, 0, buf.length, 0);
    return {
      relPath,
      size: stat.size,
      truncated,
      content: buf.toString("utf8"),
    };
  } finally {
    await fh.close();
  }
}

interface WriteBrainArgs {
  /** Whole-file mode: replace the file body with this content. Mutually
   *  exclusive with section/find. */
  content?: string;
  /** Section-patch mode: substring (or regex when isRegex=true) to find
   *  inside the existing body. The match is replaced with `replacement`. */
  find?: string;
  isRegex?: boolean;
  replacement?: string;
}

export async function writeBrainFileTool(
  _ctx: SparContext,
  args: Record<string, unknown>,
) {
  const relPath = getStr(args, "rel_path");
  if (!relPath.toLowerCase().endsWith(".md")) {
    throw new Error("only .md files are writable in the brain");
  }
  const abs = resolveInBrain(relPath);
  const argsTyped = args as WriteBrainArgs;

  // Mode A: whole-file write. Used for fresh daily logs and for
  // wholesale rewrites the user signed off on.
  if (typeof argsTyped.content === "string") {
    if (argsTyped.find !== undefined || argsTyped.replacement !== undefined) {
      throw new Error("pass either content OR find+replacement, not both");
    }
    const body = argsTyped.content;
    if (body.length > BRAIN_FILE_MAX_BYTES) {
      throw new Error(
        `brain file body too long (>${BRAIN_FILE_MAX_BYTES} chars)`,
      );
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, "utf8");
    return { ok: true, relPath, mode: "overwrite", bytes: Buffer.byteLength(body, "utf8") };
  }

  // Mode B: targeted section patch. Read-modify-write so concurrent
  // writers don't clobber each other (best-effort; no real locking
  // here — same posture as updateHeartbeatTool).
  if (typeof argsTyped.find !== "string" || !argsTyped.find) {
    throw new Error("missing 'content' or 'find'+'replacement' arguments");
  }
  if (typeof argsTyped.replacement !== "string") {
    throw new Error("missing 'replacement' for section patch");
  }
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat || !stat.isFile()) {
    throw new Error(
      "cannot section-patch a non-existent file (use whole-file 'content' to create)",
    );
  }
  const existing = await fs.readFile(abs, "utf8");
  let next: string;
  if (argsTyped.isRegex) {
    let re: RegExp;
    try {
      re = new RegExp(argsTyped.find, "m");
    } catch (err) {
      throw new Error(
        `invalid regex: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!re.test(existing)) throw new Error("find regex did not match");
    next = existing.replace(re, argsTyped.replacement);
  } else {
    const idx = existing.indexOf(argsTyped.find);
    if (idx < 0) throw new Error("find substring not found");
    if (existing.indexOf(argsTyped.find, idx + argsTyped.find.length) >= 0) {
      throw new Error(
        "find substring is ambiguous (matches more than once) — pass more context or use isRegex",
      );
    }
    next = existing.slice(0, idx) + argsTyped.replacement + existing.slice(idx + argsTyped.find.length);
  }
  if (next.length > BRAIN_FILE_MAX_BYTES) {
    throw new Error(
      `patched brain file would exceed ${BRAIN_FILE_MAX_BYTES} chars`,
    );
  }
  await fs.writeFile(abs, next, "utf8");
  return {
    ok: true,
    relPath,
    mode: "patch",
    bytesBefore: Buffer.byteLength(existing, "utf8"),
    bytesAfter: Buffer.byteLength(next, "utf8"),
  };
}

interface BrainFileListEntry {
  relPath: string;
  size: number;
  modified: number;
  isDirectory: boolean;
}

export async function listBrainFilesTool(
  _ctx: SparContext,
  args: Record<string, unknown>,
) {
  const subdir = (args.subdir as string | undefined) ?? "";
  const recursive = args.recursive === true;
  const root = subdir ? resolveInBrain(subdir) : BRAIN_ROOT;
  const stat = await fs.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(subdir ? "subdir not found" : "brain root not found");
  }
  const out: BrainFileListEntry[] = [];

  async function walk(dirAbs: string): Promise<void> {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      // Hidden / system noise — skip the OS junk that creeps into
      // synced folders rather than dumping it on the assistant.
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dirAbs, entry.name);
      const rel = path
        .relative(BRAIN_ROOT, abs)
        .replace(/\\/g, "/");
      if (entry.isDirectory()) {
        out.push({ relPath: rel + "/", size: 0, modified: 0, isDirectory: true });
        if (recursive) await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const s = await fs.stat(abs).catch(() => null);
      if (!s) continue;
      out.push({
        relPath: rel,
        size: s.size,
        modified: s.mtimeMs,
        isDirectory: false,
      });
    }
  }
  await walk(root);
  // Stable ordering: directories first, then files, both alphabetical.
  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.relPath.localeCompare(b.relPath);
  });
  return { root: subdir || ".", count: out.length, entries: out };
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
  // Auto-switch filler mode to "youtube" via the snapshot helper so
  // the user's prior mode is restored when youtube_stop fires.
  const { enableYouTubeMode } = await import("./filler-mode");
  try {
    await enableYouTubeMode();
  } catch (err) {
    // Non-fatal: the video state is set regardless; this only
    // affects which mode the browser respects.
    // eslint-disable-next-line no-console
    console.warn(`[youtube_play] enableYouTubeMode failed: ${String(err).slice(0, 120)}`);
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

  // If the enqueue promoted into now-playing, auto-switch the filler
  // mode to "youtube" via the snapshot helper. Otherwise leave mode
  // alone — user might be in news mode and just stacking up tracks
  // for later.
  if (promotedToCurrent) {
    const { enableYouTubeMode } = await import("./filler-mode");
    try {
      await enableYouTubeMode();
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
  // Restore the user's pre-YouTube filler mode (the snapshot taken
  // by enableYouTubeMode at the matching play call). Falls back to
  // the default mode if no snapshot was recorded.
  const { disableYouTubeMode, getFillerConfig } = await import("./filler-mode");
  let restoredMode: string = "news";
  try {
    await disableYouTubeMode();
    const config = await getFillerConfig();
    restoredMode = config.mode;
  } catch {
    /* non-fatal — restoredMode falls back to its initial guess */
  }
  return { ok: true, mode: restoredMode, state };
}

async function fillerSetModeTool(
  _ctx: SparContext,
  args: Record<string, unknown>,
) {
  const { setFillerMode, USER_SELECTABLE_MODES } = await import("./filler-mode");
  const mode = getStr(args, "mode").trim();
  // "youtube" mode is automatic — driven by youtube_play / youtube_stop
  // through enableYouTubeMode / disableYouTubeMode so the previousMode
  // snapshot is captured. Direct selection via filler_set_mode would
  // skip the snapshot and leave the user unable to restore.
  if (!(USER_SELECTABLE_MODES as readonly string[]).includes(mode)) {
    throw new Error(
      `invalid mode: ${mode}. Valid: ${USER_SELECTABLE_MODES.join(", ")} ` +
        `(youtube is automatic — use youtube_play instead).`,
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
  // fallback rules: youtube with no video → news; news/quiet are
  // literal; fun-facts/calendar pull from the dashboard's TTS
  // content system. Browser still has the final say (e.g. if the
  // news pool is empty it falls back to silence) but this is the
  // best read we can give without polling the client.
  let activeSource: string;
  if (mode === "quiet") activeSource = "quiet";
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

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Where freshly-created projects land when no path is supplied. Mirrors
 *  the API route in app/api/projects/route.ts so spar-created projects
 *  use the same on-disk layout as ones the admin makes via the UI. */
function defaultProjectsRoot(): string {
  const envRoot = process.env.AMASO_PROJECTS_ROOT?.trim();
  if (envRoot) return path.resolve(envRoot).replace(/\\/g, "/");
  return path.resolve(process.cwd(), "..").replace(/\\/g, "/");
}

function createProjectTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  // Mirrors POST /api/projects: writing amaso.config.json + mkdir on
  // disk is privileged enough that we gate it the same way deploy is
  // gated — super-user only.
  requireSuperUserCtx(ctx);

  const id = getStr(args, "id").trim();
  const name = getStr(args, "name").trim();
  if (!PROJECT_ID_PATTERN.test(id)) {
    throw new Error("invalid_id: lowercase letters, digits, dashes only");
  }
  if (!name) throw new Error("name must not be empty");

  const visibilityRaw = getOptStr(args, "visibility") ?? "team";
  if (!["team", "client", "public"].includes(visibilityRaw)) {
    throw new Error("invalid_visibility (team | client | public)");
  }
  const visibility = visibilityRaw as ProjectVisibility;

  // Path: either the caller supplied one (must exist + be a directory)
  // or we mint a fresh empty folder under the projects root using the
  // project id as the folder name.
  const rawPath = getOptStr(args, "path");
  let diskPath: string;
  if (rawPath) {
    let stat: ReturnType<typeof nodeFs.statSync>;
    try {
      stat = nodeFs.statSync(rawPath);
    } catch {
      throw new Error(`path_not_found: ${rawPath}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`path_not_directory: ${rawPath}`);
    }
    diskPath = rawPath;
  } else {
    const root = defaultProjectsRoot();
    const candidate = `${root}/${id}`;
    if (nodeFs.existsSync(candidate)) {
      throw new Error(`auto_path_exists: ${candidate}`);
    }
    try {
      nodeFs.mkdirSync(candidate, { recursive: true });
    } catch (err) {
      console.error("[spar create_project] mkdir failed:", candidate, err);
      throw new Error("mkdir_failed");
    }
    diskPath = candidate;
  }

  const project: ProjectConfig = { id, name, path: diskPath, visibility };
  const subPath = getOptStr(args, "sub_path");
  if (subPath) project.subPath = subPath;
  const previewUrl = getOptStr(args, "preview_url");
  if (previewUrl) project.previewUrl = previewUrl;
  const liveUrl = getOptStr(args, "live_url");
  if (liveUrl) project.liveUrl = liveUrl;
  const devPort = getOptNum(args, "dev_port");
  if (typeof devPort === "number" && Number.isInteger(devPort)) {
    project.devPort = devPort;
  }
  const devCommand = getOptStr(args, "dev_command");
  if (devCommand) project.devCommand = devCommand;
  const deployBranch = getOptStr(args, "deploy_branch");
  if (deployBranch) project.deployBranch = deployBranch;

  try {
    addProject(project);
  } catch (err) {
    if (err instanceof Error && err.message === "duplicate_id") {
      throw new Error(`duplicate_id: ${id}`);
    }
    throw err;
  }
  return { ok: true, project };
}

function deleteProjectTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  // Same gate as create — only the super-user can mutate the project
  // registry. Files on disk are deliberately left alone; un-registering
  // is reversible (just call create_project again with the same path).
  requireSuperUserCtx(ctx);
  const id = getStr(args, "id").trim();
  try {
    removeProject(id);
  } catch (err) {
    if (err instanceof Error && err.message === "project_not_found") {
      throw new Error(`project_not_found: ${id}`);
    }
    throw err;
  }
  return { ok: true, removed: id };
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

/**
 * Drive the dashboard UI remotely on behalf of the calling user.
 * Mirrors the route handler at /api/spar/remote-control: validates
 * the action, mutates durable state for actions that need it
 * (autopilot toggle / directive), and broadcasts a
 * `spar:remote_control` WS event to every socket the user has open
 * so any visible spar tab applies the change instantly.
 *
 * Why this lives in the MCP layer too: the spar agent already has
 * the user's bearer token via the loopback dispatcher, and going
 * through HTTP would mean the agent fetches its own host. Keeping
 * the impl here avoids that round-trip and stays consistent with
 * every other write tool (resolve_remark, dispatch_to_project, etc).
 */
async function dashboardControlTool(
  ctx: SparContext,
  args: Record<string, unknown>,
) {
  const action = getStr(args, "action").trim();
  const value = args.value;
  const side = args.side;

  let payload: SparRemoteControlAction;
  switch (action) {
    case "toggle_autopilot": {
      if (typeof value !== "boolean") {
        throw new Error("toggle_autopilot requires boolean `value`");
      }
      if (value) enableAutopilot(ctx.user.id);
      else disableAutopilot(ctx.user.id);
      payload = { action, value };
      break;
    }
    case "open_sidebar":
    case "close_sidebar": {
      if (side !== "left" && side !== "right") {
        throw new Error(`${action} requires \`side\` of "left" | "right"`);
      }
      payload = { action, side };
      break;
    }
    case "new_conversation": {
      payload = { action };
      break;
    }
    case "set_directive": {
      if (typeof value !== "string") {
        throw new Error("set_directive requires string `value`");
      }
      if (value.length > 2_000) {
        throw new Error("directive too long (>2000 chars)");
      }
      writeAutopilotDirective(ctx.user.id, value);
      payload = { action, value };
      break;
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }

  const wsPayload: SparRemoteControlPayload = {
    id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    issuedAt: Date.now(),
    payload,
  };
  broadcastSparRemoteControl(ctx.user.id, wsPayload);
  return { ok: true, action, id: wsPayload.id };
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
  read_user_profile: (ctx) => readUserProfileTool(ctx),
  update_user_profile: (ctx, a) => updateUserProfileTool(ctx, a),
  read_brain_file: (ctx, a) => readBrainFileTool(ctx, a),
  write_brain_file: (ctx, a) => writeBrainFileTool(ctx, a),
  list_brain_files: (ctx, a) => listBrainFilesTool(ctx, a),
  read_graph: (ctx) => readGraphTool(ctx),
  write_graph: (ctx, a) => writeGraphTool(ctx, a),
  youtube_search: (ctx, a) => youtubeSearchTool(ctx, a),
  youtube_play: (ctx, a) => youtubePlayTool(ctx, a),
  youtube_enqueue: (ctx, a) => youtubeEnqueueTool(ctx, a),
  youtube_stop: (ctx) => youtubeStopTool(ctx),
  youtube_status: (ctx) => youtubeStatusTool(ctx),
  filler_set_mode: (ctx, a) => fillerSetModeTool(ctx, a),
  filler_get_mode: (ctx) => fillerGetModeTool(ctx),
  autopilot_status: (ctx) => ({
    enabled: isAutopilotEnabled(ctx.user.id),
    directive: readAutopilotDirective(ctx.user.id),
  }),
  // Chat
  list_channels: (ctx) => listChannelsTool(ctx),
  read_messages: (ctx, a) => readMessagesTool(ctx, a),
  send_message: (ctx, a) => sendMessageTool(ctx, a),
  create_dm: (ctx, a) => createDmTool(ctx, a),
  // Project actions
  deploy_project: (ctx, a) => deployProjectTool(ctx, a),
  start_terminal: (ctx, a) => startTerminalTool(ctx, a),
  stop_terminal: (ctx, a) => stopTerminalTool(ctx, a),
  create_project: (ctx, a) => createProjectTool(ctx, a),
  delete_project: (ctx, a) => deleteProjectTool(ctx, a),
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
  // Remote dashboard control — drive UI state from the spar agent.
  dashboard_control: (ctx, a) => dashboardControlTool(ctx, a),
};
