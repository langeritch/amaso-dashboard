// Spar dispatches a crafted prompt into a project's Claude Code terminal
// in a single step. Safety model: the sparring partner is prompt-disciplined
// to describe the prompt aloud and get a spoken yes/no before calling the
// tool. A visible UI banner mirrors every fire so Santi always sees what
// landed in which project.
//
// We keep a bounded in-memory log per user so the UI can render a recent
// dispatch banner and (future) a dispatch history drawer. The log is also
// mirrored to data/spar-dispatches.json so a dashboard restart mid-task
// doesn't wipe the pending entries — without that, the post-restart
// recovery in terminal-backend.init() would have nothing to re-arm and
// the auto-report would never fire for a dispatch that finishes after
// the watchdog cycles us.

import fs from "node:fs";
import path from "node:path";
import {
  start as startTerminal,
  write as writeTerminal,
  getSession,
  listSessionsForProject,
} from "./terminal-backend";
import { isSessionBusy } from "./terminal-idle";
import { getProject } from "./config";

export interface DispatchLogEntry {
  id: string;
  userId: number;
  projectId: string;
  /** Specific terminal session this dispatch landed in. Stage 1 of
   *  remark #285 always equals projectId — Stage 2 introduces real
   *  per-spawn ids and routing helpers. Optional on the type so
   *  legacy log entries on disk parse without migration. */
  sessionId?: string;
  prompt: string;
  confirmedAt: number;
  status: "sent" | "failed";
  error?: string;
  /** Ms epoch at which the project's Claude Code session returned to
   *  an idle prompt after this dispatch. Populated by terminal.ts's
   *  idle-timer callback. Null until the task finishes. */
  completedAt?: number;
}

const MAX_LOG_PER_USER = 20;
// Gap between pasting the prompt body and sending the Enter keystroke.
// Claude Code's TUI auto-detects pastes: if the CR arrives in the same
// burst as the body, it's treated as another line of input instead of
// "submit". A short pause lets the paste detector finalize so the CR
// lands as an explicit Enter press. Tunable via env for slower machines.
const SUBMIT_DELAY_MS = Number(process.env.AMASO_DISPATCH_SUBMIT_DELAY_MS ?? "250");
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// How long to wait after the submit-Enter before checking whether the
// prompt actually started executing. Long enough that a real response
// has begun streaming activity rows ("Elucidating (Ns)…"), short enough
// that a stuck dispatch gets unblocked before the user notices. Tunable
// via env. Set to 0 to disable the watchdog entirely.
const WATCHDOG_DELAY_MS = Number(process.env.AMASO_DISPATCH_WATCHDOG_MS ?? "7000");

// Inline ANSI/TUI strip + carriage-return collapse for the watchdog's
// stuck-prompt heuristic. We can't import these from spar-tools-context
// without creating a circular import (it already imports us back). Kept
// in sync with the regexes there.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B(?:\][^\x07]*\x07|[PX^_][^\x1B]*\x1B\\|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;
const TUI_CHROME_RE = /[─-▟⠀-⣿]/g;
// eslint-disable-next-line no-control-regex
const CR_OVERWRITE_RE = /^.*\r(?!\n)/gm;
const ACTIVITY_RE =
  /\b[a-z]+ing\b[^\n]{0,80}\(\s*(?:\d+\s*m\s*)?\d+\s*s\b/i;

// True when the terminal tail looks like a typed-but-not-submitted
// prompt: a `> something` row at the bottom with no live activity row
// above it. Mirrors detectStuckPrompt in the worker-status route.
function looksStuckOnPrompt(rawTail: string): boolean {
  const cleaned = rawTail
    .replace(ANSI_RE, "")
    .replace(CR_OVERWRITE_RE, "")
    .replace(TUI_CHROME_RE, "");
  const lines = cleaned
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-12);
  // If a live activity row is present, Claude is working — not stuck.
  if (lines.some((l) => ACTIVITY_RE.test(l))) return false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (/^[>│▌$›❯]\s*$/.test(line)) return false; // bare prompt = idle, not stuck
    const m = /^[>❯$›]\s+(.+)$/.exec(line);
    if (m && m[1].trim()) return true;
    // First non-prompt line we hit means the input row isn't at the
    // bottom — no stuck prompt to flag.
    return false;
  }
  return false;
}

declare global {
  // eslint-disable-next-line no-var
  var __amasoSparDispatchLog: Map<number, DispatchLogEntry[]> | undefined;
}

const DISPATCH_LOG_PATH = path.resolve(
  process.cwd(),
  "data",
  "spar-dispatches.json",
);

