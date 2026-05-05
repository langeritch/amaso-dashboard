import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnEnvOverrides } from "./claude-accounts";

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
  // Route through the operator's active Claude account. No-op if no
  // account is configured — preserves the legacy ~/.claude default.
  Object.assign(env, spawnEnvOverrides());
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
  /** Spar MCP tool names (prefix `mcp__spar__` is added internally). */
  allowedTools: string[];
  /** Playwright MCP tool names (prefix `mcp__playwright__` added
   *  internally). When undefined / empty, the playwright server is
   *  not started and no browser tools are exposed to the model. */
  allowedPlaywrightTools?: string[];
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
  /** Hand-curated per-user persona file (markdown). Personalises tone,
   *  language, and behavioural rules for the calling user. Empty /
   *  undefined skips the section. Loaded via `lib/user-profile.ts`. */
  userProfile?: string;
  /** Pre-formatted skills block (matched workflow playbooks from
   *  data/spar-skills/*.md). Rendered between user profile and graph
   *  facts. Empty / undefined skips the section. See `lib/spar-skills.ts`. */
  skills?: string;
  /** Pre-formatted brain block (structured long-term memory: soul,
   *  profile, goals, projects, decisions, lessons, people, timeline,
   *  …). Rendered immediately after the system prompt so it shapes
   *  every reply. Empty / undefined skips the section. See
   *  `lib/spar-brain.ts`. */
  brain?: string;
  /** Model alias accepted by the CLI (e.g. "haiku", "sonnet", "opus"). */
  model?: string;
  /** Signal to cancel the CLI subprocess mid-stream. */
  signal?: AbortSignal;
  /** Files attached to this turn. Their absolute paths are appended to
   *  the prompt so the model can read them off disk via its normal file
   *  tools — no base64-over-stdin shenanigans. */
  images?: Array<{ path: string; type: string; name: string }>;
  /** When set, enable the spar MCP server with this callback config. */
  tools?: SparToolsConfig;
  /** Cap on agent turns inside the CLI. One "turn" is one assistant
   *  message (which may include tool_use blocks). When tools are
   *  enabled the CLI loops tool_use → tool_result → next assistant
   *  message until the model emits a final text-only turn or this
   *  limit is hit. Default: 10 when tools are enabled, 1 otherwise
   *  (so plain text-only callers get the old single-shot behaviour). */
  maxTurns?: number;
}

/** A single tool_use block emitted by the model. */
export interface SparToolUseEvent {
  /** CLI's tool_use id — pair with the matching tool_result. */
  id: string;
  /** Raw tool name (e.g. `mcp__spar__read_terminal_scrollback`). */
  name: string;
  /** Whatever JSON object the model passed as the tool input. */
  input: unknown;
}

/** A tool_result block coming back from the executor (MCP server / CLI). */
export interface SparToolResultEvent {
  /** Matches the SparToolUseEvent.id this result belongs to. */
  id: string;
  /** False when the executor reports the tool call as failed. */
  ok: boolean;
  /** Stringified result content (already flattened from the CLI's
   *  array-of-blocks shape — callers don't need to parse further). */
  content: string;
}

export interface SparStreamHandlers {
  /** Visible assistant text. May fire multiple times across turns —
   *  the agent can intersperse text and tool_use across the loop. */
  onText: (text: string) => void;
  /** A tool_use block was emitted by the model. Fires before its
   *  matching onToolResult. */
  onToolUse?: (e: SparToolUseEvent) => void;
  /** The executor returned a result for an earlier tool_use. */
  onToolResult?: (e: SparToolResultEvent) => void;
}

function buildPrompt(opts: SparOptions): string {
  const lines: string[] = [];
  lines.push(opts.systemPrompt.trim());
  lines.push("");
  // Brain — the structured long-term memory tree. Inject before the
  // rolling heartbeat so the durable layer (who Santi is, what's been
  // decided, what's shipped, lessons learned) frames the day-of state
  // that follows.
  const brain = opts.brain?.trim() ?? "";
  if (brain) {
    lines.push(brain);
    lines.push("");
  }
  lines.push("=== HEARTBEAT ===");
  lines.push(opts.heartbeat.trim() || "(empty)");
  lines.push("=== END HEARTBEAT ===");
  lines.push("");
  // Hand-curated per-user persona file. Skip entirely when empty so the
  // model doesn't see a hollow header.
  const userProfile = opts.userProfile?.trim() ?? "";
  if (userProfile) {
    lines.push("=== USER PROFILE ===");
    lines.push(userProfile);
    lines.push("=== END USER PROFILE ===");
    lines.push("");
  }
  // Skills are matched per-turn against the user's question. Inject
  // before the about-the-user block so they read as procedural
  // playbooks the assistant can follow when the request matches.
  const skills = opts.skills?.trim() ?? "";
  if (skills) {
    lines.push("=== SKILLS ===");
    lines.push(
      "Workflow playbooks matched to this turn. Follow the steps when",
      "the user asks for one of these tasks. Don't list the skill name",
      "back at the user — just do the steps.",
    );
    lines.push("");
    lines.push(skills);
    lines.push("=== END SKILLS ===");
    lines.push("");
  }
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
  // Attachments live on disk; the CLI has full file access, so the
  // simplest reliable handoff is just naming the paths in the prompt
  // and letting the model open them itself.
  const images = opts.images ?? [];
  if (images.length > 0) {
    lines.push("");
    lines.push("=== ATTACHED FILES ===");
    lines.push(
      "The user attached the following files. You can view images directly by reading the file path.",
    );
    for (const img of images) {
      lines.push(`- ${img.path} (${img.type})`);
    }
    lines.push("=== END ATTACHED FILES ===");
  }
  // Prompt the model to produce only the next assistant turn.
  lines.push("");
  lines.push("Reply as Assistant with spoken-style prose only. No role prefix.");
  return lines.join("\n");
}

