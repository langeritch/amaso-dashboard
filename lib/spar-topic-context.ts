/**
 * Smart Topic System — Layer 2.
 *
 * Builds the LLM context window for a spar reply. When the current user
 * message cheaply maps to an existing topic, we splice that topic's
 * older tagged messages into the front of the recency window so the
 * assistant can recall earlier context without it being in the
 * client-provided slice.
 *
 * Cheap-only on the request path: model fallback would burn 1–3 s of
 * latency on every turn. If the cheap matcher misses, we return the
 * caller's recency array untouched — the auto-namer / drift detector
 * will eventually create the topic via Layer 1's full async path on
 * post-write detection, and the next turn will benefit.
 *
 * Failures here NEVER break the chat. Any throw becomes a silent
 * fallback to recency.
 */

import fs from "node:fs";
import path from "node:path";
import { cheapDetectTopic } from "./topic-detect";
import {
  listBrainRefs,
  listMessagesForTopic,
  getTopicById,
  type BrainRef,
} from "./topics";
import { getDb } from "./db";
import type { SparMessage } from "./spar-claude";
import { BRAIN_ROOT } from "./spar-brain";

/**
 * Batched lookup of topic slugs for a set of message IDs. Returns a
 * Map keyed by message_id with the deduped, alphabetically-sorted
 * slug list. Used by buildTopicAwareWindow to annotate each
 * topic-pulled message inline before handing it to the model
 * (Smart Topic System final pass, Part B #3).
 */
function loadTagsForMessages(messageIds: number[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  if (messageIds.length === 0) return map;
  const db = getDb();
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT smt.message_id AS message_id, t.slug AS slug
         FROM spar_message_topics smt
         JOIN topics t ON t.id = smt.topic_id
        WHERE smt.message_id IN (${placeholders})
        ORDER BY smt.relevance DESC, t.slug ASC`,
    )
    .all(...messageIds) as Array<{ message_id: number; slug: string }>;
  for (const r of rows) {
    const arr = map.get(r.message_id) ?? [];
    if (!arr.includes(r.slug)) arr.push(r.slug);
    map.set(r.message_id, arr);
  }
  return map;
}

// Defaults match the spec; tunable via env without recompile.
const DEFAULT_MAX_MESSAGES = 50;
const TOPIC_PULL_LIMIT = 30;
const RECENT_REFERENCE = 20;
// A topic with very few tagged messages doesn't carry enough signal to
// justify reshaping the window — fall back to recency until it's been
// seen ≥ this many times.
const MIN_TOPIC_MESSAGES = 5;
// Layer 7: total chars of brain-ref text we'll inject per request.
// Hard cap so an over-eager extraction can't blow the context window;
// the reader prefers most-recently-updated sections.
const BRAIN_INJECT_MAX_CHARS = 4000;

export interface BuildTopicAwareWindowInput {
  /** Required to scope topic queries (topics are per-user). */
  userId: number;
  /** Active conversation row id; null = brand-new chat with no DB row
   *  yet, in which case there's nothing to splice. */
  conversationId: number | null;
  /** The fresh user input — used by the cheap matcher. Pass the
   *  natural user content, not any `[system]` injection. */
  currentMessageText: string;
  /** The window the caller would have used without Layer 2. We always
   *  return at least this (potentially trimmed). */
  recentMessages: SparMessage[];
  /** Final cap on output length. Default 50 to match the existing
   *  recency cut. */
  maxMessages?: number;
}

export interface TopicAwareWindow {
  messages: SparMessage[];
  fired: boolean;
  topicSlug: string | null;
  topicMessages: number;
  recencyMessages: number;
  /** Layer 7: pre-formatted block of brain-file sections linked to the
   *  matched topic. Empty string when no refs fired (or the flag was
   *  off). Caller appends to `sparOpts.brain` so it shows up in the
   *  prompt under the BRAIN / MEMORY section. */
  brainBlock: string;
  /** Number of brain refs that produced text. Zero when none fired. */
  brainRefsInjected: number;
  /** Total chars in brainBlock (excluding the framing labels). */
  brainCharsInjected: number;
}

/**
 * Read the SMART_TOPIC_CONTEXT env flag. Default ON; explicit "0" /
 * "false" / "off" disables. Same convention `AMASO_*` flags use
 * elsewhere in the project.
 */
export function smartTopicContextEnabled(): boolean {
  const raw = process.env.SMART_TOPIC_CONTEXT;
  if (raw === undefined || raw === null || raw === "") return true;
  const v = String(raw).trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

/**
 * Layer 7 flag. Independent of SMART_TOPIC_CONTEXT so brain read-back
 * can be cut without killing the topic-aware message window. Default
 * ON, same disable conventions.
 */
export function smartTopicBrainEnabled(): boolean {
  const raw = process.env.SMART_TOPIC_BRAIN;
  if (raw === undefined || raw === null || raw === "") return true;
  const v = String(raw).trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

// ────────────────────────────────────────────────────────────────────
// Layer 7: section extraction helpers
// ────────────────────────────────────────────────────────────────────

function slugifyHeader(h: string): string {
  return h
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Pull a single section out of a markdown body by header slug. Matches
 * any heading level (`#`, `##`, `###`, …); the section ends at the
 * next heading at the same or shallower depth. Returns null when no
 * matching header is found.
 */
export function extractMarkdownSection(
  content: string,
  section: string,
): string | null {
  const target = slugifyHeader(section);
  if (!target) return null;
  const lines = content.split(/\r?\n/);
  let inSection = false;
  let sectionDepth = 0;
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      const depth = m[1].length;
      const headerSlug = slugifyHeader(m[2]);
      if (!inSection) {
        if (headerSlug === target) {
          inSection = true;
          sectionDepth = depth;
          out.push(line);
          continue;
        }
        continue;
      }
      if (depth <= sectionDepth) break;
    }
    if (inSection) out.push(line);
  }
  if (!inSection) return null;
  return out.join("\n").trim();
}

