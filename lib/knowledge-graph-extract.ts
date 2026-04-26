import { collectFromClaudeCli } from "./spar-claude";
import {
  ENTITY_TYPES,
  upsertEntity,
  upsertRelationship,
  type Confidence,
  type EntityType,
} from "./knowledge-graph";

/**
 * LLM-backed extractor that turns one (userText, assistantText) turn
 * into entity upserts + relationships and persists them.
 *
 * Runs through the same Claude CLI as the chat itself — no separate
 * API key, uses the user's existing login. One-shot (no streaming).
 *
 * Conservative by design: better to miss a fact than to invent one.
 * The extractor prompt is explicit about this; the runtime adds a
 * defensive parser + per-entity validation so a malformed item
 * dropping the whole batch never happens.
 */

const EXTRACTOR_MODEL = process.env.AMASO_FACT_EXTRACTOR_MODEL || "haiku";

interface ExtractedEntity {
  type: EntityType;
  name: string;
  properties?: Record<string, unknown>;
  confidence?: Confidence;
  sourceExcerpt?: string | null;
  /** When true, the extractor signalled the user is correcting a
   *  prior fact — we replace properties wholesale rather than merge. */
  replaceProperties?: boolean;
  /** Stable temp-id used to wire relationships in this same batch.
   *  Resolved against entity-record ids after upsert below. */
  tempId?: string;
}

interface ExtractedRelationship {
  /** May reference either a tempId from the same batch or a stable
   *  `type:name` token (e.g. `person:Sander`). */
  from: string;
  to: string;
  type: string;
  confidence?: Confidence;
}

export interface ExtractOptions {
  /** When true, every extracted entity is bumped to "corrected"
   *  confidence regardless of what the LLM returned. The Spar client
   *  / route handler sets this when the user-turn matches a
   *  correction-shaped regex ("no, do it like this", "remember"). */
  isCorrection?: boolean;
  model?: string;
  signal?: AbortSignal;
}

const VALID_CONFIDENCE: Confidence[] = ["explicit", "inferred", "corrected"];

const EXTRACTION_SYSTEM_PROMPT = `You are the memory extractor for a personal AI assistant. Read ONE conversation turn and emit a strict-JSON object describing entities and relationships worth remembering across future conversations.

Output STRICT JSON. NOTHING ELSE. No prose, no markdown fences, no commentary. If there is nothing to extract, output {"entities": [], "relationships": []}.

Schema:
{
  "entities": [
    {
      "tempId": string,                      // unique within this batch, used by relationships below
      "type": "person" | "preference" | "routine" | "tool" | "decision" | "solution" | "project" | "concept",
      "name": string,                        // canonical name; "Sander", "Whisper Writer", "morning briefing"
      "properties": { /* free-form key/value */ },
      "confidence": "explicit" | "inferred" | "corrected",
      "replaceProperties": optional boolean, // true when the user CORRECTED a prior fact (overwrite vs merge)
      "sourceExcerpt": optional string       // short verbatim quote from the user turn
    }
  ],
  "relationships": [
    { "from": string, "to": string, "type": string, "confidence": "explicit"|"inferred"|"corrected" }
    // from/to are tempIds from this batch (or "type:Name" tokens for entities you didn't add this turn)
    // type is a short verb phrase: "uses", "worksOn", "prefers", "solves", "scheduledFor"
  ]
}

Property conventions per type (extend as needed — these are hints, not a closed list):
  person:      role, wakeUp, location, communicationStyle, ...
  preference:  description (one line stating the preference)
  routine:     time, days, description
  tool:        purpose, hotkey, location
  decision:    chose, over, reasoning, date
  solution:    problem (REQUIRED), failedApproaches (string[]), workingSolution (REQUIRED), resolved (ISO date string), tags
  project:     status, role, description
  concept:     definition

SOLUTION RULE: when the user describes a problem they finally figured out, ALWAYS extract it as a solution entity — including the failed approaches if mentioned ("we tried X and Y, then Z worked"). These are the highest-value memories. A user saying "the fix was to flush the queue first" alone, with no prior problem context, is also a solution; infer the problem from the surrounding turn.

Confidence rules:
  explicit  — user stated it directly ("my name is Sander")
  inferred  — you deduced it from context
  corrected — user is fixing a prior fact ("actually I wake up at 9, not 8")

Conservative extraction:
  - DO NOT extract ephemeral mood, hypothetical scenarios, or one-off observations.
  - DO NOT extract general world knowledge ("Next.js is a React framework").
  - DO NOT invent properties the user didn't actually mention.
  - When in doubt, omit.

Example input
User: "Actually I wake up at 9, not 8:30 — and remember my plumber Jaap is coming Tuesday."
Assistant: "Got it, updated."

Example output
{
  "entities": [
    {
      "tempId": "user",
      "type": "person",
      "name": "user",
      "properties": { "wakeUp": "09:00" },
      "confidence": "corrected",
      "replaceProperties": false,
      "sourceExcerpt": "Actually I wake up at 9, not 8:30"
    },
    {
      "tempId": "jaap",
      "type": "person",
      "name": "Jaap",
      "properties": { "role": "plumber" },
      "confidence": "explicit",
      "sourceExcerpt": "remember my plumber Jaap"
    },
    {
      "tempId": "plumber-visit",
      "type": "decision",
      "name": "plumber visit Tuesday",
      "properties": { "date": "Tuesday", "kind": "appointment" },
      "confidence": "explicit",
      "sourceExcerpt": "is coming Tuesday"
    }
  ],
  "relationships": [
    { "from": "user", "to": "jaap", "type": "knows", "confidence": "explicit" },
    { "from": "jaap", "to": "plumber-visit", "type": "scheduledFor", "confidence": "explicit" }
  ]
}`;