/** Write a one-shot MCP config file wired to our local spar-mcp-server,
 *  plus optionally `@playwright/mcp` for browser automation.
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
  const mcpServers: Record<
    string,
    { command: string; args: string[]; env?: Record<string, string> }
  > = {
    spar: {
      command: nodeBin,
      args: [scriptPath],
      env: {
        AMASO_SPAR_TOKEN: tools.token,
        AMASO_DASHBOARD_URL: tools.dashboardUrl,
      },
    },
  };
  if ((tools.allowedPlaywrightTools?.length ?? 0) > 0) {
    // Resolve the playwright-mcp CLI from this project's node_modules so
    // we don't depend on `npx` being on the Claude CLI's PATH (the same
    // reason we spawn `node` for the spar server above).
    const pwCli = path
      .resolve(
        process.cwd(),
        "node_modules",
        "@playwright",
        "mcp",
        "cli.js",
      )
      .split("\\")
      .join("/");
    // Connect to the user's real Chrome profile so logins (WhatsApp Web,
    // Gmail, etc.) persist across sessions. Caveat: Chrome locks the
    // user-data-dir while it's running — if the user has Chrome open
    // with this profile, Playwright will fail to launch. The override
    // env var `AMASO_PLAYWRIGHT_USER_DATA_DIR` lets us point at a
    // dedicated copy if that becomes a recurring problem; the default
    // matches what the user asked for in the install instructions.
    const userDataDir =
      process.env.AMASO_PLAYWRIGHT_USER_DATA_DIR ??
      "C:\\Users\\santi\\AppData\\Local\\Google\\Chrome\\User Data";
    const pwArgs: string[] = [
      pwCli,
      "--browser",
      "chrome",
      "--user-data-dir",
      userDataDir,
    ];
    // Optional CDP attach for "reuse the existing Chrome window" — set
    // AMASO_PLAYWRIGHT_CDP_ENDPOINT=http://127.0.0.1:9222 after starting
    // Chrome with --remote-debugging-port=9222 and Playwright will
    // attach instead of launching a fresh process.
    const cdp = process.env.AMASO_PLAYWRIGHT_CDP_ENDPOINT;
    if (cdp) pwArgs.push("--cdp-endpoint", cdp);
    mcpServers.playwright = {
      command: nodeBin,
      args: pwArgs,
    };
  }
  const cfg = { mcpServers };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "amaso-spar-"));
  const file = path.join(dir, "mcp.json");
  fs.writeFileSync(file, JSON.stringify(cfg), "utf8");
  return file;
}

/** Flatten the tool_result.content shape the CLI emits (either a plain
 *  string or an array of `{type:"text",text:"..."}` blocks) into a single
 *  string the UI can render. */
function flattenToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          const text = (block as { text?: unknown }).text;
          return typeof text === "string" ? text : JSON.stringify(block);
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

/** Parse a single CLI stream-json line and dispatch to handlers.
 *  Best-effort — unknown shapes are silently ignored so a CLI version
 *  bump that adds new event types can't break the spar pipeline. */
