// Spar dispatches a crafted prompt into a project's Claude Code terminal
// in a single step. Safety model: the sparring partner is prompt-disciplined
// to describe the prompt aloud and get a spoken yes/no before calling the
// tool. A visible UI banner mirrors every fire so Santi always sees what
// landed in which project.
//
// We keep a bounded in-memory log per user so the UI can render a recent
// dispatch banner and (future) a dispatch history drawer.

import { start as startTerminal, write as writeTerminal, getSession } from "./terminal";
import { getProject } from "./config";

export interface DispatchLogEntry {
  id: string;
  userId: number;
  projectId: string;
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

declare global {
  // eslint-disable-next-line no-var
  var __amasoSparDispatchLog: Map<number, DispatchLogEntry[]> | undefined;
}

function logStore(): Map<number, DispatchLogEntry[]> {
  if (!globalThis.__amasoSparDispatchLog) {
    globalThis.__amasoSparDispatchLog = new Map();
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
  const entry: DispatchLogEntry = {
    id,
    userId,
    projectId,
    prompt: trimmed,
    confirmedAt: Date.now(),
    status: "sent",
  };
  try {
    if (!getSession(projectId)) {
      startTerminal(projectId);
    }
    // Paste the body first without a terminating CR.
    const ok = writeTerminal(projectId, PASTE_START + trimmed + PASTE_END, userId);
    if (!ok) throw new Error("failed to write to terminal");
    // Then fire a standalone Enter keystroke after a short settle so the
    // TUI's paste detector treats it as submit, not mid-paste content.
    setTimeout(() => {
      try {
        if (getSession(projectId)) {
          writeTerminal(projectId, "\r", userId);
        }
      } catch {
        /* session may have died in the interim — nothing to do */
      }
    }, SUBMIT_DELAY_MS);
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
      return r;
    }
  }
  return null;
}
