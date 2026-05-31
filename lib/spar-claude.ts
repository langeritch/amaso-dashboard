import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnEnvOverrides } from "./claude-accounts";
import { stripEmDashes } from "./copy-sanitize";

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
  /** Fires once per top-level assistant event from the CLI — i.e.
   *  after one full agent turn (its text + tool_use blocks) has been
   *  delivered. Lets persistence-oriented callers flush their
   *  per-turn buffer instead of accumulating across the whole run.
   *  Optional — pass-through callers (the main spar route) ignore
   *  this and continue to handle text/tool events directly. */
  onTurnEnd?: () => void;
  /** Fires once per assistant turn with the token counts the CLI
   *  reports alongside each message. Callers forward these into the
   *  NDJSON usage event so the per-message token badge shows real
   *  numbers (input / output / cache_read / cache_creation). */
  onUsage?: (e: SparUsageEvent) => void;
}

/** Token usage extracted from a backend stream. Cumulative across the
 *  whole run — i.e. the values grow monotonically as the agent loop
 *  progresses, and the last emission for a given stream is the final
 *  total for the turn. Both backends (CLI + SDK) handle the per-event
 *  bookkeeping internally so route-level callers can just forward each
 *  emission to the client and trust the latest value.
 *
 *  Camel-case mirrors the Anthropic API shape (input_tokens, etc.) but
 *  is uniform across both backends so the NDJSON payload doesn't have
 *  to branch on the source. */
