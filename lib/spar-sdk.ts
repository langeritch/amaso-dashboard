/**
 * Anthropic SDK-based spar inference with prompt caching.
 *
 * Replaces the Claude CLI subprocess path (lib/spar-claude.ts) when
 * AMASO_SPAR_ANTHROPIC_KEY is set. Two main advantages:
 *   1. cache_control breakpoints on the static prefix (system prompt,
 *      brain core, tool definitions) → cache_read_input_tokens on
 *      subsequent turns within the 5-min cache TTL.
 *   2. Full usage metadata (input, output, cache_creation,
 *      cache_read) comes back on every turn so the UI can show it.
 *
 * Tools run via the existing /api/internal/spar-tools loopback endpoint
 * (same path as the MCP server uses) — no tool schema duplication needed.
 * Schemas are read once at startup from scripts/spar-mcp-server.mjs so
 * they stay in sync automatically.
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import type {
  ContentBlockParam,
  ImageBlockParam,
  MessageParam,
  TextBlockParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import type { SparOptions, SparStreamHandlers } from "./spar-claude";
import { stripEmDashes } from "./copy-sanitize";

export interface SparUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

// ---- Tool schema loading ---------------------------------------------------

interface RawToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

let _toolSchemas: Tool[] | null = null;

function loadToolSchemas(): Tool[] {
  if (_toolSchemas) return _toolSchemas;
  try {
    const src = fs.readFileSync(
      path.join(process.cwd(), "scripts", "spar-mcp-server.mjs"),
      "utf8",
    );
    // The TOOLS array starts at "const TOOLS = [" and ends just before
    // "async function callTool(". Use Function() to evaluate the pure
    // data literal safely — it contains only object/array/string
    // literals with no external references.
    const start = src.indexOf("const TOOLS = [");
    const endMarker = "\nasync function callTool(";
    const end = src.indexOf(endMarker, start);
    if (start === -1 || end === -1) {
      throw new Error("TOOLS array boundaries not found");
    }
    const snippet = src
      .slice(start + "const TOOLS = ".length, end)
      .trimEnd()
      .replace(/;$/, "");
    // eslint-disable-next-line no-new-func
    const raw = new Function(`"use strict"; return ${snippet}`)() as RawToolDef[];
    _toolSchemas = raw.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Tool["input_schema"],
    }));
    console.log(`[spar-sdk] loaded ${_toolSchemas.length} tool schemas from MCP server`);
  } catch (err) {
    console.warn(
      "[spar-sdk] failed to load tool schemas; falling back to empty list:",
      err instanceof Error ? err.message : String(err),
    );
    _toolSchemas = [];
  }
  return _toolSchemas!;
}

// ---- Cache-control helpers ------------------------------------------------

function cacheable(text: string): TextBlockParam {
  return { type: "text", text, cache_control: { type: "ephemeral" } };
}

function volatile(text: string): TextBlockParam {
  return { type: "text", text };
}

// ---- Tool execution -------------------------------------------------------

async function executeTool(
  name: string,
  input: unknown,
  dashboardUrl: string,
  token: string,
): Promise<{ ok: boolean; content: string }> {
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [0, 500, 1500];
  let lastErr: unknown;
  for (let i = 0; i < MAX_RETRIES; i++) {
    if (RETRY_DELAYS[i] > 0) {
      await new Promise<void>((r) => setTimeout(r, RETRY_DELAYS[i]));
    }
    try {
      const res = await fetch(`${dashboardUrl}/api/internal/spar-tools`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tool: name, args: input ?? {} }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        result?: unknown;
        error?: string;
      };
      const content = json.ok
        ? typeof json.result === "string"
          ? json.result
          : JSON.stringify(json.result, null, 2)
        : `Error: ${json.error ?? "unknown error"}`;
      return { ok: json.ok !== false, content };
    } catch (err) {
      lastErr = err;
      if (i < MAX_RETRIES - 1) {
        console.warn(`[spar-sdk] tool ${name} attempt ${i + 1} failed:`, err);
      }
    }
  }
  const msg =
    lastErr instanceof Error ? lastErr.message : String(lastErr ?? "network error");
  return { ok: false, content: `Network error: ${msg}` };
}

// ---- Main export ----------------------------------------------------------

/**
 * SDK-based spar stream. Drop-in replacement for streamFromClaudeCli with
 * the same handler interface plus an optional onUsage callback that fires
 * once per model turn with the raw API usage counters.
 *
 * Requires opts.tools to be supplied (same as CLI path); dashboardUrl and
 * token are read from there for the in-process tool execution loop.
 */
