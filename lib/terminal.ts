// Per-project Claude CLI terminal sessions.
//
// One pseudo-TTY per project id. Sessions persist across browser reloads
// and tab switches — they only die when:
//   - The admin clicks "Stop" / "Restart"
//   - The dashboard process itself restarts (state is intentionally ephemeral,
//     we don't want to silently revive half-broken sessions)
//   - The child process exits on its own
//
// Output is broadcast to every WebSocket client subscribed to that session,
// so multiple browser tabs / devices see the same live stream. Input is
// accepted from any connected client — the server doesn't arbitrate.

import { spawn as ptySpawn, type IPty } from "node-pty";
import { EventEmitter } from "node:events";
import process from "node:process";
import { getProject } from "./config";
import { pushToUsers } from "./push";
import { markDispatchCompleted } from "./spar-dispatch";

export interface TerminalStatus {
  projectId: string;
  running: boolean;
  pid: number | null;
  cwd: string | null;
  startedAt: number | null;
  cols: number;
  rows: number;
  /** Snapshot of recent output so a reconnecting client can replay. */
  scrollback: string;
}

interface Session {
  projectId: string;
  proc: IPty;
  startedAt: number;
  cols: number;
  rows: number;
  /** Bounded ring of recent output bytes for replay on reconnect. */
  scrollback: string;
  emitter: EventEmitter;
  /** True after the user pressed Enter but before the follow-up idle push
   *  has fired. Prevents duplicate notifications for the same turn and
   *  keeps us from pushing when Claude simply happens to be silent. */
  awaitingResponse: boolean;
  /** User who submitted the current turn — they're the one who gets pinged
   *  when Claude finishes. null if the input came via an unauthenticated
   *  path (shouldn't happen in practice, but we no-op the push if so). */
  notifyUserId: number | null;
  idleTimer: NodeJS.Timeout | null;
}

// Per-session ring buffer. 1 MB holds ~10k lines of dense Claude Code
// output, enough that spar can look back across a long working session
// without losing early context. Override via AMASO_SCROLLBACK_BYTES.
const MAX_SCROLLBACK_BYTES = Number(process.env.AMASO_SCROLLBACK_BYTES ?? 1_000_000);
/** How long Claude must be silent after a submitted prompt before we consider
 *  it "done" and push a notification. Tuned to survive the periodic status
 *  line ("* Baked for …") but fire quickly after a real return-to-prompt. */
const IDLE_PUSH_MS = 5_000;

declare global {
  // eslint-disable-next-line no-var
  var __amasoTerminals: Map<string, Session> | undefined;
}

function registry(): Map<string, Session> {
  if (!globalThis.__amasoTerminals) globalThis.__amasoTerminals = new Map();
  return globalThis.__amasoTerminals;
}

interface ClaudeBinary {
  /** Executable to spawn. */
  exe: string;
  /** Args that follow. */
  args: string[];
}

/**
 * Locate the Claude CLI entry point we can hand to node-pty. On Windows we
 * bypass the `claude.cmd` shim and invoke the native binary directly — the
 * shim historically used `endLocal & goto` which broke inside nested PTYs.
 * Since v2.x, claude-code ships as a native SEA at bin/claude.exe (no cli.js),
 * so we point straight at that. Forward slashes survive ConPTY/winpty arg
 * escaping.
 */
function findClaudeBinary(): ClaudeBinary {
  if (process.env.AMASO_CLAUDE_CMD) {
    return { exe: process.env.AMASO_CLAUDE_CMD, args: [] };
  }
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) {
      const exe = (appdata + "/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe")
        .split("\\")
        .join("/");
      return { exe, args: [] };
    }
  }
  // POSIX: plain `claude` on PATH
  return { exe: "claude", args: [] };
}

