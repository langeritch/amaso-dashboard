import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function findClaudeBinary(): string {
  if (process.env.AMASO_CLAUDE_CMD) return process.env.AMASO_CLAUDE_CMD;
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA;
    if (appdata) return `${appdata}\\npm\\claude.cmd`;
  }
  return "claude";
}

function cleanEnv(): NodeJS.ProcessEnv {
  // Scrub Anthropic auth env vars the Next.js server may have inherited,
  // so the CLI uses the user's own stored login — same mitigation as
  // lib/claude.ts.
  const env: NodeJS.ProcessEnv = { ...process.env, FORCE_COLOR: "0" };
  for (const key of Object.keys(env)) {
    if (
      key === "ANTHROPIC_API_KEY" ||
      key === "ANTHROPIC_AUTH_TOKEN" ||
      key === "ANTHROPIC_BASE_URL" ||
      key.startsWith("CLAUDE_CODE_") ||
      key === "CLAUDECODE"
    ) {
      delete env[key];
    }
  }
  return env;
}

export interface SparMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SparToolsConfig {
  /** Short-lived token the MCP server uses to call back into the dashboard. */
  token: string;
  /** Dashboard base URL the MCP server hits, e.g. http://127.0.0.1:3737. */
  dashboardUrl: string;
  /** Explicit list of MCP tools the CLI is allowed to invoke. */
  allowedTools: string[];
}

export interface SparOptions {
  systemPrompt: string;
  heartbeat: string;
  history: SparMessage[];
  /** Pre-formatted user-profile block (facts learned across prior
   *  conversations). Rendered between heartbeat and conversation. Empty
   *  string / undefined skips the section entirely. See
   *  `lib/user-facts.ts:formatFactsForPrompt`. */
  profile?: string;
  /** Model alias accepted by the CLI (e.g. "haiku", "sonnet", "opus"). */
  model?: string;
  /** Signal to cancel the CLI subprocess mid-stream. */
  signal?: AbortSignal;
  /** When set, enable the spar MCP server with this callback config. */
  tools?: SparToolsConfig;
}

function buildPrompt(opts: SparOptions): string {
  const lines: string[] = [];
  lines.push(opts.systemPrompt.trim());
  lines.push("");
  lines.push("=== HEARTBEAT ===");
  lines.push(opts.heartbeat.trim() || "(empty)");
  lines.push("=== END HEARTBEAT ===");
  lines.push("");
  // Only emit the profile block when there's something to say — a bare
  // "=== ABOUT THE USER ===\n(empty)\n===" would just dilute the prompt.
  const profile = opts.profile?.trim() ?? "";
  if (profile) {
    lines.push("=== ABOUT THE USER ===");
    lines.push(
      "Learned across prior conversations. Apply these naturally — don't",
      "announce them, don't list them back at the user unless asked.",
      "Corrections (if present) override any default behaviour.",
    );
    lines.push("");
    lines.push(profile);
    lines.push("=== END ABOUT THE USER ===");
    lines.push("");
  }
  lines.push("Conversation so far:");
  for (const m of opts.history) {
    lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${m.content}`);
  }
  // Prompt the model to produce only the next assistant turn.
  lines.push("");
  lines.push("Reply as Assistant with spoken-style prose only. No role prefix.");
  return lines.join("\n");
}

/** Write a one-shot MCP config file wired to our local spar-mcp-server.
 *  The caller is responsible for deleting it (see the try/finally wrapper). */
function writeMcpConfig(tools: SparToolsConfig): string {
  const scriptPath = path
    .resolve(process.cwd(), "scripts", "spar-mcp-server.mjs")
    .split("\\")
    .join("/");
  // Use the dashboard's own Node binary, not whatever is on the CLI's PATH.
  // Claude CLI bundles its own runtime in some installs and may not have
  // node on PATH at all.
  const nodeBin = process.execPath.split("\\").join("/");
  const cfg = {
    mcpServers: {
      spar: {
        command: nodeBin,
        args: [scriptPath],
        env: {
          AMASO_SPAR_TOKEN: tools.token,
          AMASO_DASHBOARD_URL: tools.dashboardUrl,
        },
      },
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amaso-spar-"));
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify(cfg), "utf8");
  return file;
}

/** Streams text from the local Claude CLI. Each string passed to `onChunk`
 *  is a raw stdout fragment; callers can re-join and re-chunk however they
 *  like. Resolves once the CLI exits; rejects on spawn error or non-zero
 *  exit (but not on user-initiated abort). */
export async function streamFromClaudeCli(
  opts: SparOptions,
  onChunk: (text: string) => void,
): Promise<void> {
  const bin = findClaudeBinary();
  const args: string[] = ["--print"];
  if (opts.model) args.push("--model", opts.model);

  let mcpConfigPath: string | null = null;
  if (opts.tools) {
    mcpConfigPath = writeMcpConfig(opts.tools);
    args.push("--mcp-config", mcpConfigPath);
    // Allow only the spar MCP tools we declared. Claude CLI needs the
    // --permission-mode bump to actually invoke them without a prompt
    // (there's no interactive approver in --print mode).
    const allow = opts.tools.allowedTools.map((n) => `mcp__spar__${n}`);
    args.push("--allowedTools", allow.join(" "));
    args.push("--permission-mode", "acceptEdits");
  }
  const isWin = process.platform === "win32";
  const isCmdFile = /\.(cmd|bat)$/i.test(bin);
  const spawnCmd = isWin && isCmdFile ? "cmd.exe" : bin;
  const spawnArgs = isWin && isCmdFile ? ["/d", "/s", "/c", bin, ...args] : args;

  const proc = spawn(spawnCmd, spawnArgs, {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: cleanEnv(),
  });

  const onAbort = () => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  };
  if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

  proc.stdin?.write(buildPrompt(opts));
  proc.stdin?.end();

  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    onChunk(chunk);
  });

  let stderr = "";
  proc.stderr?.setEncoding("utf8");
  proc.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const cleanupMcpConfig = () => {
    if (!mcpConfigPath) return;
    try {
      const dir = path.dirname(mcpConfigPath);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  return await new Promise<void>((resolve, reject) => {
    proc.on("error", (err) => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      cleanupMcpConfig();
      reject(err);
    });
    proc.on("close", (code) => {
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      cleanupMcpConfig();
      if (opts.signal?.aborted) {
        resolve();
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`claude cli exit=${code}: ${stderr.slice(0, 200)}`));
      }
    });
  });
}

/** One-shot collect — awaits the full CLI output. For the heartbeat cron. */
export async function collectFromClaudeCli(opts: SparOptions): Promise<string> {
  let out = "";
  await streamFromClaudeCli(opts, (chunk) => {
    out += chunk;
  });
  return out;
}
