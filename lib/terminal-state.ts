// Shared worker-state detection.
//
// Source of truth for "is this Claude Code session currently working,
// done, gated on a permission, or sitting at an empty prompt?" Used by
// two callers:
//
//   1. /api/spar/worker-status — surfaces the state to the workers
//      panel UI.
//   2. lib/terminal-idle.ts    — drives the auto-report fire decision
//      from the working→at_prompt transition (replacing the older 5 s
//      idle-time heuristic that false-positived on Claude Code's
//      initialisation pause).
//
// Pulled out of the worker-status route so both callers run on
// bit-identical regexes — if the route's detection ever drifts, the
// auto-report drifts with it.

import {
  ANSI_REGEX,
  CARRIAGE_OVERWRITE_REGEX,
  TUI_CHROME_REGEX,
  cleanScrollback,
  detectTerminalState,
} from "./spar-tools-context";

// Tail size for state detection. Smaller than the MCP scrollback tool's
// default because we run this on every poll for every visible project —
// 16 KB is plenty for the last-line + state heuristic.
export const STATE_TAIL_BYTES = 16_384;

// How many trailing lines of cleaned scrollback to scan for the
// "summary" line. The cleaner already drops status spinners, so this
// just walks backward until something useful surfaces.
const SUMMARY_SCAN_LINES = 8;

// "Active status" line shape: a verb in "-ing" form on the line plus a
// parenthesised timer. Examples:
//   "✢ Elucidating… (28s · ↓ 1.0k tokens · still thinking)"
//   "* Cogitating (4s · esc to interrupt)"
//   "✻ Cogitating… (1m 11s · ↓ 2.4k tokens · still thinking)"
// The optional "Nm " prefix on the timer covers the cross-1-minute
// switch from "(Ns" to "(Nm Ms".
export const ACTIVITY_LINE_REGEX =
  /\b[A-Za-z]+ing\b[^\n]{0,80}\(\s*(?:[^()]*?\s)?(?:\d+\s*m\s+)?\d+\s*s\b/i;

// Working-status line as it appears OUT of context (what we look for in
// the resolved `lastLine`). Requires the ellipsis explicitly so we don't
// false-positive on "Crunched ideas… (↓ 2.4k)" — completion drag-along.
export const ACTIVE_STATUS_RX =
  /\b[A-Za-z]+ing\b[^\n]*?(?:…|\.\.\.)\s*\(\s*(?:[^()]*?\s)?(?:\d+\s*m\s+)?\d+\s*s\b/i;

// Past-tense completion line: "Brewed for 2m 20s", "Cogitated for 12s".
// Always takes precedence over an in-flight active status — once the
// turn ends we should never be classified as still working.
export const COMPLETION_RX =
  /\b[A-Za-z]+(?:ed|t)\b\s+for\s+(?:\d+\s*m\s+)?\d+\s*s\b/i;

const COMPLETION_LINE_RX = /\w+(?:ed|t)\s+for\s+(?:\d+\s*m\s+)?\d+\s*s/i;

// Cache the last activity/completion line per session so it survives
// Claude Code's TUI redraw (which overwrites the status text in the
// scrollback buffer). Keyed by sessionId; invalidated when the session
// restarts (sessionStart changes).
const lastActivityCache = new Map<
  string,
  { line: string; sessionStart: number }
>();

export type WorkerState =
  | "thinking"
  | "permission_gate"
  | "at_prompt"
  | "awaiting_input"
  | "unknown";

export interface WorkerStateResult {
  state: WorkerState;
  hint: string;
  /** Best representation of the most recent meaningful line — either an
   *  active spinner row, a completion line, or a clean tail line. The
   *  workers panel surfaces this verbatim. */
  lastLine: string;
}

function findLastMatch(
  text: string,
  rx: RegExp,
): { match: string; index: number } | null {
  const g = new RegExp(rx.source, rx.flags.includes("g") ? rx.flags : rx.flags + "g");
  let last: { match: string; index: number } | null = null;
  for (const m of text.matchAll(g)) last = { match: m[0], index: m.index! };
  return last;
}

function pickActivityLine(rawStripped: string): string {
  const cap = (s: string) => (s.length > 140 ? s.slice(0, 137) + "…" : s);
  const lastCompletion = findLastMatch(rawStripped, COMPLETION_LINE_RX);
  const lastActivity = findLastMatch(rawStripped, ACTIVITY_LINE_REGEX);
  const pick =
    lastCompletion && (!lastActivity || lastCompletion.index >= lastActivity.index)
      ? lastCompletion
      : lastActivity;
  if (!pick) return "";
  let start = pick.index;
  while (start > 0 && rawStripped[start - 1] !== "\r" && rawStripped[start - 1] !== "\n") start--;
  let end = pick.index + pick.match.length;
  while (end < rawStripped.length && rawStripped[end] !== "\r" && rawStripped[end] !== "\n") end++;
  return cap(rawStripped.slice(start, end).trim());
}

function pickSummaryLine(clean: string): string {
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.slice(-SUMMARY_SCAN_LINES);
  const cap = (s: string) => (s.length > 140 ? s.slice(0, 137) + "…" : s);

  for (let i = tail.length - 1; i >= 0; i--) {
    if (COMPLETION_LINE_RX.test(tail[i])) return cap(tail[i]);
  }
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = /^[>❯]\s+(.+)$/.exec(tail[i]);
    if (m) return cap(m[1].trim());
  }
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!line) continue;
    if (/^[>│▌$›❯]\s*$/.test(line)) continue;
    if (/^[>❯]/.test(line)) continue;
    if (ACTIVITY_LINE_REGEX.test(line)) continue;
    return cap(line);
  }
  return "";
}