interface ResolvedRef {
  ref: BrainRef;
  body: string;
}

function safeReadBrainFile(filePath: string): string | null {
  try {
    const abs = path.join(BRAIN_ROOT, filePath);
    // Guard against path traversal: the resolved path must still live
    // under BRAIN_ROOT. relative() returns ".." when it escapes.
    const rel = path.relative(BRAIN_ROOT, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function resolveBrainRefs(refs: BrainRef[]): {
  resolved: ResolvedRef[];
  skippedMissingFile: number;
  skippedMissingSection: number;
} {
  const resolved: ResolvedRef[] = [];
  let skippedMissingFile = 0;
  let skippedMissingSection = 0;
  for (const ref of refs) {
    const content = safeReadBrainFile(ref.file_path);
    if (content === null) {
      skippedMissingFile++;
      continue;
    }
    if (ref.section) {
      const section = extractMarkdownSection(content, ref.section);
      if (!section) {
        skippedMissingSection++;
        console.warn(
          `[spar-topic-context] brain ref section not found: ${ref.file_path}#${ref.section}`,
        );
        continue;
      }
      resolved.push({ ref, body: section });
    } else {
      resolved.push({ ref, body: content.trim() });
    }
  }
  return { resolved, skippedMissingFile, skippedMissingSection };
}

/**
 * Format resolved refs into a single block, respecting BRAIN_INJECT_MAX_CHARS.
 * Refs arrive sorted by updated_at DESC (the listBrainRefs default); we
 * keep adding until we'd exceed the cap, then stop. Each section gets
 * a labeled frame so the assistant can attribute the source.
 */
function formatBrainBlock(resolved: ResolvedRef[]): {
  block: string;
  included: number;
  chars: number;
} {
  const parts: string[] = [];
  let chars = 0;
  let included = 0;
  for (const { ref, body } of resolved) {
    const label = ref.section
      ? `${ref.file_path}#${ref.section}`
      : ref.file_path;
    const piece = `=== TOPIC BRAIN: ${label} ===\n${body}\n=== END TOPIC BRAIN: ${label} ===`;
    // Stop when adding the next piece would push us past the cap. Always
    // include the first piece even if it's larger than the cap on its
    // own — the alternative is silently dropping every ref the moment
    // one is oversize.
    if (parts.length > 0 && chars + piece.length > BRAIN_INJECT_MAX_CHARS) break;
    parts.push(piece);
    chars += piece.length;
    included++;
    if (chars >= BRAIN_INJECT_MAX_CHARS) break;
  }
  return { block: parts.join("\n\n"), included, chars };
}

function isCompatibleRole(role: string): role is "user" | "assistant" {
  return role === "user" || role === "assistant";
}

function dedupeKey(role: string, content: string): string {
  return `${role}::${content.trim()}`;
}

/**
 * Sync. Returns a (possibly augmented) message array in the same shape
 * the caller already passes to `streamFromClaudeCli` / Gemini. On any
 * error or miss, returns recentMessages trimmed to maxMessages.
 */
export function buildTopicAwareWindow(
  input: BuildTopicAwareWindowInput,
): TopicAwareWindow {
  const max = Math.max(1, input.maxMessages ?? DEFAULT_MAX_MESSAGES);
  const baseline: TopicAwareWindow = {
    messages: input.recentMessages.slice(-max),
    fired: false,
    topicSlug: null,
    topicMessages: 0,
    recencyMessages: input.recentMessages.length,
    brainBlock: "",
    brainRefsInjected: 0,
    brainCharsInjected: 0,
  };

  try {
    if (input.conversationId === null || input.conversationId === undefined) {
      return baseline;
    }
    if (!input.currentMessageText || !input.currentMessageText.trim()) {
      return baseline;
    }

    const detection = cheapDetectTopic(input.currentMessageText, input.userId);
    if (!detection) return baseline;

    const tagged = listMessagesForTopic(detection.topicId, {
      limit: TOPIC_PULL_LIMIT,
    });
    if (tagged.length < MIN_TOPIC_MESSAGES) return baseline;

    // Build a (role,content)-set from the latest slice of the recency
    // window so we don't double-include messages the client already
    // sent us.
    const seen = new Set<string>();
    const recentTail = input.recentMessages.slice(-RECENT_REFERENCE);
    for (const m of recentTail) seen.add(dedupeKey(m.role, m.content));

    // listMessagesForTopic returns DESC; reverse for chronological
    // order, then drop dupes against the recency tail and any
    // non-user/assistant rows (system messages stay out of the LLM
    // history shape).
    //
    // Final pass / Part B #3: annotate each topic-pulled message with
    // its full set of topic slugs inline so the model sees the thread
    // labels alongside the body, e.g. `[topics: hyet-pricing, woonklasse] message text`.
    // Compact, scannable, no JSON. Tags come from a single batched
    // join — no N+1.
    const chronological = tagged.slice().reverse();
    const candidateIds: number[] = [];
    for (const row of chronological) {
      if (!isCompatibleRole(row.role)) continue;
      const key = dedupeKey(row.role, row.content);
      if (seen.has(key)) continue;
      candidateIds.push(row.id);
    }
    const tagsByMessage = candidateIds.length > 0
      ? loadTagsForMessages(candidateIds)
      : new Map<number, string[]>();

    const topicOnly: SparMessage[] = [];
    for (const row of chronological) {
      if (!isCompatibleRole(row.role)) continue;
      const key = dedupeKey(row.role, row.content);
      if (seen.has(key)) continue;
      seen.add(key);
      const slugs = tagsByMessage.get(row.id) ?? [];
      const annotated = slugs.length > 0
        ? `[topics: ${slugs.join(", ")}] ${row.content}`
        : row.content;
      topicOnly.push({ role: row.role, content: annotated });
    }

    if (topicOnly.length === 0) return baseline;

    // Older topic messages first, then the caller's recency (which
    // already ends with the live system-injection if any). Trim to
    // the cap, keeping the newest tail.
    const merged: SparMessage[] = [...topicOnly, ...input.recentMessages];
    const out = merged.slice(-max);

    const topic = getTopicById(detection.topicId);
    const recencyKept = Math.min(input.recentMessages.length, max);

    // Layer 7: pull brain refs for this topic and assemble an injectable
    // block. Skipped entirely when the flag is off, when the topic has
    // no refs, or when nothing resolved (missing files / sections).
    let brainBlock = "";
    let brainRefsInjected = 0;
    let brainCharsInjected = 0;
    if (smartTopicBrainEnabled()) {
      try {
        const refs = listBrainRefs(detection.topicId);
        if (refs.length > 0) {
          const { resolved } = resolveBrainRefs(refs);
          if (resolved.length > 0) {
            const formatted = formatBrainBlock(resolved);
            brainBlock = formatted.block;
            brainRefsInjected = formatted.included;
            brainCharsInjected = formatted.chars;
          }
        }
      } catch (err) {
        console.warn(
          "[spar-topic-context] brain-ref read failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return {
      messages: out,
      fired: true,
      topicSlug: topic?.slug ?? null,
      topicMessages: topicOnly.length,
      recencyMessages: recencyKept,
      brainBlock,
      brainRefsInjected,
      brainCharsInjected,
    };
  } catch (err) {
    console.warn(
      "[spar-topic-context] buildTopicAwareWindow failed:",
      err instanceof Error ? err.message : String(err),
    );
    return baseline;
  }
}
