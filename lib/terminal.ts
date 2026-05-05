// Per-project Claude CLI terminal sessions.
//
// Stage 1 of multi-terminal support (remark #285): the registry is now
// keyed by sessionId, and sessions carry a projectId attribute, so a
// single project can in principle host multiple concurrent sessions.
// In practice every existing caller still passes only projectId, in
// which case sessionId === projectId — bit-for-bit identical
// behaviour to the pre-refactor code. Stages 2+ will introduce real
// session-aware spawn paths and UI.
//
// Output is broadcast to every WebSocket client subscribed to that
// session's id, so multiple browser tabs / devices see the same live
// stream. Input is accepted from any connected client — the server
// doesn't arbitrate.

import { spawn as ptySpawn, type IPty } from "node-pty";
import { EventEmitter } from "node:events";
import process from "node:process";
import { spawnEnvOverrides } from "./claude-accounts";
import { getProject } from "./config";

export interface TerminalStatus {
  projectId: string;
  sessionId: string;
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
  sessionId: string;
  projectId: string;
  proc: IPty;
  startedAt: number;
  cols: number;
  rows: number;
  /** Bounded ring of recent output bytes for replay on reconnect. */
  scrollback: string;
  emitter: EventEmitter;
}

// Per-session ring buffer. 1 MB holds ~10k lines of dense Claude Code
// output, enough that spar can look back across a long working session
// without losing early context. Override via AMASO_SCROLLBACK_BYTES.
const MAX_SCROLLBACK_BYTES = Number(process.env.AMASO_SCROLLBACK_BYTES ?? 1_000_000);

declare global {
  // eslint-disable-next-line no-var
  var __amasoTerminals: Map<string, Session> | undefined;
}

function registry(): Map<string, Session> {
  if (!globalThis.__amasoTerminals) globalThis.__amasoTerminals = new Map();
  return globalThis.__amasoTerminals;
}

/** Resolve the lookup key. When the caller didn't supply a sessionId
 *  (every caller in Stage 1), fall back to projectId so the existing
 *  one-session-per-project behaviour is preserved. */
function resolveSessionId(projectId: string, sessionId?: string): string {
  return sessionId ?? projectId;
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
  // Per-account routing — when the operator has picked an account in
  // /settings, point the CLI at that account's credentials dir so a
  // freshly spawned `claude` reads the right .credentials.json. No-op
  // when the feature has never been used.
  Object.assign(env, spawnEnvOverrides());
  return env;
}

export function getSession(projectId: string, sessionId?: string): Session | null {
  return registry().get(resolveSessionId(projectId, sessionId)) ?? null;
}