// A "stuck prompt" is a TUI input row that has user-typed content but
// hasn't been submitted (Enter never pressed). We surface this as a
// distinct state so the auto-report path knows NOT to fire — the user
// owes the terminal a keypress.
function detectStuckPrompt(clean: string): { stuck: boolean; preview: string } {
  const lines = clean
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const tail = lines.slice(-SUMMARY_SCAN_LINES);
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (!line) continue;
    if (/^[>│▌$›❯]\s*$/.test(line)) return { stuck: false, preview: "" };
    const m = /^[>❯$›]\s+(.+)$/.exec(line);
    if (m) {
      const content = m[1].trim();
      if (!content) return { stuck: false, preview: "" };
      return {
        stuck: true,
        preview: content.length > 80 ? content.slice(0, 77) + "…" : content,
      };
    }
    return { stuck: false, preview: "" };
  }
  return { stuck: false, preview: "" };
}

/**
 * Detect a session's current worker state from its scrollback. Pure
 * string ops on the in-memory ring buffer — cheap to call on every
 * incoming chunk.
 *
 * `sessionId` and `sessionStart` are used together to invalidate the
 * lastActivityCache (which lets us re-show "Brewed for 5s" even after
 * Claude Code's TUI has overwritten that line with the empty prompt).
 * Pass them or pass undefined to skip caching entirely (terminal-idle
 * uses the un-cached path because it needs fresh state on every chunk).
 */
export function detectWorkerState(
  scrollback: string,
  sessionId?: string,
  sessionStart?: number,
): WorkerStateResult {
  const sb = scrollback;
  const rawTail = sb.slice(Math.max(0, sb.length - STATE_TAIL_BYTES));
  // State detection runs on ANSI + box-drawing strip PLUS carriage-
  // return overwrite collapse. Without the \r-collapse, in-place
  // rewrites of the activity row ("Elucidating (28s)\rElucidating
  // (29s)\r…") accumulate as raw bytes in the rolling scrollback.
  const forState = rawTail
    .replace(ANSI_REGEX, "")
    .replace(CARRIAGE_OVERWRITE_REGEX, "")
    .replace(TUI_CHROME_REGEX, "");
  const { state: baseState, hint } = detectTerminalState(forState);
  const cleaned = cleanScrollback(rawTail);
  // Activity/completion scanning needs the raw CR segments intact:
  // Claude Code overwrites "Cogitated for 10s" with the ❯ prompt
  // on the same line via \r. CR-collapse strips the completion text.
  const forActivity = rawTail.replace(ANSI_REGEX, "").replace(TUI_CHROME_REGEX, "");
  let lastLine = pickActivityLine(forActivity);
  if (sessionId && typeof sessionStart === "number") {
    const cached = lastActivityCache.get(sessionId);
    if (lastLine) {
      lastActivityCache.set(sessionId, { line: lastLine, sessionStart });
    } else if (cached && cached.sessionStart === sessionStart) {
      lastLine = cached.line;
    }
  }
  if (!lastLine) lastLine = pickSummaryLine(cleaned);

  let state: WorkerState;
  let resolvedHint = hint;
  if (baseState === "permission_gate") {
    state = "permission_gate";
  } else if (ACTIVE_STATUS_RX.test(lastLine)) {
    // Active spinner wins on the resolved line. A line like
    //   "✶ Verifying… (11m 26s · ↓ 39.3k tokens · thought for 1s)"
    // contains a `thought for 1s` fragment inside the parens that
    // matches COMPLETION_RX too — checking ACTIVE first prevents the
    // false "done" classification (and the false auto-report fire that
    // followed in the old order). The "Brewing… vs Brewed for 5s"
    // two-row case the prior comment worried about is already handled
    // by pickActivityLine's index-preference, so the resolved single
    // line is unambiguous here.
    state = "thinking";
    resolvedHint = "Claude Code is actively processing.";
  } else if (COMPLETION_RX.test(lastLine)) {
    state = "at_prompt";
    resolvedHint = "Last task completed — ready for the next.";
  } else {
    const stuck = detectStuckPrompt(cleaned);
    if (stuck.stuck) {
      state = "awaiting_input";
      resolvedHint = `Prompt typed but not submitted: "${stuck.preview}"`;
    } else {
      state = "at_prompt";
      resolvedHint = "Idle at prompt — ready for the next task.";
    }
  }
  return { state, hint: resolvedHint, lastLine };
}

/** True when the visible last line is a past-tense completion ("Brewed
 *  for 5s"). Cheap exact-match check — used by the auto-report path
 *  for the post-restart recovery branch where we may have missed the
 *  working→at_prompt transition while the dashboard was down. */
export function lastLineIsCompletion(lastLine: string): boolean {
  return COMPLETION_RX.test(lastLine);
}

/** Drop the cached last-activity line for a session — call when the
 *  session is stopped/restarted so the next detection pass starts
 *  fresh. Idempotent. */
export function clearWorkerStateCache(sessionId: string): void {
  lastActivityCache.delete(sessionId);
}
