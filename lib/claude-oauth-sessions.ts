// In-flight OAuth sessions for the Claude account switcher.
//
// `claude auth login` is a paste-the-code device-style flow:
//   1. CLI prints "If the browser didn't open, visit: https://…&state=…"
//   2. User opens the URL, authorizes on Anthropic's site
//   3. Anthropic's callback page (platform.claude.com/oauth/code/callback)
//      shows a one-time code
//   4. User pastes the code into the CLI's "Paste code here >" prompt
//   5. CLI exchanges the code, writes .credentials.json into CLAUDE_CONFIG_DIR
//
// We drive that interactively from the dashboard: spawn the CLI in a PTY
// with a freshly-allocated CLAUDE_CONFIG_DIR, capture the URL from
// stdout, surface it to the UI, accept the code via a follow-up API
// call (which we type into the PTY's stdin), then watch the dir for
// `.credentials.json` to land.
//
// The flow is local to one dashboard process — sessions live in
// memory only. A dashboard restart cancels in-flight authorisations
// (the user can simply click "Add account" again).

import { spawn as ptySpawn, type IPty } from "node-pty";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn as childSpawn } from "node:child_process";

export type OAuthStatus =
  | "spawning"
  | "awaiting_url"
  | "awaiting_code"
  | "exchanging"
  | "done"
  | "failed"
  | "cancelled";

export interface OAuthSessionView {
  id: string;
  status: OAuthStatus;
  authUrl: string | null;
  /** Last ~80 chars of CLI output — surfaced to the UI for diagnosis
   *  when something looks stuck. Trimmed. */
  recentOutput: string;
  error: string | null;
  /** Populated once status === "done". The new account's id matches
   *  the OAuth session id (they're the same uuid — the temp dir IS
   *  the account's permanent dir). */
  accountId: string | null;
  startedAt: number;
}

interface OAuthSession {
  id: string;
  proc: IPty;
  configDir: string;
  status: OAuthStatus;
  authUrl: string | null;
  output: string;
  error: string | null;
  accountId: string | null;
  startedAt: number;
  /** Cleared on cancel / completion. */
  pollTimer: NodeJS.Timeout | null;
  /** Hard-stop timeout so a forgotten session doesn't leak forever. */
  watchdog: NodeJS.Timeout | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __amasoClaudeOAuthSessions: Map<string, OAuthSession> | undefined;
}

function sessions(): Map<string, OAuthSession> {
  if (!globalThis.__amasoClaudeOAuthSessions) {
    globalThis.__amasoClaudeOAuthSessions = new Map();
  }
  return globalThis.__amasoClaudeOAuthSessions;
}

const SESSION_TIMEOUT_MS = 10 * 60_000;
const POLL_INTERVAL_MS = 750;
const MAX_OUTPUT_BYTES = 8_192;

function genId(): string {
  return Math.random().toString(16).slice(2, 10);
}

function accountsRoot(): string {
  return path.join(os.homedir(), ".amaso", "claude-accounts").replace(/\\/g, "/");
}

function findClaudeBinary(): string {
  if (process.env.AMASO_CLAUDE_CMD) return process.env.AMASO_CLAUDE_CMD;
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) {
      return path
        .join(appdata, "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
        .split("\\")
        .join("/");
    }
  }
  return "claude";
}

const URL_REGEX =
  /https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s\x1b\x07]+/;
// Strip ANSI escape sequences before URL matching — the CLI emits
// "\x1b[0K" (clear-line) and similar as part of its TUI redraw, and
// without scrubbing those sequences end up captured inside the URL
// query string and break the redirect on the user's side.
// eslint-disable-next-line no-control-regex
const ANSI_STRIP_RX = /\x1B(?:\][^\x07]*\x07|[PX^_][^\x1B]*\x1B\\|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

function appendOutput(s: OAuthSession, chunk: string): void {
  s.output += chunk;
  if (s.output.length > MAX_OUTPUT_BYTES) {
    s.output = s.output.slice(-MAX_OUTPUT_BYTES);
  }
}

function toView(s: OAuthSession): OAuthSessionView {
  return {
    id: s.id,
    status: s.status,
    authUrl: s.authUrl,
    recentOutput: s.output.slice(-200).trim(),
    error: s.error,
    accountId: s.accountId,
    startedAt: s.startedAt,
  };
}

/** Best-effort: open the URL in the operator's default browser. Only
 *  meaningful when the dashboard runs in their interactive logon
 *  session (the common case for a single-user local dashboard). The
 *  UI also shows the URL as a clickable link, which is what
 *  cross-device users (phone → tunnel) actually use. */
function tryOpenBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      // `cmd /c start "" "<url>"` — the empty title prevents start
      // from interpreting the URL as a window title.
      childSpawn("cmd.exe", ["/c", "start", "", url], {
        windowsHide: true,
        detached: true,
        stdio: "ignore",
      }).unref();
    } else if (process.platform === "darwin") {
      childSpawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      childSpawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    /* best-effort — UI link is the source of truth */
  }
}

interface FinalizeFn {
  (configDir: string, suggestedName: string): { id: string };
}

/** Start a fresh OAuth flow. Returns a session view immediately;
 *  status starts as "spawning" and the URL becomes available within
 *  a second once the CLI prints it. */
export function startOAuthSession(opts: {
  finalize: FinalizeFn;
  /** Optional name for the resulting account. Defaults to a
   *  timestamped placeholder; the user can rename later. */
  suggestedName?: string;
}): OAuthSessionView {
  const id = genId();
  const configDir = path.join(accountsRoot(), id).replace(/\\/g, "/");
  fs.mkdirSync(configDir, { recursive: true });

  const claude = findClaudeBinary();
  // Force --claudeai (the default, but explicit so a future flag flip
  // doesn't accidentally route us through the API-billing path). The
  // CLI prints the OAuth URL to stdout and waits on stdin for the code
  // — both flow through the PTY.
  // Scrub any leaked auth so the CLI doesn't short-circuit to an
  // already-active credential and skip the login prompt. Build the
  // env as a string-only object (node-pty rejects undefined values).
  const env: { [k: string]: string } = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (
      k === "ANTHROPIC_API_KEY" ||
      k === "ANTHROPIC_AUTH_TOKEN" ||
      k === "ANTHROPIC_BASE_URL" ||
      k === "CLAUDECODE" ||
      k.startsWith("CLAUDE_CODE_")
    ) {
      continue;
    }
    env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  env.TERM = "xterm-256color";
  env.FORCE_COLOR = "0";

  // Wide PTY so the OAuth URL doesn't wrap. Anthropic's auth URL with
  // PKCE state lands around 470 chars and the CLI honours the terminal
  // width when printing — at 100 cols the URL ends up split across two
  // lines with a literal CRLF baked into the middle, which then defeats
  // the "no whitespace" gate in URL_REGEX. 9999 cols is far past any
  // realistic URL length and costs nothing.
  const proc = ptySpawn(claude, ["auth", "login", "--claudeai"], {
    name: "xterm-256color",
    cols: 9999,
    rows: 30,
    cwd: os.homedir().split("\\").join("/"),
    env,
    useConpty: process.platform !== "win32",
  });

  const session: OAuthSession = {
    id,
    proc,
    configDir,
    status: "spawning",
    authUrl: null,
    output: "",
    error: null,
    accountId: null,
    startedAt: Date.now(),
    pollTimer: null,
    watchdog: null,
  };
  sessions().set(id, session);

  proc.onData((data) => {
    appendOutput(session, data);
    if (!session.authUrl) {
      // Wait for the URL line to be fully delivered. The CLI writes
      // the URL across multiple PTY chunks and intersperses ANSI
      // redraw sequences mid-stream, so a naive capture grabbed a
      // truncated URL. Two completeness gates:
      //   1. ANSI stripped — escapes don't leak into the captured URL.
      //   2. The URL must contain `&state=` (Anthropic's OAuth format
      //      always puts state last) AND have a newline somewhere
      //      after it — that combination only holds once the full URL
      //      line has been delivered.
      const stripped = session.output.replace(ANSI_STRIP_RX, "");
      const m = URL_REGEX.exec(stripped);
      if (m && m[0].includes("&state=")) {
        const after = stripped.slice(m.index + m[0].length);
        if (/[\r\n]/.test(after)) {
          session.authUrl = m[0];
          session.status = "awaiting_code";
          tryOpenBrowser(session.authUrl);
          console.log(
            `[oauth] session=${id} captured authUrl (len=${m[0].length}), awaiting code`,
          );
        }
      }
    }
    // Surface explicit failure cues from the CLI (typo'd code, expired
    // code, network error). The CLI prints them on the same stdout.
    if (
      session.status === "awaiting_code" &&
      /(?:invalid|expired|incorrect|failed)/i.test(data)
    ) {
      // Don't move into "failed" yet — the CLI re-prompts on bad
      // code. The UI shows recentOutput so the user sees the CLI's
      // own error text without us having to translate it.
    }
  });

  proc.onExit(({ exitCode }) => {
    if (session.status === "done" || session.status === "cancelled") return;
    // The CLI may exit cleanly after writing credentials — we may
    // already be polling for them. Give the poller a moment to spot
    // the file before declaring failure. If `.credentials.json` shows
    // up, the poller flips to "done" itself.
    setTimeout(() => {
      if (session.status === "done" || session.status === "cancelled") return;
      const credPath = path.join(configDir, ".credentials.json");
      if (fs.existsSync(credPath)) return; // poller will catch it
      session.status = "failed";
      session.error = `claude exited (code=${exitCode}) before writing credentials`;
      console.warn(`[oauth] session=${id} ${session.error}`);
      cleanupSession(id, false);
    }, 1_500);
  });

  // Watch the temp dir for the credentials file. Avoids depending on
  // a clean PTY exit signal — on Windows node-pty's exit timing can
  // race the file write.
  const credPath = path.join(configDir, ".credentials.json");
  session.pollTimer = setInterval(() => {
    if (session.status === "done" || session.status === "cancelled" || session.status === "failed") {
      if (session.pollTimer) clearInterval(session.pollTimer);
      session.pollTimer = null;
      return;
    }
    if (!fs.existsSync(credPath)) return;
    // Credentials landed. Pause polling and finalise.
    if (session.pollTimer) clearInterval(session.pollTimer);
    session.pollTimer = null;
    session.status = "exchanging";
    try {
      const suggested =
        opts.suggestedName?.trim() ||
        `Account ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      const account = opts.finalize(configDir, suggested);
      session.accountId = account.id;
      session.status = "done";
      console.log(`[oauth] session=${id} → account=${account.id}`);
    } catch (err) {
      session.status = "failed";
      session.error = err instanceof Error ? err.message : String(err);
      console.warn(`[oauth] session=${id} finalize threw:`, err);
    }
    // Kill any lingering CLI process; credentials are already on disk.
    try {
      session.proc.kill();
    } catch {
      /* already dead */
    }
  }, POLL_INTERVAL_MS);

  // Hard-stop: forgotten sessions get cleaned up after 10 minutes.
  session.watchdog = setTimeout(() => {
    if (session.status === "done") return;
    cancelOAuthSession(id);
  }, SESSION_TIMEOUT_MS);

  return toView(session);
}

export function getOAuthSession(id: string): OAuthSessionView | null {
  const s = sessions().get(id);
  if (!s) return null;
  return toView(s);
}

/** Type the user-pasted code into the CLI's stdin. The CLI is sitting
 *  at "Paste code here >" — we send the code followed by a CR so the
 *  paste handler treats it as submit. */
export function submitOAuthCode(id: string, code: string): OAuthSessionView | null {
  const s = sessions().get(id);
  if (!s) return null;
  if (s.status === "done" || s.status === "cancelled" || s.status === "failed") {
    return toView(s);
  }
  const trimmed = code.trim();
  if (!trimmed) {
    s.error = "empty code";
    return toView(s);
  }
  try {
    s.proc.write(trimmed + "\r");
    s.status = "exchanging";
    console.log(`[oauth] session=${id} code submitted, exchanging`);
  } catch (err) {
    s.status = "failed";
    s.error = err instanceof Error ? err.message : String(err);
  }
  return toView(s);
}

export function cancelOAuthSession(id: string): boolean {
  const s = sessions().get(id);
  if (!s) return false;
  if (s.status === "done") return true;
  s.status = "cancelled";
  cleanupSession(id, true);
  return true;
}

function cleanupSession(id: string, removeDir: boolean): void {
  const s = sessions().get(id);
  if (!s) return;
  if (s.pollTimer) {
    clearInterval(s.pollTimer);
    s.pollTimer = null;
  }
  if (s.watchdog) {
    clearTimeout(s.watchdog);
    s.watchdog = null;
  }
  try {
    s.proc.kill();
  } catch {
    /* ignore */
  }
  // Drop the temp dir IF the session never produced an account. When
  // status === "done", the dir IS the account's credentialsDir and
  // must survive.
  if (removeDir && s.status !== "done" && s.configDir.startsWith(accountsRoot())) {
    try {
      fs.rmSync(s.configDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  // Keep the session entry for a minute so a final poll from the UI
  // can read the terminal status before it disappears.
  setTimeout(() => sessions().delete(id), 60_000).unref();
}
