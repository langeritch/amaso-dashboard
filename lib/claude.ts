// Runs the Claude CLI in a project folder and streams its stdout/stderr.
// Keeps active runs keyed by project so the UI can poll or stream them.
//
// Safety fences:
//  - Only runs in the project's own directory (never the dashboard repo).
//  - No git access: our prompt tells Claude not to commit/push, AND we
//    add --disallowedTools so the Bash/git path is blocked. Everything
//    the fix needs (read, edit, write) stays file-local.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import process from "node:process";

export type ClaudeRunState = "running" | "completed" | "failed" | "cancelled";

export interface ClaudeRun {
  id: string;
  projectId: string;
  remarkIds: number[];
  state: ClaudeRunState;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  /** Ring buffer of stdout + stderr lines, tagged with origin. */
  log: Array<{ kind: "out" | "err" | "info"; line: string; ts: number }>;
  emitter: EventEmitter;
  proc: ChildProcess | null;
}

const MAX_LOG = 2000;

declare global {
  // eslint-disable-next-line no-var
  var __amasoClaude: Map<string, ClaudeRun> | undefined;
}
function registry(): Map<string, ClaudeRun> {
  if (!globalThis.__amasoClaude) globalThis.__amasoClaude = new Map();
  return globalThis.__amasoClaude;
}

function findClaudeBinary(): string {
  // 1. Explicit env override
  if (process.env.AMASO_CLAUDE_CMD) return process.env.AMASO_CLAUDE_CMD;
  // 2. Standard npm global location on Windows
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) {
      const cmd = `${appdata}\\npm\\claude.cmd`;
      // Can't easily check existsSync without importing fs — just trust it;
      // the spawn will fail cleanly with ENOENT if wrong.
      return cmd;
    }
  }
  // 3. macOS / Linux: rely on PATH
  return "claude";
}

export function getRun(projectId: string): ClaudeRun | undefined {
  // One active run per project at a time; return the newest entry.
  const reg = registry();
  for (const run of [...reg.values()].reverse()) {
    if (run.projectId === projectId) return run;
  }
  return undefined;
}

export function startRun(
  projectId: string,
  projectRoot: string,
  prompt: string,
  remarkIds: number[],
): ClaudeRun {
  const existing = getRun(projectId);
  if (existing && existing.state === "running") {
    throw new Error("already_running");
  }

  const id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const emitter = new EventEmitter();
  const run: ClaudeRun = {
    id,
    projectId,
    remarkIds,
    state: "running",
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    log: [],
    emitter,
    proc: null,
  };
  registry().set(id, run);

  const bin = findClaudeBinary();
  // Non-interactive Claude CLI flags:
  //   --print               single-shot response, no interactive UI
  //   --permission-mode     skip file-edit confirmations
  //   --disallowedTools     belt-and-braces against git/gh commits + push
  const claudeArgs = [
    "--print",
    "--permission-mode",
    "acceptEdits",
    "--disallowedTools",
    "Bash(git:*) Bash(gh:*)",
  ];

  // On Windows, `claude` is a `.cmd` wrapper. Three traps to avoid:
  //   1. `spawn(.cmd, …, { shell: false })`           → EINVAL
  //   2. `spawn(.cmd, …, { shell: true })`            → flashes a cmd console
  //   3. `spawn('cmd.exe', ['/c', '.cmd'])` with `windowsHide` but without
  //      a detached job object → sometimes still pops a window
  //
  // Solution: explicitly invoke cmd.exe with `/d /s /c` (no AutoRun, treat
  // first/last quote as literal) and `windowsHide: true`, which together
  // are enough for the launcher to stay hidden on modern Windows builds.
  const isWin = process.platform === "win32";
  const isCmdFile = /\.(cmd|bat)$/i.test(bin);
  const spawnCmd = isWin && isCmdFile ? "cmd.exe" : bin;
  const spawnArgs =
    isWin && isCmdFile
      ? ["/d", "/s", "/c", bin, ...claudeArgs]
      : claudeArgs;

  // Scrub any Anthropic auth-related env vars that may have leaked in from
  // the shell that started the dashboard (e.g. a parent Claude Code session).
  // Without this, Claude CLI prefers ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL /
  // CLAUDE_CODE_OAUTH_TOKEN from the parent env over the user's own stored
  // login, and silently uses the wrong identity.
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
  for (const key of Object.keys(cleanEnv)) {
    if (
      key === "ANTHROPIC_API_KEY" ||
      key === "ANTHROPIC_AUTH_TOKEN" ||
      key === "ANTHROPIC_BASE_URL" ||
      key.startsWith("CLAUDE_CODE_") ||
      key === "CLAUDECODE"
    ) {
      delete cleanEnv[key];
    }
  }

  const proc = spawn(spawnCmd, spawnArgs, {
    cwd: projectRoot,
    shell: false,
    windowsHide: true,
    detached: false,
    stdio: ["pipe", "pipe", "pipe"],
    env: cleanEnv,
  });
  run.proc = proc;

  proc.stdin?.write(prompt);
  proc.stdin?.end();

  function push(kind: "out" | "err" | "info", line: string) {
    const entry = { kind, line, ts: Date.now() };
    run.log.push(entry);
    if (run.log.length > MAX_LOG) run.log.splice(0, run.log.length - MAX_LOG);
    emitter.emit("log", entry);
  }

  push("info", `→ Starting Claude in ${projectRoot}`);
  push("info", `→ ${remarkIds.length} remark(s) in the prompt`);

  const linewise = (kind: "out" | "err") => {
    let carry = "";
    return (chunk: Buffer) => {
      carry += chunk.toString("utf8");
      const parts = carry.split(/\r?\n/);
      carry = parts.pop() ?? "";
      for (const p of parts) push(kind, p);
    };
  };

  proc.stdout?.on("data", linewise("out"));
  proc.stderr?.on("data", linewise("err"));

  proc.on("error", (err) => {
    push("err", `spawn error: ${err.message}`);
    run.state = "failed";
    run.endedAt = Date.now();
    emitter.emit("end", run);
  });

  proc.on("exit", (code, signal) => {
    run.exitCode = code;
    run.endedAt = Date.now();
    if (run.state === "cancelled") {
      // already set
    } else if (code === 0) {
      run.state = "completed";
      push("info", "✓ Claude finished successfully");
    } else {
      run.state = "failed";
      push("err", `Claude exited with code ${code ?? "?"} signal ${signal ?? "?"}`);
    }
    emitter.emit("end", run);
  });

  return run;
}

export function cancelRun(runId: string): boolean {
  const run = registry().get(runId);
  if (!run || run.state !== "running") return false;
  run.state = "cancelled";
  if (run.proc && run.proc.exitCode === null) {
    if (process.platform === "win32" && run.proc.pid) {
      spawn("taskkill", ["/pid", String(run.proc.pid), "/T", "/F"], {
        shell: false,
        stdio: "ignore",
      });
    } else {
      run.proc.kill("SIGTERM");
    }
  }
  return true;
}

export function getRunById(runId: string): ClaudeRun | undefined {
  return registry().get(runId);
}
