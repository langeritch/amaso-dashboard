// Spar v2 session — Hermes Agent running inside WSL2 Ubuntu, under tmux.
//
// Rationale (as of 2026-04-29):
//   • v1 spar (/spar) shells out to claude.cmd per HTTP request, gets a
//     single response, plays it back. Stateless from the CLI's view.
//   • v2 spar (/spar2) keeps a long-lived `hermes` process inside a tmux
//     session in WSL2 — the same session survives dashboard restarts so
//     the operator's conversation continues across page reloads, deploys,
//     and watchdog repairs. tmux is what makes that survival possible.
//   • Auth: Hermes uses an Anthropic OAuth token derived from the
//     `claude setup-token` long-lived flow (Claude Code's sanctioned
//     OAuth client). The token is stored in /root/.hermes/auth.json
//     under credential_pool.anthropic. The Hermes-PKCE OAuth flow
//     (its own client_id) hit Anthropic rate_limit_error on every
//     call — the long-lived setup-token has the broader scope.
//
// Architecture mirrors lib/terminal.ts (per-project Claude CLI) but with
// two simplifications:
//   • Singleton — one spar2 session for the whole dashboard (this is "your
//     sparring partner", not a per-codebase tool).
//   • Single broadcast channel — every connected /spar2 tab sees the same
//     bytes. No per-channel filtering.
//
// Why we don't reuse lib/terminal.ts directly: terminal.ts spawns Windows
// claude.cmd and is keyed by projectId; refactoring it to also serve a
// WSL+tmux singleton would have broken the working /projects/[id] page.
// v2 is intentionally additive.

import { spawn as ptySpawn, type IPty } from "node-pty";
import { EventEmitter } from "node:events";

// Tmux session name. Stable across dashboard restarts so an attached
// `claude` process persists. Manually inspect with:
//   wsl -d Ubuntu -u root -- tmux ls
//   wsl -d Ubuntu -u root -- tmux attach -t amaso-spar2
const TMUX_SESSION = "amaso-spar2";

// Scrollback ring buffer. Same size as lib/terminal.ts so a reconnecting
// /spar2 tab can replay enough context to be useful. 1 MB ≈ 10k lines.
const MAX_SCROLLBACK_BYTES = Number(process.env.AMASO_SPAR2_SCROLLBACK_BYTES ?? 1_000_000);

interface Spar2Session {
  proc: IPty;
  startedAt: number;
  cols: number;
  rows: number;
  /** Bounded ring of recent output bytes for replay on reconnect. */
  scrollback: string;
  emitter: EventEmitter;
}

declare global {
  // eslint-disable-next-line no-var
  var __amasoSpar2Session: Spar2Session | null | undefined;
}

function getSession(): Spar2Session | null {
  return globalThis.__amasoSpar2Session ?? null;
}

function setSession(s: Spar2Session | null) {
  globalThis.__amasoSpar2Session = s;
}

export interface Spar2Status {
  running: boolean;
  pid: number | null;
  startedAt: number | null;
  cols: number;
  rows: number;
  /** Snapshot of recent output so a reconnecting client replays history. */
  scrollback: string;
}

export function status(): Spar2Status {
  const s = getSession();
  if (!s) {
    return {
      running: false,
      pid: null,
      startedAt: null,
      cols: 80,
      rows: 24,
      scrollback: "",
    };
  }
  return {
    running: true,
    pid: s.proc.pid,
    startedAt: s.startedAt,
    cols: s.cols,
    rows: s.rows,
    scrollback: s.scrollback,
  };
}

/**
 * Subscribe to stdout from the running session. Returns an unsubscribe.
 * The current scrollback is NOT replayed — caller already gets it via
 * `status()` and can prime the terminal before subscribing.
 */
export function subscribe(onData: (chunk: string) => void): () => void {
  const s = getSession();
  if (!s) return () => {};
  s.emitter.on("data", onData);
  return () => {
    s.emitter.off("data", onData);
  };
}

/** Subscribe to exit events (process death). */
export function subscribeExit(
  onExit: (info: { exitCode: number | null; signal: number | null }) => void,
): () => void {
  const s = getSession();
  if (!s) return () => {};
  s.emitter.on("exit", onExit);
  return () => {
    s.emitter.off("exit", onExit);
  };
}

export interface StartOptions {
  cols?: number;
  rows?: number;
}