export function getStatus(projectId: string, sessionId?: string): TerminalStatus {
  const sid = resolveSessionId(projectId, sessionId);
  const s = registry().get(sid);
  const project = getProject(projectId);
  if (!s) {
    return {
      projectId,
      sessionId: sid,
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
    projectId: s.projectId,
    sessionId: s.sessionId,
    running: true,
    pid: s.proc.pid ?? null,
    cwd: project?.path ?? null,
    startedAt: s.startedAt,
    cols: s.cols,
    rows: s.rows,
    scrollback: s.scrollback,
  };
}

export function start(
  projectId: string,
  cols = 100,
  rows = 30,
  sessionId?: string,
): Session {
  const sid = resolveSessionId(projectId, sessionId);
  const reg = registry();
  const existing = reg.get(sid);
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

  // Claim the registry slot before spawning the PTY. Today the path
  // from `reg.get` above to `ptySpawn` below is fully synchronous, so
  // two concurrent callers can't truly interleave — but the sentinel
  // is what makes that property robust to future changes (e.g. an
  // await sneaking into env prep). A concurrent start() for the same
  // sid will see this placeholder on its `reg.get` check and return
  // it, never double-spawning. proc is filled in synchronously below
  // before this function returns.
  const session: Session = {
    sessionId: sid,
    projectId,
    proc: null as unknown as IPty,
    startedAt: Date.now(),
    cols,
    rows,
    scrollback: "",
    emitter: new EventEmitter(),
  };
  // Same rationale as pty-client.ts: the dashboard fans out per-tab
  // subscriptions plus crons (autopilot, heartbeat, worker-status,
  // wrapper-level idle observer), easily cresting EventEmitter's
  // 10-listener default warning. Disable the cap.
  session.emitter.setMaxListeners(0);
  reg.set(sid, session);

  // Interactive Claude (no --print). Forward slashes in paths, and on
  // Windows we force `useConpty: false` → winpty backend. This matters
  // because Claude itself uses node-pty internally (for its own tool
  // invocations), and ConPTY can't be nested — the inner agent tries to
  // AttachConsole and the whole process dies with exit=1 before we see
  // any output. winpty has no such limitation.
  let proc: IPty;
  try {
    proc = ptySpawn(exe, sessionArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: project.path.split("\\").join("/"),
      env: cleanEnv() as { [key: string]: string },
      useConpty: process.platform !== "win32",
    });
  } catch (err) {
    // Spawn failed — release the slot so a retry can succeed.
    reg.delete(sid);
    throw err;
  }
  session.proc = proc;

  proc.onData((data) => {
    // Append to scrollback, trim if over budget. Idle detection lives
    // in lib/terminal-backend.ts now (subscribed via the wrapper) so
    // both backends produce the same dispatch-completed signal.
    session.scrollback += data;
    if (session.scrollback.length > MAX_SCROLLBACK_BYTES) {
      session.scrollback = session.scrollback.slice(
        session.scrollback.length - MAX_SCROLLBACK_BYTES,
      );
    }
    session.emitter.emit("data", data);
  });

  proc.onExit(({ exitCode, signal }) => {
    session.emitter.emit("exit", { exitCode, signal });
    reg.delete(sid);
  });

  return session;
}

export function write(
  projectId: string,
  data: string,
  // notifyUserId is accepted for parity with the wrapper signature but
  // ignored here — idle detection is now driven from terminal-backend.
  _notifyUserId: number | null = null,
  sessionId?: string,
): boolean {
  const s = registry().get(resolveSessionId(projectId, sessionId));
  if (!s) return false;
  s.proc.write(data);
  return true;
}

export function resize(
  projectId: string,
  cols: number,
  rows: number,
  sessionId?: string,
): boolean {
  const s = registry().get(resolveSessionId(projectId, sessionId));
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

export function stop(projectId: string, sessionId?: string): boolean {
  const sid = resolveSessionId(projectId, sessionId);
  const s = registry().get(sid);
  if (!s) return false;
  try {
    s.proc.kill();
  } catch {
    /* already dead */
  }
  registry().delete(sid);
  return true;
}

export function subscribe(
  projectId: string,
  onData: (chunk: string) => void,
  onExit: (payload: { exitCode: number; signal: number | undefined }) => void,
  sessionId?: string,
): () => void {
  const s = registry().get(resolveSessionId(projectId, sessionId));
  if (!s) return () => {};
  s.emitter.on("data", onData);
  s.emitter.on("exit", onExit);
  return () => {
    s.emitter.off("data", onData);
    s.emitter.off("exit", onExit);
  };
}

/** Every live session for the given project. Returns a fresh array;
 *  callers can mutate it freely. Stage 1 always returns 0 or 1
 *  entries because we still default sessionId to projectId on every
 *  spawn. Stage 2 flips on real multi-session spawns. */
export function listSessionsForProject(projectId: string): Session[] {
  const out: Session[] = [];
  for (const s of registry().values()) {
    if (s.projectId === projectId) out.push(s);
  }
  return out;
}

// Best-effort cleanup on dashboard shutdown. Iterates by sessionId
// (the registry's key) so multi-session projects clean up cleanly
// once Stage 2 enables them.
if (!globalThis.__amasoTerminalsCleanupRegistered) {
  globalThis.__amasoTerminalsCleanupRegistered = true as never;
  const killAll = () => {
    for (const sid of Array.from(registry().keys())) {
      const s = registry().get(sid);
      if (!s) continue;
      stop(s.projectId, sid);
    }
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