export async function streamFromAnthropicSdk(
  opts: SparOptions,
  handlers: SparStreamHandlers | ((text: string) => void),
  onUsage?: (usage: SparUsage) => void,
): Promise<void> {
  const h: SparStreamHandlers =
    typeof handlers === "function" ? { onText: handlers } : handlers;

  const apiKey =
    process.env.AMASO_SPAR_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "AMASO_SPAR_ANTHROPIC_KEY not set — cannot use SDK spar path",
    );
  }

  const client = new Anthropic({ apiKey });
  const model = opts.model ?? "claude-opus-4-7";

  // ---- Build system blocks with cache breakpoints ----
  // Static (cacheable): system prompt + brain core + user profile
  // Volatile (no cache): heartbeat + skills + graph profile

  const systemBlocks: TextBlockParam[] = [];

  const sysText = opts.systemPrompt.trim();
  if (sysText) systemBlocks.push(cacheable(sysText));

  const brain = opts.brain?.trim() ?? "";
  if (brain) systemBlocks.push(cacheable(brain));

  const userProfile = opts.userProfile?.trim() ?? "";
  if (userProfile) {
    systemBlocks.push(
      cacheable(
        `=== USER PROFILE ===\n${userProfile}\n=== END USER PROFILE ===`,
      ),
    );
  }

  // Volatile suffix (turn-specific state)
  const volatileParts: string[] = [];

  const heartbeat = opts.heartbeat?.trim() ?? "";
  if (heartbeat) {
    volatileParts.push(`=== HEARTBEAT ===\n${heartbeat}\n=== END HEARTBEAT ===`);
  }

  const skills = opts.skills?.trim() ?? "";
  if (skills) {
    volatileParts.push(
      `=== SKILLS ===\nWorkflow playbooks matched to this turn. Follow the steps when the user asks for one of these tasks.\n\n${skills}\n=== END SKILLS ===`,
    );
  }

  const profile = opts.profile?.trim() ?? "";
  if (profile) {
    volatileParts.push(
      `=== ABOUT THE USER ===\nLearned across prior conversations. Apply these naturally.\n\n${profile}\n=== END ABOUT THE USER ===`,
    );
  }

  if (volatileParts.length > 0) {
    systemBlocks.push(volatile(volatileParts.join("\n\n")));
  }

  // ---- Build tool definitions with cache on the last entry ----
  const rawTools = loadToolSchemas();
  const tools: Tool[] =
    rawTools.length === 0
      ? []
      : [
          ...rawTools.slice(0, -1),
          {
            ...rawTools[rawTools.length - 1],
            cache_control: { type: "ephemeral" },
          } as Tool,
        ];

  // ---- Build conversation messages ----
  const conversationMsgs: MessageParam[] = opts.history.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Images: the SDK gets the real bytes via Anthropic image content
  // blocks — the model decodes them natively. Earlier we appended the
  // disk path as text, which the model couldn't actually open (no file
  // tool on the remote API) so screenshots were invisible. Reading the
  // file off disk and base64-encoding into an `image` block is what the
  // API expects; pair it with the prior user text in a content array so
  // the model sees caption + image as one turn.
  if (opts.images && opts.images.length > 0) {
    const imageBlocks: ImageBlockParam[] = [];
    for (const img of opts.images) {
      try {
        const buf = fs.readFileSync(img.path);
        const base64 = buf.toString("base64");
        // Normalise the media type — the API accepts a strict allow-list.
        // Anything outside it falls back to image/png which is the
        // common case from the mobile composer.
        const allowed = new Set([
          "image/png",
          "image/jpeg",
          "image/gif",
          "image/webp",
        ]);
        const mediaType = (allowed.has(img.type) ? img.type : "image/png") as
          | "image/png"
          | "image/jpeg"
          | "image/gif"
          | "image/webp";
        imageBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: base64,
          },
        });
      } catch (err) {
        console.warn(
          `[spar-sdk] failed to read image ${img.path} for inline upload:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (imageBlocks.length > 0) {
      const last = conversationMsgs[conversationMsgs.length - 1];
      // Pull the existing text out of the last user turn (if any) so we
      // can merge it with the image blocks. When the last message is an
      // assistant turn (or there's no history at all), synthesize a new
      // user turn carrying the images so the API has something to reply
      // to — the route should already have injected a placeholder, but
      // we cover the edge case here too so an empty-caption image-only
      // upload still reaches the model.
      const captionText =
        last && last.role === "user"
          ? typeof last.content === "string"
            ? last.content
            : Array.isArray(last.content)
              ? last.content
                  .map((b) =>
                    typeof b === "string"
                      ? b
                      : (b as { type?: string; text?: string }).type === "text"
                        ? (b as { text?: string }).text ?? ""
                        : "",
                  )
                  .join("\n")
              : ""
          : "";
      const mergedBlocks: ContentBlockParam[] = [
        ...imageBlocks,
        {
          type: "text",
          text: captionText.trim() || "Please look at the attached image(s).",
        },
      ];
      if (last && last.role === "user") {
        conversationMsgs[conversationMsgs.length - 1] = {
          role: "user",
          content: mergedBlocks,
        };
      } else {
        conversationMsgs.push({ role: "user", content: mergedBlocks });
      }
    }
  }

  if (conversationMsgs.length === 0) {
    conversationMsgs.push({
      role: "user",
      content: "Reply as Assistant with spoken-style prose only. No role prefix.",
    });
  }

  // ---- Agent loop ----
  const dashboardUrl = opts.tools?.dashboardUrl ?? "http://127.0.0.1:3737";
  const token = opts.tools?.token ?? "";
  const maxTurns = opts.maxTurns ?? (opts.tools ? 10 : 1);
  let turnsUsed = 0;
  const aborted = () => opts.signal?.aborted === true;

  // Cumulative usage across all agent turns in this stream. Each
  // finalMessage.usage carries only its own turn's counts, but the
  // route + badge expect a monotonic running total (same contract as
  // the CLI backend after the recent unification). Accumulate locally
  // and emit the cumulative snapshot each turn so the client just
  // takes the latest value.
  const cumulativeUsage: SparUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  while (turnsUsed < maxTurns && !aborted()) {
    turnsUsed++;

    const runner = client.messages
      .stream({
        model,
        max_tokens: 8096,
        system: systemBlocks as Anthropic.MessageParam["content"] extends never
          ? never
          : TextBlockParam[],
        tools: tools.length > 0 ? tools : undefined,
        messages: conversationMsgs,
      })
      .on("text", (text) => {
        h.onText(stripEmDashes(text));
      });

    // Respect abort signal
    if (opts.signal) {
      const abortListener = () => {
        try {
          runner.abort();
        } catch {
          /* ignore */
        }
      };
      opts.signal.addEventListener("abort", abortListener, { once: true });
      runner.on("finalMessage", () => {
        opts.signal?.removeEventListener("abort", abortListener);
      });
    }

    const finalMsg = await runner.finalMessage();

    // Report usage (on last turn or every turn — report every turn so
    // the client can accumulate totals if desired; the route only
    // forwards the last call to keep it simple).
    if (onUsage) {
      const u = finalMsg.usage as {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      cumulativeUsage.inputTokens += u.input_tokens;
      cumulativeUsage.outputTokens += u.output_tokens;
      cumulativeUsage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
      cumulativeUsage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      // Server-side debug log for cache hit-rate monitoring.
      if (process.env.AMASO_SPAR_DEBUG === "1" || process.env.NODE_ENV !== "production") {
        console.log(
          `[spar-sdk] turn=${turnsUsed} model=${model}` +
            ` in=${u.input_tokens} out=${u.output_tokens}` +
            ` cache_create=${u.cache_creation_input_tokens ?? 0}` +
            ` cache_read=${u.cache_read_input_tokens ?? 0}` +
            ` (cumul in=${cumulativeUsage.inputTokens} out=${cumulativeUsage.outputTokens})`,
        );
      }
      onUsage({
        inputTokens: cumulativeUsage.inputTokens,
        outputTokens: cumulativeUsage.outputTokens,
        cacheCreationTokens: cumulativeUsage.cacheCreationTokens,
        cacheReadTokens: cumulativeUsage.cacheReadTokens,
      });
    }

    h.onTurnEnd?.();

    // Collect any tool_use blocks
    const toolUses = finalMsg.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // No tools requested → done
    if (toolUses.length === 0 || finalMsg.stop_reason === "end_turn") {
      break;
    }

    if (aborted()) break;

    // Fire tool_use events
    for (const tu of toolUses) {
      h.onToolUse?.({ id: tu.id, name: tu.name, input: tu.input });
    }

    // Execute tools (sequentially — parallel execution risks racy
    // heartbeat / terminal writes; sequential is safe and tools are
    // fast loopback calls).
    const toolResults: Array<{ id: string; ok: boolean; content: string }> = [];
    for (const tu of toolUses) {
      if (aborted()) break;
      const result = await executeTool(tu.name, tu.input, dashboardUrl, token);
      h.onToolResult?.({ id: tu.id, ok: result.ok, content: result.content });
      toolResults.push({ id: tu.id, ...result });
    }

    // Add this turn + tool results to the conversation
    conversationMsgs.push({ role: "assistant", content: finalMsg.content });
    conversationMsgs.push({
      role: "user",
      content: toolResults.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.id,
        content: r.content,
        is_error: !r.ok,
      })),
    });
  }
}