function dispatchCliEvent(
  raw: string,
  handlers: SparStreamHandlers,
): void {
  let evt: unknown;
  try {
    evt = JSON.parse(raw);
  } catch {
    return;
  }
  if (!evt || typeof evt !== "object") return;
  const e = evt as Record<string, unknown>;
  const type = e.type;

  // Skip events emitted from inside an agent sub-call (Task tool, etc.) —
  // those are an inner CLI loop the spar UI shouldn't surface as
  // top-level steps. We only allow the spar tools anyway, but if a
  // future tool ever spawns sub-calls the parent_tool_use_id discriminates.
  if (typeof e.parent_tool_use_id === "string" && e.parent_tool_use_id) {
    return;
  }

  if (type === "assistant") {
    const message = e.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? message!.content : [];
    for (const block of blocks as Array<Record<string, unknown>>) {
      if (block?.type === "text" && typeof block.text === "string") {
        handlers.onText(block.text);
      } else if (
        block?.type === "tool_use" &&
        typeof block.id === "string" &&
        typeof block.name === "string"
      ) {
        handlers.onToolUse?.({
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        });
      }
    }
    return;
  }

  if (type === "user") {
    // The CLI's "user" events between turns carry tool_result blocks
    // (the MCP server's response paired with the prior tool_use).
    const message = e.message as { content?: unknown } | undefined;
    const blocks = Array.isArray(message?.content) ? message!.content : [];
    for (const block of blocks as Array<Record<string, unknown>>) {
      if (
        block?.type === "tool_result" &&
        typeof block.tool_use_id === "string"
      ) {
        handlers.onToolResult?.({
          id: block.tool_use_id,
          ok: block.is_error !== true,
          content: flattenToolResultContent(block.content),
        });
      }
    }
    return;
  }

  // `result` and `system` events carry session metadata. We don't need
  // to surface them in the chat — the `assistant` events above already
  // streamed everything visible. Errors flagged in `result` (subtype !=
  // "success") still propagate via the CLI's exit code, which the
  // stream wrapper turns into a rejection at process close.
}

/** Streams text + tool events from the local Claude CLI. The agent
 *  loop runs entirely inside the CLI (tool_use → MCP → tool_result →
 *  next turn) and handlers fire as events arrive. Resolves once the
 *  CLI exits; rejects on spawn error or non-zero exit (but not on
 *  user-initiated abort).
 *
 *  Handlers can be passed as a callback object or as a single text
 *  callback for the (legacy) text-only collectors. */
export async function streamFromClaudeCli(
  opts: SparOptions,
  handlers: SparStreamHandlers | ((text: string) => void),
): Promise<void> {
  const h: SparStreamHandlers =
    typeof handlers === "function" ? { onText: handlers } : handlers;
  const bin = findClaudeBinary();
  // stream-json output requires --verbose; --include-partial-messages
  // is intentionally OFF — we get one assistant event per turn (with
  // text + tool_use blocks already complete) which is exactly what the
  // UI wants to render as a step. Partial-message mode would shred the
  // text into deltas and force us to reassemble them per-turn anyway.
  const args: string[] = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
  ];
  if (opts.model) args.push("--model", opts.model);

  // Default: 10 turns when tools are wired up (room for ~5 tool/result
  // round-trips plus a final answer), 1 turn for plain text-only callers
  // (the heartbeat cron / knowledge-graph extractor — they don't expose
  // tools and don't expect a loop). Caller can override either way.
  const maxTurns = opts.maxTurns ?? (opts.tools ? 10 : 1);
  args.push("--max-turns", String(maxTurns));

  let mcpConfigPath: string | null = null;
  if (opts.tools) {
    mcpConfigPath = writeMcpConfig(opts.tools);
    args.push("--mcp-config", mcpConfigPath);
    // Allow only the spar MCP tools we declared. Comma-separated is the
    // most reliable form: the help advertises both comma- and space-
    // separated, but space-separated as a single quoted arg has been
    // observed to silently match nothing on some CLI builds, which
    // looks identical to "model decided not to use any tool" — i.e.
    // the spar chat shows no tool cards. Comma-separated has no such
    // ambiguity.
    const allow = [
      ...opts.tools.allowedTools.map((n) => `mcp__spar__${n}`),
      ...(opts.tools.allowedPlaywrightTools ?? []).map(
        (n) => `mcp__playwright__${n}`,
      ),
    ];
    args.push("--allowedTools", allow.join(","));
    // bypassPermissions auto-approves anything on the allow list. The
    // older `acceptEdits` value only auto-approves Edit-class tools,
    // so MCP tool calls would silently sit at a permission prompt with
    // no interactive approver in --print mode — model thinks the call
    // never resolved, gives up, and the spar UI never sees a tool_use
    // event surface as a card. Pinning to bypassPermissions makes the
    // explicit allow list the single source of truth.
    args.push("--permission-mode", "bypassPermissions");
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

  // Line-buffer stdout — stream-json emits one JSON object per line and
  // a chunk boundary mid-object would otherwise crash JSON.parse.
  let stdoutBuf = "";
  proc.stdout?.setEncoding("utf8");
  proc.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      dispatchCliEvent(line, h);
    }
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
      // Drain any final partial line — should be empty in practice
      // since stream-json always emits a trailing newline, but we
      // tolerate a CLI that flushes without one.
      const tail = stdoutBuf.trim();
      stdoutBuf = "";
      if (tail) dispatchCliEvent(tail, h);
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

/** One-shot collect — awaits the full CLI text output. For the
 *  heartbeat cron and knowledge-graph extractor; both want a single
 *  text reply with no tool loop, so they get maxTurns=1 by default
 *  via the helper below. */
export async function collectFromClaudeCli(opts: SparOptions): Promise<string> {
  let out = "";
  await streamFromClaudeCli(opts, (chunk) => {
    out += chunk;
  });
  return out;
}