export interface SparUsageEvent {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Internal shape used by dispatchCliEvent to tell the streamFromClaudeCli
 *  wrapper whether a given emission is a per-turn delta (assistant event)
 *  or a final cumulative total (result event). The wrapper turns both
 *  into a single monotonic cumulative emission for the caller. */
interface CliUsageEmit extends SparUsageEvent {
  /** True when the values represent the total for the whole run (from
   *  the CLI's `result` event). False / undefined when they're a single
   *  assistant turn's delta. */
  isFinal?: boolean;
}

function buildPrompt(opts: SparOptions, inlineImages = false): string {
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
  const images = opts.images ?? [];
  if (images.length > 0) {
    lines.push("");
    if (inlineImages) {
      // The image bytes are delivered natively as base64 image content
      // blocks alongside this text (CLI --input-format stream-json), so
      // the model sees them directly — no Read tool needed. This is the
      // reliable path. The old "Read the temp path" handoff depended on
      // the model voluntarily calling Read, which it skipped under the
      // voice-first persona — the root cause of "image upload, no reply".
      lines.push("=== ATTACHED IMAGES ===");
      lines.push(
        "The user attached the following image(s), included inline with",
        "this message. Look at them directly and refer to their contents",
        "naturally in your reply.",
      );
      for (const img of images) {
        lines.push(`- ${img.name} (${img.type})`);
      }
      lines.push("=== END ATTACHED IMAGES ===");
    } else {
      // Fallback: the bytes couldn't be inlined, so name the on-disk
      // paths and let the model open them with its built-in Read tool.
      lines.push("=== ATTACHED FILES ===");
      lines.push(
        "The user attached the following image(s). Use the Read tool on",
        "each path BEFORE composing your reply so you can actually see",
        "what they sent — the path alone tells you nothing. Refer to the",
        "image contents naturally in your response.",
      );
      for (const img of images) {
        lines.push(`- ${img.path} (${img.type})`);
      }
      lines.push("=== END ATTACHED FILES ===");
    }
  }
  // Prompt the model to produce only the next assistant turn.
  lines.push("");
  lines.push("Reply as Assistant with spoken-style prose only. No role prefix.");
  return lines.join("\n");
}

/** Read attached images off disk into Anthropic-style base64 image
 *  content blocks for the CLI's `--input-format stream-json` input.
 *  Mirrors lib/spar-sdk.ts so the model receives the real bytes
 *  natively instead of relying on a Read tool call against a temp
 *  path. Unreadable files are skipped; an empty result makes the
 *  caller fall back to the legacy path+Read prompt. */
function buildImageInputBlocks(
  images: NonNullable<SparOptions["images"]>,
): Array<{
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}> {
  const allowed = new Set([
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
  ]);
  const blocks: Array<{
    type: "image";
    source: { type: "base64"; media_type: string; data: string };
  }> = [];
  for (const img of images) {
    try {
      const data = fs.readFileSync(img.path).toString("base64");
      const media_type = allowed.has(img.type) ? img.type : "image/png";
      blocks.push({
        type: "image",
        source: { type: "base64", media_type, data },
      });
    } catch (err) {
      console.warn(
        `[spar-claude] failed to read image ${img.path} for inline CLI input:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return blocks;
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
    // Two browser-driver options:
    //
    //   AMASO_SPAR_DRIVER=extension — talk to the user's real Chrome
    //     via the Amaso extension's CDP bridge. The browser_* tools
    //     are exposed by `scripts/extension-mcp-server.mjs`, which
    //     POSTs each call to /api/internal/ext-tools and the dashboard
    //     forwards it over the ext-bridge WebSocket. Picks up real
    //     logins, cookies, profile state — no separate Chrome process.
    //     Requires the user to install extension/ in their Chrome and
    //     have the dashboard tab open at least once.
    //
    //   default — @playwright/mcp launches its own Chrome against a
    //     copy of the user-data-dir. Doesn't share live state and
    //     fails if Chrome already has the profile locked.
    if (process.env.AMASO_SPAR_DRIVER === "extension") {
      const extServer = path
        .resolve(process.cwd(), "scripts", "extension-mcp-server.mjs")
        .split("\\")
        .join("/");
      mcpServers.extension = {
        command: nodeBin,
        args: [extServer],
        env: {
          AMASO_SPAR_TOKEN: tools.token,
          AMASO_DASHBOARD_URL: tools.dashboardUrl,
        },
      };
    } else {
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
  /** Internal hook the streamFromClaudeCli wrapper passes in so it can
   *  distinguish per-turn (assistant) usage from the cumulative total
   *  on the `result` event. External callers don't need this — they
   *  see only the normalised cumulative emission via handlers.onUsage. */
  emitUsageInternal?: (e: CliUsageEmit) => void,
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
    const message = e.message as
      | { content?: unknown; usage?: unknown }
      | undefined;
    const blocks = Array.isArray(message?.content) ? message!.content : [];
    for (const block of blocks as Array<Record<string, unknown>>) {
      if (block?.type === "text" && typeof block.text === "string") {
        handlers.onText(stripEmDashes(block.text));
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
    // Token usage piggy-backs on the assistant message. The CLI mirrors
    // the Anthropic API shape: input_tokens + output_tokens plus the
    // two cache fields when prompt caching is in play. Forward all four
    // so the per-message badge can render the real numbers (not zeros
    // like the old fallback emitted).
    const usage = message?.usage as
      | {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        }
      | undefined;
    if (usage && emitUsageInternal) {
      emitUsageInternal({
        inputTokens: Number(usage.input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
        cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0),
        cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
      });
    }
    // One assistant event === one top-level agent turn. Persistence-
    // oriented callers (the per-task agent runner) use this hook to
    // flush their buffer so each turn lands in the chat as it
    // completes instead of waiting for the whole run to finish.
    handlers.onTurnEnd?.();
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

  // `result` carries session metadata including the cumulative usage
  // total for the whole run. Some CLI builds don't populate usage on
  // individual assistant events (or omit cache fields there) but always
  // emit the totals on the final result event — so we treat the result
  // event as authoritative when present. The wrapper that owns
  // emitUsageInternal handles the per-turn-delta vs. final-total
  // accounting so callers see one monotonic cumulative emission.
  if (type === "result") {
    const usage = (e as { usage?: unknown }).usage as
      | {
          input_tokens?: number;
          output_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        }
      | undefined;
    if (usage && emitUsageInternal) {
      emitUsageInternal({
        inputTokens: Number(usage.input_tokens ?? 0),
        outputTokens: Number(usage.output_tokens ?? 0),
        cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0),
        cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
        isFinal: true,
      });
    }
    return;
  }

  // `system` events carry session metadata we don't surface. Errors
  // flagged in `result` (subtype != "success") still propagate via the
  // CLI's exit code, which the stream wrapper turns into a rejection at
  // process close.
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

  // Per-stream usage accumulator. dispatchCliEvent surfaces both
  // assistant-event deltas and the result-event total via
  // emitUsageInternal; this closure normalises both into a single
  // monotonic cumulative emission so the route just forwards each
  // update verbatim. The `result` event takes priority once it
  // arrives because the CLI populates that field as the authoritative
  // total (including cache fields even on builds that omit them on
  // per-turn messages — the original source of the badge-shows-zero
  // bug).
  const accum: SparUsageEvent = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
  let finalSeen = false;
  const emitUsageInternal = (e: CliUsageEmit) => {
    if (e.isFinal) {
      // Authoritative total. Replace and lock out further additive
      // updates so a stray follow-on assistant event can't double-count.
      accum.inputTokens = e.inputTokens;
      accum.outputTokens = e.outputTokens;
      accum.cacheCreationTokens = e.cacheCreationTokens;
      accum.cacheReadTokens = e.cacheReadTokens;
      finalSeen = true;
    } else if (!finalSeen) {
      accum.inputTokens += e.inputTokens;
      accum.outputTokens += e.outputTokens;
      accum.cacheCreationTokens += e.cacheCreationTokens;
      accum.cacheReadTokens += e.cacheReadTokens;
    }
    h.onUsage?.({
      inputTokens: accum.inputTokens,
      outputTokens: accum.outputTokens,
      cacheCreationTokens: accum.cacheCreationTokens,
      cacheReadTokens: accum.cacheReadTokens,
    });
  };

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

  // Image delivery: inline the bytes as base64 image blocks via
  // stream-json input when we can read them (reliable — the model sees
  // them natively). Fall back to the legacy path+Read prompt when no
  // image bytes could be read. Text-only turns are unaffected here:
  // imageBlocks is empty, inlineImages is false, and the plain-text
  // stdin path below runs exactly as before.
  const imageBlocks =
    opts.images && opts.images.length > 0
      ? buildImageInputBlocks(opts.images)
      : [];
  const inlineImages = imageBlocks.length > 0;
  if (inlineImages) {
    args.push("--input-format", "stream-json");
  }

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
    // Tool prefix follows whichever driver writeMcpConfig registered.
    // The browser-tool *names* (browser_navigate etc.) are identical
    // either way; only the MCP-server namespace differs.
    const browserPrefix =
      process.env.AMASO_SPAR_DRIVER === "extension"
        ? "mcp__extension__"
        : "mcp__playwright__";
    const allow = [
      ...opts.tools.allowedTools.map((n) => `mcp__spar__${n}`),
      ...(opts.tools.allowedPlaywrightTools ?? []).map(
        (n) => `${browserPrefix}${n}`,
      ),
    ];
    // Images: the model needs Claude Code's built-in Read tool to
    // decode the PNG/JPEG content from the temp file path the route
    // wrote it to. Without this, the prompt's "=== ATTACHED FILES ==="
    // block is just a text reference to a path the model can't open,
    // and the screenshot is invisible to the model — manifesting as
    // "the assistant didn't see my screenshot" / no useful reply.
    // Only need the built-in Read tool for the legacy fallback (image
    // bytes couldn't be inlined). Inlined images are seen natively, so
    // we don't widen the tool surface unnecessarily.
    if (opts.images && opts.images.length > 0 && !inlineImages) {
      allow.push("Read");
    }
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

  if (inlineImages) {
    // stream-json input: one user message carrying the prompt text plus
    // the base64 image blocks. The CLI feeds this to the model as a
    // normal user turn with native image content — no Read round-trip.
    const userMessage = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: buildPrompt(opts, true) },
          ...imageBlocks,
        ],
      },
    };
    proc.stdin?.write(JSON.stringify(userMessage) + "\n");
  } else {
    proc.stdin?.write(buildPrompt(opts));
  }
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
      dispatchCliEvent(line, h, emitUsageInternal);
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
      if (tail) dispatchCliEvent(tail, h, emitUsageInternal);
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
