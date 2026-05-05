import { collectFromClaudeCli } from "./spar-claude";
import type { SparMessageRow } from "./spar-conversations";

/**
 * Smart title generation + context-drift detection for spar
 * conversations. Both calls go through Claude Haiku via the same CLI
 * the rest of the route uses (no separate API key plumbing) and are
 * deliberately cheap: minimal tokens, strict-JSON output, hard caps
 * on input size.
 *
 * Callers fire-and-forget — failures here must never break the
 * /api/spar streaming flow, so every public function swallows errors
 * and returns null on anything unexpected.
 */

const NAMING_MODEL = process.env.AMASO_NAMING_MODEL || "haiku";

const NAMING_SYSTEM_PROMPT = `You name conversations for a chat sidebar. Read the recent messages and emit STRICT JSON: {"title": "..."}.

Rules:
- 3 to 6 words.
- Max 50 characters.
- Title-case the main words.
- No trailing punctuation, no quotes, no emojis, no markdown.
- Capture the actual topic the user is working on. Skip filler ("hello", "thanks").
- If the conversation is too short to know, return {"title": null}.

Output strict JSON only. No prose.`;

const DRIFT_SYSTEM_PROMPT = `You audit chat conversations for topic drift. You receive the current title and the last few messages. Emit STRICT JSON:

{
  "drifted": boolean,                    // true when the recent topic no longer matches the title
  "newTitle": string | null,             // suggested replacement title (3-6 words, max 50 chars) when drifted is true; null otherwise
  "shouldSplit": boolean,                // true ONLY when the new topic is so different that a new chat would serve the user better
  "splitReason": string | null           // one short sentence (max 140 chars) explaining the suggestion; null otherwise
}

Rules:
- Be conservative: only flag drifted=true when the topic has clearly moved on, not just expanded.
- shouldSplit=true is rare. Reserve it for unrelated subjects (e.g. title is "Vercel Deploy Setup" but recent messages discuss meal planning).
- newTitle follows the same constraints as the naming prompt: 3-6 words, max 50 chars, title-cased, no punctuation/quotes/emojis.
- Output strict JSON only. No prose.`;

interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

function toTurns(messages: SparMessageRow[]): ConversationTurn[] {
  const out: ConversationTurn[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (!m.content.trim()) continue;
    if (m.content.startsWith("[kickoff]") || m.content.startsWith("[system]")) continue;
    // Cap each turn so the prompt stays small even for long replies.
    const content = m.content.length > 1500 ? m.content.slice(0, 1500) + " …" : m.content;
    out.push({ role: m.role, content });
  }
  return out;
}

function formatConversationForPrompt(turns: ConversationTurn[]): string {
  return turns
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.content}`)
    .join("\n\n");
}

function safeJsonParse(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  // The CLI sometimes wraps JSON in stray code fences or prose despite
  // the strict instruction. Try the cleanest paths first, then fall
  // back to a regex extraction for the first {...} block.
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* give up */
    }
  }
  return null;
}

function sanitizeTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let t = raw.trim();
  if (!t) return null;
  // Strip surrounding quotes / trailing punctuation that survives the
  // strict-JSON instruction.
  t = t.replace(/^["'`]+|["'`]+$/g, "");
  t = t.replace(/[.!?,;:]+$/g, "");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return null;
  // Cap to 50 characters cleanly on a word boundary.
  if (t.length > 50) {
    t = t.slice(0, 50).replace(/\s+\S*$/, "").trim() || t.slice(0, 50);
  }
  return t;
}

/**
 * Generate a 3-6 word title from the recent transcript. Returns null
 * when the conversation is too short or Haiku didn't return usable
 * JSON. Never throws.
 */
export async function generateTitle(
  messages: SparMessageRow[],
  opts: { signal?: AbortSignal; model?: string } = {},
): Promise<string | null> {
  const turns = toTurns(messages).slice(-6);
  if (turns.length === 0) return null;
  const userPrompt = `Recent messages:\n\n${formatConversationForPrompt(turns)}\n\nReturn the title as strict JSON: {"title": "..."}.`;
  let cliOutput = "";
  try {
    cliOutput = await collectFromClaudeCli({
      systemPrompt: NAMING_SYSTEM_PROMPT,
      heartbeat: "",
      history: [{ role: "user", content: userPrompt }],
      model: opts.model ?? NAMING_MODEL,
      maxTurns: 1,
      signal: opts.signal,
    });
  } catch (err) {
    console.warn(
      "[spar-naming] generateTitle CLI failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  const parsed = safeJsonParse(cliOutput);
  if (!parsed) return null;
  return sanitizeTitle(parsed.title);
}

export interface DriftResult {
  drifted: boolean;
  newTitle: string | null;
  shouldSplit: boolean;
  splitReason: string | null;
}

/**
 * Audit the last few messages against the current title and return a
 * drift verdict. Returns null on parse failure / CLI error so the
 * caller can decide whether to retry on the next trigger window.
 */
export async function detectDrift(
  currentTitle: string,
  messages: SparMessageRow[],
  opts: { signal?: AbortSignal; model?: string } = {},
): Promise<DriftResult | null> {
  const turns = toTurns(messages).slice(-5);
  if (turns.length === 0) return null;
  const safeTitle = currentTitle.replace(/\s+/g, " ").trim().slice(0, 80);
  const userPrompt = `Current title: ${safeTitle}\n\nLast messages:\n\n${formatConversationForPrompt(turns)}\n\nReturn the strict JSON described in the system prompt.`;
  let cliOutput = "";
  try {
    cliOutput = await collectFromClaudeCli({
      systemPrompt: DRIFT_SYSTEM_PROMPT,
      heartbeat: "",
      history: [{ role: "user", content: userPrompt }],
      model: opts.model ?? NAMING_MODEL,
      maxTurns: 1,
      signal: opts.signal,
    });
  } catch (err) {
    console.warn(
      "[spar-naming] detectDrift CLI failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  const parsed = safeJsonParse(cliOutput);
  if (!parsed) return null;
  const drifted = parsed.drifted === true;
  const shouldSplit = parsed.shouldSplit === true;
  const newTitle = drifted ? sanitizeTitle(parsed.newTitle) : null;
  let splitReason: string | null = null;
  if (shouldSplit && typeof parsed.splitReason === "string") {
    splitReason = parsed.splitReason
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 280) || null;
  }
  return {
    drifted,
    newTitle,
    shouldSplit,
    splitReason,
  };
}

/**
 * Narrow rule for when an assistant turn should trigger a (re-)name.
 *
 *   - 1, 2, 3 → fresh-conversation naming. Each successive turn lets
 *     the topic clarify. After turn 3 we lock in until drift
 *     detection takes over.
 *   - 10, 20, 30, … → drift-detection slot. Caller runs detectDrift
 *     and only renames if the verdict says so.
 *
 * Returns the trigger kind so the caller can pick the right path.
 */
export type NamingTrigger =
  | { kind: "rename"; reason: "early-clarify" }
  | { kind: "drift" }
  | null;

export function namingTrigger(assistantMessageCount: number): NamingTrigger {
  if (assistantMessageCount <= 0) return null;
  if (assistantMessageCount <= 3) return { kind: "rename", reason: "early-clarify" };
  if (assistantMessageCount % 10 === 0) return { kind: "drift" };
  return null;
}