function buildUserPrompt(userText: string, assistantText: string): string {
  const u = userText.trim() || "(empty)";
  const a = assistantText.trim() || "(empty)";
  return [
    "Extract memory facts from this turn.",
    "",
    "User turn:",
    u,
    "",
    "Assistant turn:",
    a,
    "",
    "Output only the JSON object.",
  ].join("\n");
}

/** Lenient JSON-object parser. Returns null when no recoverable
 *  object is found. Same idea as the array parser used previously
 *  but for the new {entities, relationships} top-level shape. */
function parseObjectLoose(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through */
  }
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inStr) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function coerceEntity(raw: unknown): ExtractedEntity | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : "";
  if (!ENTITY_TYPES.includes(type as EntityType)) return null;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return null;
  const confidence: Confidence = VALID_CONFIDENCE.includes(
    o.confidence as Confidence,
  )
    ? (o.confidence as Confidence)
    : "inferred";
  const properties =
    o.properties && typeof o.properties === "object"
      ? (o.properties as Record<string, unknown>)
      : {};
  const sourceExcerpt =
    typeof o.sourceExcerpt === "string" && o.sourceExcerpt.trim().length > 0
      ? o.sourceExcerpt.trim().slice(0, 240)
      : null;
  const tempId =
    typeof o.tempId === "string" && o.tempId.length > 0 ? o.tempId : undefined;
  const replaceProperties = o.replaceProperties === true;
  return {
    type: type as EntityType,
    name,
    properties,
    confidence,
    sourceExcerpt,
    tempId,
    replaceProperties,
  };
}

function coerceRelationship(raw: unknown): ExtractedRelationship | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const from = typeof o.from === "string" ? o.from.trim() : "";
  const to = typeof o.to === "string" ? o.to.trim() : "";
  const type = typeof o.type === "string" ? o.type.trim() : "";
  if (!from || !to || !type) return null;
  const confidence: Confidence = VALID_CONFIDENCE.includes(
    o.confidence as Confidence,
  )
    ? (o.confidence as Confidence)
    : "inferred";
  return { from, to, type, confidence };
}

/**
 * Run the extractor on one turn and persist the resulting graph
 * delta. Never throws — failures are logged + swallowed so a broken
 * CLI can't break the chat loop.
 */