function loadDispatchLog(): Map<number, DispatchLogEntry[]> {
  try {
    if (!fs.existsSync(DISPATCH_LOG_PATH)) return new Map();
    const text = fs.readFileSync(DISPATCH_LOG_PATH, "utf-8");
    const parsed = JSON.parse(text) as Record<string, DispatchLogEntry[]>;
    const map = new Map<number, DispatchLogEntry[]>();
    for (const [k, v] of Object.entries(parsed)) {
      const userId = Number(k);
      if (!Number.isFinite(userId) || !Array.isArray(v)) continue;
      // Filter out malformed rows so a hand-edit / corrupted file
      // can't crash the load path.
      const rows = v.filter(
        (r): r is DispatchLogEntry =>
          !!r &&
          typeof r.id === "string" &&
          typeof r.projectId === "string" &&
          typeof r.userId === "number" &&
          (r.status === "sent" || r.status === "failed"),
      );
      if (rows.length > 0) map.set(userId, rows);
    }
    return map;
  } catch (err) {
    console.warn("[spar-dispatch] loadDispatchLog failed:", err);
    return new Map();
  }
}

function saveDispatchLog(): void {
  try {
    const m = logStore();
    const obj: Record<string, DispatchLogEntry[]> = {};
    for (const [k, v] of m) obj[String(k)] = v;
    fs.mkdirSync(path.dirname(DISPATCH_LOG_PATH), { recursive: true });
    // Atomic write: tmp + rename so a crash mid-write can't leave a
    // half-truncated JSON the next boot fails to parse.
    const tmp = DISPATCH_LOG_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, DISPATCH_LOG_PATH);
  } catch (err) {
    console.warn("[spar-dispatch] saveDispatchLog failed:", err);
  }
}

function logStore(): Map<number, DispatchLogEntry[]> {
  if (!globalThis.__amasoSparDispatchLog) {
    globalThis.__amasoSparDispatchLog = loadDispatchLog();
  }
  return globalThis.__amasoSparDispatchLog;
}

function appendLog(entry: DispatchLogEntry): void {
  const s = logStore();
  const existing = s.get(entry.userId) ?? [];
  existing.push(entry);
  if (existing.length > MAX_LOG_PER_USER) {
    existing.splice(0, existing.length - MAX_LOG_PER_USER);
  }
  s.set(entry.userId, existing);
  saveDispatchLog();
}

/**
 * Pick the terminal session that should receive a dispatch for `projectId`.
 *
 * Stage 2 of remark #285:
 *   - No live sessions yet → return projectId. The first session for a
 *     project keeps the legacy projectId-keyed id so single-session
 *     projects look bit-for-bit identical to pre-refactor (existing
 *     scrollback/idle/observer state stays addressable the same way).
 *   - One or more live sessions → walk them oldest-first and return the
 *     first that isn't mid-dispatch (`isSessionBusy` is false). Oldest-
 *     first is intentional: a session the user has been working in
 *     already has warm context; we'd rather queue alongside than wake a
 *     fresh PTY.
 *   - All sessions busy → return null, signalling "spawn a new one".
 *     `dispatchToProject` then allocates a fresh sessionId via
 *     `freshSessionId` and starts a parallel session.
 *
 * Lives here (not in terminal-backend) so the dispatch log can record
 * the chosen sessionId on the entry — the auto-report path then keys
 * its idle-arming state on the same id.
 */
function resolveSessionForDispatch(projectId: string): string | null {
  const sessions = listSessionsForProject(projectId);
  if (sessions.length === 0) return projectId;
  const sorted = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  for (const s of sorted) {
    if (!isSessionBusy(s.sessionId)) return s.sessionId;
  }
  return null;
}

/** Allocate a sessionId for a brand-new parallel session under a
 *  project. Format: `<projectId>__s<base36-time><base36-rand>` — the
 *  `__s` infix lets debuggers spot non-default sessions at a glance,
 *  and the time+rand suffix is collision-resistant enough for the
 *  human-scale spawn rate the workers panel produces. */
function freshSessionId(projectId: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `${projectId}__s${t}${r}`;
}