/**
 * Scrub Anthropic auth env vars so the child uses the user's own
 * `claude auth login` credentials instead of whatever the dashboard
 * process inherited (e.g. a leaked sandbox token).
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) {
    if (
      k === "ANTHROPIC_API_KEY" ||
      k === "ANTHROPIC_AUTH_TOKEN" ||
      k === "ANTHROPIC_BASE_URL" ||
      k.startsWith("CLAUDE_CODE_") ||
      k === "CLAUDECODE"
    ) {
      delete env[k];
    }
  }
  // xterm wants these
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.FORCE_COLOR = "3";
  return env;
}

export function getSession(projectId: string): Session | null {
  return registry().get(projectId) ?? null;
}

export function getStatus(projectId: string): TerminalStatus {
  const s = registry().get(projectId);
  const project = getProject(projectId);
  if (!s) {
    return {
      projectId,
      running: false,
      pid: null,
      cwd: project?.path ?? null,
      startedAt: null,
      cols: 80,
      rows: 24,
      scrollback: "",
    };
  }
  return {
    projectId,
    running: true,
    pid: s.proc.pid ?? null,
    cwd: project?.path ?? null,
    startedAt: s.startedAt,
    cols: s.cols,
    rows: s.rows,
    scrollback: s.scrollback,
  };
}

export function start(projectId: string, cols = 100, rows = 30): Session {
  const reg = registry();
  const existing = reg.get(projectId);
  if (existing) return existing;

  const project = getProject(projectId);
  if (!project) throw new Error("project_not_found");

  const { exe, args } = findClaudeBinary();
  // bypassPermissions: dashboard-spawned sessions auto-approve edits,
  // writes, bash, reads — so spar can dispatch prompts and they just
  // run without a human-in-the-loop permission gate. This is sandboxed
  // to the project directory (cwd below) and the dashboard is only
  // reachable to the logged-in user, so the blast radius is the same as
  // "user types the command into the terminal themselves". Override
  // via AMASO_TERMINAL_PERMISSION_MODE (e.g. "default", "acceptEdits").
  const permissionMode = process.env.AMASO_TERMINAL_PERMISSION_MODE || "bypassPermissions";
  const sessionArgs = [...args, "--permission-mode", permissionMode];
  // Interactive Claude (no --print). Forward slashes in paths, and on
  // Windows we force `useConpty: false` → winpty backend. This matters
  // because Claude itself uses node-pty internally (for its own tool
  // invocations), and ConPTY can't be nested — the inner agent tries to
  // AttachConsole and the whole process dies with exit=1 before we see
  // any output. winpty has no such limitation.
  const proc = ptySpawn(exe, sessionArgs, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: project.path.split("\\").join("/"),
    env: cleanEnv() as { [key: string]: string },
    useConpty: process.platform !== "win32",
  });

  const session: Session = {
    projectId,
    proc,
    startedAt: Date.now(),
    cols,
    rows,
    scrollback: "",
    emitter: new EventEmitter(),
    awaitingResponse: false,
    notifyUserId: null,
    idleTimer: null,
  };

  proc.onData((data) => {
    // Append to scrollback, trim if over budget
    session.scrollback += data;
    if (session.scrollback.length > MAX_SCROLLBACK_BYTES) {
      session.scrollback = session.scrollback.slice(
        session.scrollback.length - MAX_SCROLLBACK_BYTES,
      );
    }
    session.emitter.emit("data", data);
    // Activity seen → (re)arm the idle timer. Claude streams periodic
    // "Baked for …" pulses so plain "no output" isn't reliable on its own;
    // we want the timer to reset on every chunk so only a real return-to-
    // prompt lull tips us over the IDLE_PUSH_MS threshold.
    if (session.awaitingResponse) armIdleTimer(session);
  });

  proc.onExit(({ exitCode, signal }) => {
    session.emitter.emit("exit", { exitCode, signal });
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    reg.delete(projectId);
  });

  reg.set(projectId, session);
  return session;
}

export function write(
  projectId: string,
  data: string,
  notifyUserId: number | null = null,
): boolean {
  const s = registry().get(projectId);
  if (!s) return false;
  s.proc.write(data);
  // Only start watching-for-idle once the user actually submits a prompt
  // (Enter). Plain character-by-character typing doesn't count — otherwise
  // a mid-sentence pause would mis-fire a "Claude done" push.
  if (data.includes("\r") || data.includes("\n")) {
    s.awaitingResponse = true;
    if (notifyUserId != null) s.notifyUserId = notifyUserId;
    armIdleTimer(s);
  }
  return true;
}

function armIdleTimer(session: Session) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => {
    session.idleTimer = null;
    if (!session.awaitingResponse) return;
    session.awaitingResponse = false;
    const userId = session.notifyUserId;
    if (userId == null) return;
    const project = getProject(session.projectId);
    const name = project?.name ?? session.projectId;

    // If this idle followed a spar-dispatched prompt, mark it complete
    // so the spar UI can auto-report back without the user asking. No-
    // op when the user typed the prompt themselves — in that case there
    // is no pending dispatch log entry to update.
    try {
      markDispatchCompleted(userId, session.projectId);
    } catch {
      /* non-fatal — the push still fires regardless */
    }

    void pushToUsers([userId], {
      title: "Claude is klaar",
      body: `${name} wacht op je.`,
      url: `/projects/${encodeURIComponent(session.projectId)}`,
      tag: `claude-idle-${session.projectId}`,
      data: { projectId: session.projectId },
    });
  }, IDLE_PUSH_MS);
}

export function resize(
  projectId: string,
  cols: number,
  rows: number,
): boolean {
  const s = registry().get(projectId);
  if (!s) return false;
  s.cols = cols;
  s.rows = rows;
  try {
    s.proc.resize(cols, rows);
  } catch {
    return false;
  }
  return true;
}

export function stop(projectId: string): boolean {
  const s = registry().get(projectId);
  if (!s) return false;
  try {
    s.proc.kill();
  } catch {
    /* already dead */
  }
  registry().delete(projectId);
  return true;
}

export function subscribe(
  projectId: string,
  onData: (chunk: string) => void,
  onExit: (payload: { exitCode: number; signal: number | undefined }) => void,
): () => void {
  const s = registry().get(projectId);
  if (!s) return () => {};
  s.emitter.on("data", onData);
  s.emitter.on("exit", onExit);
  return () => {
    s.emitter.off("data", onData);
    s.emitter.off("exit", onExit);
  };
}

// Best-effort cleanup on dashboard shutdown
if (!globalThis.__amasoTerminalsCleanupRegistered) {
  globalThis.__amasoTerminalsCleanupRegistered = true as never;
  const killAll = () => {
    for (const id of Array.from(registry().keys())) stop(id);
  };
  process.on("exit", killAll);
  process.on("SIGINT", () => {
    killAll();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    killAll();
    process.exit(0);
  });
}

declare global {
  // eslint-disable-next-line no-var
  var __amasoTerminalsCleanupRegistered: boolean | undefined;
}