/** Start (or attach to) the spar2 tmux session inside WSL. Idempotent. */
export function start(opts: StartOptions = {}): Spar2Status {
  const cols = Math.max(20, Math.min(400, opts.cols ?? 100));
  const rows = Math.max(5, Math.min(200, opts.rows ?? 30));
  const existing = getSession();
  if (existing) {
    // Resize to whatever the connecting client requested. Multiple
    // browsers can attach concurrently; the most recent attach wins
    // the size negotiation. xterm's FitAddon will run in each tab so
    // the layout stays usable per-tab even if cols differ.
    if (existing.cols !== cols || existing.rows !== rows) {
      try {
        existing.proc.resize(cols, rows);
        existing.cols = cols;
        existing.rows = rows;
      } catch {
        /* PTY may have died — fall through to respawn below */
      }
    }
    if (existing.proc.pid) return status();
    // Process is gone but we still hold a reference — clean up and respawn.
    setSession(null);
  }

  // Spawn `wsl.exe` into Ubuntu as root. The tmux invocation uses
  // `new-session -As <name>`:
  //   • -A   attach if a session by that name exists (survives across
  //          dashboard restarts — the whole point of this design)
  //   • -s   set the name to TMUX_SESSION
  //   • <cmd> the command tmux runs IF it has to create the session.
  //          On re-attach, tmux ignores this argument.
  //
  // `bash -lc` so /etc/profile + ~/.profile load (PATH for ~/.local/bin
  // where the Hermes installer drops the `hermes` shim).
  //
  // We pass the command as ONE bash string to keep argv quoting simple
  // on the Windows side; tmux's argv-parsing happens inside Linux.
  //
  // `hermes` with no subcommand opens the interactive TUI. With a valid
  // Anthropic credential in /root/.hermes/auth.json (added via
  // `hermes auth add anthropic --type oauth --api-key sk-ant-oat01-...`)
  // and Opus selected as the default model, this is the operator's
  // sparring partner channel.
  const tmuxCmd = `tmux new-session -As ${TMUX_SESSION} 'hermes'`;
  const proc = ptySpawn(
    "wsl.exe",
    ["-d", "Ubuntu", "-u", "root", "--", "bash", "-lc", tmuxCmd],
    {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: process.env as Record<string, string>,
    },
  );

  const session: Spar2Session = {
    proc,
    startedAt: Date.now(),
    cols,
    rows,
    scrollback: "",
    emitter: new EventEmitter(),
  };
  // EventEmitter throws by default after 10 listeners; we expect dozens
  // of WS clients across dashboard reloads. 0 disables the warning.
  session.emitter.setMaxListeners(0);

  proc.onData((data) => {
    session.scrollback += data;
    if (session.scrollback.length > MAX_SCROLLBACK_BYTES) {
      // Trim the oldest 25% — cheaper than slicing every byte.
      session.scrollback = session.scrollback.slice(
        session.scrollback.length - Math.floor(MAX_SCROLLBACK_BYTES * 0.75),
      );
    }
    session.emitter.emit("data", data);
  });

  proc.onExit(({ exitCode, signal }) => {
    session.emitter.emit("exit", { exitCode, signal: signal ?? null });
    if (getSession() === session) setSession(null);
  });

  setSession(session);
  return status();
}

/** Send keystrokes/bytes into the PTY (and through to claude inside tmux). */
export function write(data: string): boolean {
  const s = getSession();
  if (!s) return false;
  try {
    s.proc.write(data);
    return true;
  } catch {
    return false;
  }
}

/** Resize the PTY. Negotiated per-attach in start(); call this on tab resize too. */
export function resize(cols: number, rows: number): boolean {
  const s = getSession();
  if (!s) return false;
  try {
    s.proc.resize(
      Math.max(20, Math.min(400, cols)),
      Math.max(5, Math.min(200, rows)),
    );
    s.cols = cols;
    s.rows = rows;
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the local PTY view. Does NOT kill the tmux session inside WSL —
 * `claude` keeps running, and a fresh start() will re-attach. Use
 * `killTmux()` if you want a hard wipe.
 */
export function detach(): void {
  const s = getSession();
  if (!s) return;
  try {
    // tmux's "detach client" prefix is C-b d. The PTY is the lone client
    // here, so this leaves the server-side session running and ends the
    // wsl.exe process from the dashboard's view.
    s.proc.write("\x02d");
  } catch {
    /* ignore */
  }
  // Give tmux a beat to flush the detach, then kill the wrapper.
  setTimeout(() => {
    try {
      s.proc.kill();
    } catch {
      /* already dead */
    }
  }, 100);
}

/**
 * Hard-stop: kill the tmux session inside WSL so claude exits and the
 * conversation history goes with it. Operator-triggered only.
 */
export async function killTmux(): Promise<void> {
  const s = getSession();
  // Kill the in-process PTY first so we don't double-emit exit.
  if (s) {
    try {
      s.proc.kill();
    } catch {
      /* ignore */
    }
    setSession(null);
  }
  // Then kill the named tmux session inside WSL via a one-shot wsl call.
  // We don't reuse the long-lived PTY for this — that PTY is gone.
  await new Promise<void>((resolve) => {
    const killer = ptySpawn(
      "wsl.exe",
      [
        "-d",
        "Ubuntu",
        "-u",
        "root",
        "--",
        "bash",
        "-lc",
        `tmux kill-session -t ${TMUX_SESSION} 2>/dev/null || true`,
      ],
      { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> },
    );
    killer.onExit(() => resolve());
  });
}