export async function extractGraphFromTurn(
  userId: number,
  userText: string,
  assistantText: string,
  opts: ExtractOptions = {},
): Promise<{ entityCount: number; relCount: number }> {
  const u = (userText ?? "").trim();
  const a = (assistantText ?? "").trim();
  // Skip the synthetic kickoff turn (server injects "[kickoff] …" as
  // a fake user turn to prompt the assistant's opener) and very
  // short noise turns that won't yield anything but cost a CLI call.
  if (!u || u.startsWith("[kickoff]")) return { entityCount: 0, relCount: 0 };
  if (u.length < 3 && a.length < 3) return { entityCount: 0, relCount: 0 };

  let cliOutput = "";
  try {
    cliOutput = await collectFromClaudeCli({
      systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      heartbeat: "",
      history: [{ role: "user", content: buildUserPrompt(u, a) }],
      model: opts.model ?? EXTRACTOR_MODEL,
      signal: opts.signal,
    });
  } catch (err) {
    console.warn(
      "[knowledge-graph-extract] CLI failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { entityCount: 0, relCount: 0 };
  }

  const parsed = parseObjectLoose(cliOutput);
  if (!parsed || typeof parsed !== "object") {
    return { entityCount: 0, relCount: 0 };
  }
  const obj = parsed as Record<string, unknown>;
  const rawEntities = Array.isArray(obj.entities) ? obj.entities : [];
  const rawRels = Array.isArray(obj.relationships) ? obj.relationships : [];

  // Phase 1: upsert entities, building a tempId → entity-id map for
  // the relationship phase below. We also key by `${type}:${normName}`
  // so relationships referencing entities by stable token still
  // resolve.
  const idMap = new Map<string, string>();
  let entityCount = 0;
  for (const raw of rawEntities) {
    const cand = coerceEntity(raw);
    if (!cand) continue;
    // isCorrection (server-detected correction-shaped phrasing)
    // overrides the LLM's confidence — we trust the regex more than
    // the model when it comes to "is this a correction".
    const conf: Confidence = opts.isCorrection ? "corrected" : cand.confidence ?? "inferred";
    const replaceProperties =
      cand.replaceProperties || opts.isCorrection || conf === "corrected";
    try {
      const entity = await upsertEntity(userId, {
        type: cand.type,
        name: cand.name,
        properties: cand.properties,
        confidence: conf,
        sourceExcerpt: cand.sourceExcerpt,
        replaceProperties,
      });
      entityCount += 1;
      if (cand.tempId) idMap.set(cand.tempId, entity.id);
      // Stable token resolution path: relationships sometimes
      // reference entities they didn't add this turn, by the
      // type:Name token. Map those too.
      idMap.set(`${cand.type}:${cand.name.trim().toLowerCase()}`, entity.id);
    } catch (err) {
      console.warn(
        "[knowledge-graph-extract] upsertEntity failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Phase 2: upsert relationships. Both endpoints must resolve;
  // unresolved tokens are dropped silently — the LLM occasionally
  // hallucinates references to entities it didn't actually emit.
  let relCount = 0;
  for (const raw of rawRels) {
    const cand = coerceRelationship(raw);
    if (!cand) continue;
    const fromId = resolveRef(cand.from, idMap);
    const toId = resolveRef(cand.to, idMap);
    if (!fromId || !toId) continue;
    if (fromId === toId) continue; // no self-edges; usually a model glitch
    const conf: Confidence = opts.isCorrection ? "corrected" : cand.confidence ?? "inferred";
    try {
      const rel = await upsertRelationship(userId, {
        fromId,
        toId,
        type: cand.type,
        confidence: conf,
      });
      if (rel) relCount += 1;
    } catch (err) {
      console.warn(
        "[knowledge-graph-extract] upsertRelationship failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { entityCount, relCount };
}

function resolveRef(token: string, idMap: Map<string, string>): string | null {
  // Direct tempId match.
  const direct = idMap.get(token);
  if (direct) return direct;
  // Try as a `type:Name` token (case-insensitive on name).
  const idx = token.indexOf(":");
  if (idx > 0) {
    const t = token.slice(0, idx).trim().toLowerCase();
    const n = token.slice(idx + 1).trim().toLowerCase();
    return idMap.get(`${t}:${n}`) ?? null;
  }
  return null;
}

/** Shared correction-detection regex. Conservative: false positives
 *  bump confidence one notch (harmless), false negatives just leave
 *  the LLM's own classification in place. */
const CORRECTION_PATTERNS: RegExp[] = [
  /\b(?:no|nope|don'?t|never|stop)\b.{0,40}\b(?:do|say|call|answer|reply|format|use|include)\b/i,
  /\b(?:from now on|going forward|in future)\b/i,
  /\b(?:remember|make sure|please note)\s+(?:that|to)\b/i,
  /\b(?:actually|in fact|correction)\b/i,
  /\b(?:instead of|rather than)\b/i,
];

export function detectCorrectionLike(userText: string): boolean {
  const s = userText.trim();
  if (!s) return false;
  return CORRECTION_PATTERNS.some((r) => r.test(s));
}