export function dispatchToProject(
  userId: number,
  projectId: string,
  prompt: string,
): DispatchLogEntry {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("empty prompt");
  if (trimmed.length > 8_000) throw new Error("prompt too long (>8000 chars)");
  if (!getProject(projectId)) throw new Error(`unknown project: ${projectId}`);
  const id = `dsp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  // Resolver returns null when every existing session for this project
  // is mid-dispatch — in that case we allocate a fresh sessionId here
  // and the `if (!getSession ...) startTerminal(...)` block below spawns
  // it. The new session's id is stable for the lifetime of this dispatch
  // (used by the watchdog, the dispatch log, and idle-arming below).
  const sessionId = resolveSessionForDispatch(projectId) ?? freshSessionId(projectId);
  const entry: DispatchLogEntry = {
    id,
    userId,
    projectId,
    sessionId,
    prompt: trimmed,
    confirmedAt: Date.now(),
    status: "sent",
  };
  try {
    if (!getSession(projectId, sessionId)) {
      startTerminal(projectId, undefined, undefined, sessionId);
    }
    // Paste the body first without a terminating CR.
    const ok = writeTerminal(
      projectId,
      PASTE_START + trimmed + PASTE_END,
      userId,
      sessionId,
    );
    if (!ok) throw new Error("failed to write to terminal");
    // Then fire a standalone Enter keystroke after a short settle so the
    // TUI's paste detector treats it as submit, not mid-paste content.
    setTimeout(() => {
      try {
        if (getSession(projectId, sessionId)) {
          writeTerminal(projectId, "\r", userId, sessionId);
        }
      } catch {
        /* session may have died in the interim — nothing to do */
      }
    }, SUBMIT_DELAY_MS);
    // Watchdog: a few seconds after the submit-Enter, peek at the
    // terminal scrollback. If the prompt body is still sitting in the
    // input row with no activity row ("…ing (Ns)") above it, the Enter
    // got eaten — fire one more \r to nudge it. Only fires once per
    // dispatch and only when stuck; a real "thinking" state is left
    // alone. Set AMASO_DISPATCH_WATCHDOG_MS=0 to disable.
    if (WATCHDOG_DELAY_MS > 0) {
      setTimeout(() => {
        try {
          const session = getSession(projectId, sessionId);
          if (!session) return;
          const tail = session.scrollback.slice(-8_192);
          if (!looksStuckOnPrompt(tail)) return;
          console.warn(
            `[dispatch] watchdog: prompt still unsubmitted after ${WATCHDOG_DELAY_MS}ms ` +
              `for project=${projectId} session=${sessionId} dispatch=${id} — sending Enter`,
          );
          writeTerminal(projectId, "\r", userId, sessionId);
        } catch (err) {
          console.warn(
            `[dispatch] watchdog error for project=${projectId} session=${sessionId} dispatch=${id}:`,
            err,
          );
        }
      }, WATCHDOG_DELAY_MS);
    }
  } catch (err) {
    entry.status = "failed";
    entry.error = err instanceof Error ? err.message : String(err);
  }
  appendLog(entry);
  return entry;
}

export function recentDispatches(userId: number, limit = 20): DispatchLogEntry[] {
  const rows = logStore().get(userId) ?? [];
  return rows.slice(-limit).reverse();
}

/** Cross-user view used by the team activity feed. Walks every user's
 *  ring-buffered log, merges by `confirmedAt` desc, and caps the
 *  result. Cheap because the log is in-memory and bounded per user
 *  (MAX_LOG_PER_USER) — the worst case is users × MAX_LOG_PER_USER
 *  entries, which is well under a thousand for any realistic team. */
export function recentDispatchesAllUsers(
  limit = 50,
): Array<{ userId: number; entry: DispatchLogEntry }> {
  const out: Array<{ userId: number; entry: DispatchLogEntry }> = [];
  for (const [userId, rows] of logStore()) {
    for (const r of rows) out.push({ userId, entry: r });
  }
  out.sort((a, b) => b.entry.confirmedAt - a.entry.confirmedAt);
  return out.slice(0, Math.max(1, Math.min(500, limit)));
}

/** Mark the most recent still-pending dispatch (for this user+project)
 *  as completed now. Called by terminal.ts when the project's Claude
 *  Code session goes idle after a submitted prompt. Returns the
 *  updated entry or null if no pending dispatch was found (e.g. the
 *  user typed directly in the terminal themselves, no dispatch to
 *  mark). */
export function markDispatchCompleted(
  userId: number,
  projectId: string,
): DispatchLogEntry | null {
  const rows = logStore().get(userId);
  if (!rows) return null;
  // Walk newest-first; we mark only the most recent eligible entry.
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (
      r.projectId === projectId &&
      r.status === "sent" &&
      r.completedAt === undefined
    ) {
      r.completedAt = Date.now();
      saveDispatchLog();
      return r;
    }
  }
  return null;
}

/** Every dispatch that's still in-flight across all users — status
 *  "sent" with no completedAt yet. Used by the post-restart recovery
 *  in lib/terminal-backend.ts to re-arm idle detection for entries
 *  that were dispatched before the dashboard cycled. Bounded by age
 *  so a stuck terminal from yesterday doesn't fire a stale auto-
 *  report when we boot tomorrow. */
const PENDING_RECOVERY_MAX_AGE_MS = 60 * 60 * 1000; // 1h
export function pendingDispatches(): Array<{
  userId: number;
  entry: DispatchLogEntry;
}> {
  const out: Array<{ userId: number; entry: DispatchLogEntry }> = [];
  const cutoff = Date.now() - PENDING_RECOVERY_MAX_AGE_MS;
  for (const [userId, rows] of logStore()) {
    for (const r of rows) {
      if (
        r.status === "sent" &&
        r.completedAt === undefined &&
        r.confirmedAt >= cutoff
      ) {
        out.push({ userId, entry: r });
      }
    }
  }
  return out;
}
