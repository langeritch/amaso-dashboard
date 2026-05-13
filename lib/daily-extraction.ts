/**
 * Smart Topic System — Layer 4: post-day fact extraction.
 *
 * Reads a user's full daily-chat transcript for a given local date,
 * dispatches it to Claude Haiku with a tight extraction prompt, parses
 * the strict-JSON response, and routes each extracted fact into the
 * correct brain file (per the Write-back Protocol in
 * <BRAIN_ROOT>/brain.md). Every write is read-modify-write under a
 * named H2 section, idempotent on fact-content fingerprints, and
 * accompanied by an HTML-comment citation that traces the fact back
 * to its source spar_messages rows.
 *
 * Status is persisted in the daily_extractions table (one row per
 * user+date). Re-running with --force overwrites the row and re-checks
 * each fact against the (possibly already-extracted) brain files; the
 * fingerprint guard means duplicate writes are silent no-ops.
 *
 * The Anthropic call is injected via the `extractor` argument so tests
 * can stub it. Production defaults to a direct @anthropic-ai/sdk call
 * — the SDK is already in deps via lib/spar-sdk.ts; this module adds
 * no new dependencies.
 */

import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./db";
import { BRAIN_ROOT, slugifyUser } from "./spar-brain";
import { todayLocalDate, formatLocalDate } from "./local-date";
import { collectFromClaudeCli } from "./spar-claude";
import type { User } from "./db";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type Classification =
  | "identity"
  | "psychology"
  | "preferences"
  | "calendar"
  | "projects"
  | "decisions"
  | "lessons"
  | "goals"
  | "timeline"
  | "people"
  | "daily-log-summary";

export const VALID_CLASSIFICATIONS: ReadonlySet<Classification> = new Set([
  "identity",
  "psychology",
  "preferences",
  "calendar",
  "projects",
  "decisions",
  "lessons",
  "goals",
  "timeline",
  "people",
  "daily-log-summary",
]);

export interface ExtractedFact {
  fact: string;
  classification: Classification;
  brain_file: string;
  section: string;
  source_message_ids: number[];
}

export interface ExtractionResult {
  status: "success" | "failed" | "skipped";
  userId: number;
  date: string;
  factCount: number;
  classifications: Record<string, number>;
  filesWritten: string[];
  factsSkippedDuplicate: number;
  factsRejected: number;
  errorText: string | null;
  rawResponse?: string;
}

export interface ExtractionOptions {
  userId: number;
  /** YYYY-MM-DD in Europe/Amsterdam. Defaults to yesterday. */
  date?: string;
  /** Re-run even if a success row already exists. */
  force?: boolean;
  /** When true, run the full pipeline EXCEPT brain-file + daily_extractions
   *  writes. Useful for sanity-checking the prompt + parser. */
  dryRun?: boolean;
  /** Override the LLM call. Tests inject a deterministic stub here. */
  extractor?: ExtractorFn;
  /** Logger sink. Defaults to console + logs/daily-extractions.log. */
  logger?: (line: string) => void;
  /** Override the on-disk brain root. Default = BRAIN_ROOT from
   *  lib/spar-brain (the user's real memory tree). Tests pass a
   *  per-test tmp dir so writes don't bleed into production. */
  brainRoot?: string;
}

/** The pluggable LLM call: takes a prompt, returns the raw assistant text. */
export type ExtractorFn = (input: {
  systemPrompt: string;
  userPrompt: string;
}) => Promise<string>;

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

const HAIKU_MODEL =
  process.env.AMASO_EXTRACTION_MODEL || "claude-haiku-4-5-20251001";

/**
 * The extractor system prompt. Baked in: the file-scope rules from
 * brain.md (per-user vs global) and the strict-JSON output contract.
 * Kept verbose because Haiku does better with explicit instructions
 * than with hints.
 */
function buildSystemPrompt(slug: string, date: string): string {
  return [
    "You extract DURABLE FACTS from one day of a personal AI assistant chat transcript.",
    "Durable means it will still matter a week from now: identity reveals, preferences, decisions made, lessons learned, project status changes, goals set or shifted, people mentioned with context, calendar items, and a 1-3 sentence overall day summary.",
    "Skip ephemeral chatter (greetings, acknowledgements, single-turn questions, dispatches with no outcome, jokes).",
    "",
    "Classify every fact into exactly one of:",
    "  identity, psychology, preferences, calendar, projects, decisions, lessons, goals, timeline, people, daily-log-summary",
    "",
    "File scope rules (from brain.md):",
    "  - If a fact could change how I treat one specific person, it is per-user → brain_file under users/<slug>/.",
    "  - If a fact is about work, projects, shared knowledge, or shared events, it is global → brain_file at the repo root.",
    "  - Today's date for this transcript is " + date + " (Europe/Amsterdam).",
    "",
    "Route each classification to its brain file:",
    "  identity           → users/" + slug + "/profile.md       section \"Identity\"",
    "  psychology         → users/" + slug + "/profile.md       section \"Psychology\"",
    "  preferences        → users/" + slug + "/preferences.md   section pick the most fitting H2 in the file or propose one (e.g. \"Communication\", \"Workflow\", \"Food\", \"Music\")",
    "  calendar           → users/" + slug + "/calendar.md      section \"Upcoming\" or \"Birthdays\"",
    "  projects           → projects.md                          section is the project name as H2 (existing or new)",
    "  decisions          → decisions.md                         section is a short H2 verb-noun for the decision (e.g. \"Switched auth to Clerk\")",
    "  lessons            → lessons.md                           section is a short H2 verb-noun for the lesson",
    "  goals              → goals.md                             section one of \"This week\", \"This quarter\", \"This year+\"",
    "  timeline           → timeline.md                          section is the month as H2 (e.g. \"2026-05\")",
    "  people             → people.md                            section is the person's name as H2",
    "  daily-log-summary  → users/" + slug + "/daily/" + date + ".md  section one of \"Shipped\", \"Built\", \"Decisions\", \"Conversations\", \"Open Loops\", \"Energy\"",
    "",
    "Output contract: return STRICT JSON — an array (possibly empty) of objects with EXACTLY these keys:",
    "  fact                — one sentence, present tense, no quotes around it",
    "  classification      — one of the eleven values above",
    "  brain_file          — one of the eleven file paths above",
    "  section             — H2 heading text WITHOUT the leading \"## \"",
    "  source_message_ids  — array of spar_messages.id values that this fact came from (numeric)",
    "",
    "Do not wrap the JSON in prose. Do not use markdown code fences. The first character must be `[` and the last must be `]`. If there is nothing durable to extract, return `[]`.",
  ].join("\n");
}

interface DayMessage {
  id: number;
  role: string;
  content: string;
  created_at: number;
}

function buildUserPrompt(messages: DayMessage[]): string {
  const lines: string[] = [
    "Transcript follows. Each line is `[id|role|HH:MM] content`.",
    "",
  ];
  for (const m of messages) {
    const hh = new Date(m.created_at).toLocaleTimeString("nl-NL", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Amsterdam",
    });
    // Cap individual messages so a single long dump can't blow the
    // context budget. 1200 chars is generous for human-shaped turns
    // and still keeps a full chatty day under Haiku's context cap.
    const body = m.content.length > 1200
      ? m.content.slice(0, 1200) + " …[truncated]"
      : m.content;
    lines.push(`[${m.id}|${m.role}|${hh}] ${body.replace(/\s+/g, " ").trim()}`);
  }
  lines.push("");
  lines.push("Extract durable facts now. Output strict JSON.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadDayMessages(userId: number, date: string): DayMessage[] {
  const db = getDb();
  const convIds = db
    .prepare(
      `SELECT DISTINCT conversation_id FROM daily_chats WHERE user_id = ? AND date_local = ?`,
    )
    .all(userId, date) as Array<{ conversation_id: number }>;
  if (convIds.length === 0) return [];
  const placeholders = convIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, role, content, created_at
         FROM spar_messages
        WHERE conversation_id IN (${placeholders})
          AND role IN ('user','assistant')
        ORDER BY created_at ASC, id ASC`,
    )
    .all(...convIds.map((r) => r.conversation_id)) as DayMessage[];
  return rows;
}

function getUser(userId: number): User | null {
  const db = getDb();
  const row = db
    .prepare("SELECT id, email, name, role, created_at FROM users WHERE id = ?")
    .get(userId) as User | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Brain-file write surface
// ---------------------------------------------------------------------------

/** Build the per-user allowlist of writable brain files. Keep tight to
 *  prevent the model from hallucinating a path that escapes the user's
 *  private dir or writes to an arbitrary file. */
function buildAllowlist(slug: string, date: string): Set<string> {
  return new Set([
    `users/${slug}/profile.md`,
    `users/${slug}/preferences.md`,
    `users/${slug}/calendar.md`,
    `users/${slug}/daily/${date}.md`,
    "projects.md",
    "decisions.md",
    "lessons.md",
    "goals.md",
    "timeline.md",
    "people.md",
  ]);
}

/** Resolve a relative brain-file path to an absolute path, refusing
 *  anything that escapes the supplied brain root or that the allowlist
 *  doesn't cover. Returns null on rejection so the caller can log + skip. */
function resolveBrainPath(
  rel: string,
  allowlist: Set<string>,
  brainRoot: string,
): string | null {
  if (!allowlist.has(rel)) return null;
  if (path.isAbsolute(rel)) return null;
  const normalised = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs = path.resolve(brainRoot, normalised);
  const rootWithSep = brainRoot.endsWith(path.sep)
    ? brainRoot
    : brainRoot + path.sep;
  if (abs !== brainRoot && !abs.startsWith(rootWithSep)) return null;
  return abs;
}

/** Idempotency fingerprint: collapse whitespace, take first 60 chars of
 *  the fact body. A fact whose fingerprint already exists in the file
 *  is treated as already-written. */
function fingerprint(fact: string): string {
  return fact.replace(/\s+/g, " ").trim().slice(0, 60).toLowerCase();
}

interface AppendResult {
  written: boolean;
  reason?: "duplicate" | "wrote";
}

/**
 * Append `fact` under H2 heading `section` in the file at `abs`. If the
 * section doesn't exist, a fresh H2 is appended at the end of the file.
 * If the file doesn't exist, it's created with a minimal header.
 * Citations are written on the line directly below the fact body.
 *
 * Idempotent: if the fact's fingerprint is already anywhere in the
 * file, returns { written: false, reason: "duplicate" } and no I/O.
 */
async function appendFactToSection(args: {
  abs: string;
  section: string;
  fact: string;
  citation: string;
}): Promise<AppendResult> {
  const { abs, section, fact, citation } = args;
  let current = "";
  try {
    current = await fs.readFile(abs, "utf8");
  } catch {
    current = "";
  }

  const fp = fingerprint(fact);
  if (fp && current.toLowerCase().includes(fp)) {
    return { written: false, reason: "duplicate" };
  }

  const factBody = fact.trim();
  const entryLines = [`- ${factBody}`, `  ${citation}`];

  let next: string;
  if (!current.trim()) {
    // Fresh file: write a minimal header + the section.
    const fileName = path.basename(abs).replace(/\.md$/, "");
    next = `# ${fileName}\n\n## ${section}\n${entryLines.join("\n")}\n`;
  } else {
    const headingPattern = new RegExp(
      `^##\\s+${escapeRegex(section)}\\s*$`,
      "im",
    );
    const match = current.match(headingPattern);
    if (match && typeof match.index === "number") {
      // Insert below the matched H2 but BEFORE the next H2 (or EOF).
      const headingStart = match.index;
      const headingEnd = headingStart + match[0].length;
      // Find the next H2 (or end of file).
      const after = current.slice(headingEnd);
      const nextHeadingRel = after.search(/^##\s+/m);
      const sectionEnd =
        nextHeadingRel < 0 ? current.length : headingEnd + nextHeadingRel;
      const sectionBody = current.slice(headingEnd, sectionEnd).trimEnd();
      const insertion = `${sectionBody}\n${entryLines.join("\n")}\n`;
      next =
        current.slice(0, headingEnd) +
        "\n" +
        insertion.replace(/^\n+/, "") +
        (sectionEnd < current.length ? "\n" + current.slice(sectionEnd).replace(/^\n+/, "") : "");
    } else {
      // No matching H2: append a fresh one at the end.
      next =
        current.trimEnd() +
        `\n\n## ${section}\n${entryLines.join("\n")}\n`;
    }
  }

  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, next, "utf8");
  return { written: true, reason: "wrote" };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// JSON parsing + validation
// ---------------------------------------------------------------------------

interface ParseOutcome {
  facts: ExtractedFact[];
  rejected: number;
  error: string | null;
}

export function parseExtractorResponse(
  raw: string,
  allowlist: Set<string>,
): ParseOutcome {
  const trimmed = raw.trim();
  if (!trimmed) return { facts: [], rejected: 0, error: "empty response" };

  // Try direct JSON first, then code-fenced, then first [...] block.
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  const arr = trimmed.match(/\[[\s\S]*\]/);
  if (arr) candidates.push(arr[0]);

  let parsed: unknown = null;
  let parseErr: string | null = null;
  for (const c of candidates) {
    try {
      parsed = JSON.parse(c);
      parseErr = null;
      break;
    } catch (e) {
      parseErr = e instanceof Error ? e.message : String(e);
    }
  }
  if (parsed === null || !Array.isArray(parsed)) {
    return {
      facts: [],
      rejected: 0,
      error: `not a JSON array: ${parseErr ?? "unknown"}`,
    };
  }

  const facts: ExtractedFact[] = [];
  let rejected = 0;
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      rejected++;
      continue;
    }
    const obj = item as Record<string, unknown>;
    const fact = typeof obj.fact === "string" ? obj.fact.trim() : "";
    const classification =
      typeof obj.classification === "string" ? obj.classification.trim() : "";
    const brain_file =
      typeof obj.brain_file === "string" ? obj.brain_file.trim() : "";
    const section = typeof obj.section === "string" ? obj.section.trim() : "";
    const ids = Array.isArray(obj.source_message_ids)
      ? obj.source_message_ids
          .map((n) => (typeof n === "number" ? n : Number(n)))
          .filter((n) => Number.isFinite(n) && n > 0)
      : [];
    if (
      !fact ||
      !classification ||
      !VALID_CLASSIFICATIONS.has(classification as Classification) ||
      !brain_file ||
      !allowlist.has(brain_file) ||
      !section
    ) {
      rejected++;
      continue;
    }
    facts.push({
      fact,
      classification: classification as Classification,
      brain_file,
      section,
      source_message_ids: ids,
    });
  }
  return { facts, rejected, error: null };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_PATH = path.join(LOG_DIR, "daily-extractions.log");

async function logLine(text: string, sink?: (line: string) => void): Promise<void> {
  const stamped = `${new Date().toISOString()} ${text}`;
  if (sink) {
    sink(stamped);
    return;
  }
  console.log(stamped);
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(LOG_PATH, stamped + "\n", "utf8");
  } catch {
    /* logging is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Default Anthropic extractor
// ---------------------------------------------------------------------------

/**
 * Pick the production extractor based on what's wired:
 *   - If an Anthropic API key is set in the environment, use the SDK
 *     for a direct one-shot call (cheaper, no subprocess overhead).
 *   - Otherwise fall back to the local Claude CLI via the same
 *     `collectFromClaudeCli` shim that `lib/spar-subjects.ts` uses —
 *     this is the path Santi's install actually runs on today,
 *     authenticated through ~/.claude.
 * Neither path adds a new SDK dependency; the Anthropic package is
 * already used by lib/spar-sdk.ts and the CLI is the existing spar
 * backend.
 */
function defaultExtractor(): ExtractorFn {
  const apiKey =
    process.env.AMASO_SPAR_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    const client = new Anthropic({ apiKey });
    return async ({ systemPrompt, userPrompt }) => {
      const resp = await client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      });
      let out = "";
      for (const b of resp.content) {
        if (b.type === "text") out += b.text;
      }
      return out;
    };
  }
  // CLI fallback. `collectFromClaudeCli` runs the user's installed
  // Claude CLI under ~/.claude (or the AMASO_CLAUDE_CMD override) so
  // it works wherever spar already works. The CLI accepts model alias
  // strings ("haiku" / "sonnet" / "opus") OR full ids; pass haiku
  // since the prompt is bounded and JSON-shaped.
  return async ({ systemPrompt, userPrompt }) => {
    return await collectFromClaudeCli({
      systemPrompt,
      heartbeat: "",
      history: [{ role: "user", content: userPrompt }],
      model: "haiku",
      maxTurns: 1,
    });
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** DB row status — wider than ExtractionResult["status"] because the
 *  audit row also captures the "pending" mid-run state. */
type ExtractionRowStatus = "pending" | "success" | "failed" | "skipped";

interface PersistInput {
  userId: number;
  date: string;
  runAt: number;
  status: ExtractionRowStatus;
  factCount: number;
  classifications: Record<string, number>;
  sourceMessageIds: number[];
  errorText: string | null;
}

function persistExtraction(input: PersistInput): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO daily_extractions
       (user_id, date, run_at, status, fact_count, classifications_json, source_message_ids, error_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, date) DO UPDATE SET
       run_at               = excluded.run_at,
       status               = excluded.status,
       fact_count           = excluded.fact_count,
       classifications_json = excluded.classifications_json,
       source_message_ids   = excluded.source_message_ids,
       error_text           = excluded.error_text`,
  ).run(
    input.userId,
    input.date,
    input.runAt,
    input.status,
    input.factCount,
    JSON.stringify(input.classifications),
    JSON.stringify(input.sourceMessageIds),
    input.errorText,
  );
}

function existingSuccessful(userId: number, date: string): boolean {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT status FROM daily_extractions WHERE user_id = ? AND date = ?",
    )
    .get(userId, date) as { status: string } | undefined;
  return row?.status === "success";
}

/**
 * Fetch the parent daily_extractions.id for a given (user, date). Used
 * by the per-fact persistence path to link extracted_facts rows.
 * Returns null if no row exists yet (which shouldn't happen — the
 * parent is upserted to status='pending' before facts are processed).
 */
function getExtractionId(userId: number, date: string): number | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT id FROM daily_extractions WHERE user_id = ? AND date = ?",
    )
    .get(userId, date) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Replace the extracted_facts rows for one extraction. Called once per
 * successful run, AFTER brain-file writes complete, so a partial
 * run doesn't leave stale rows in the child table. We use DELETE +
 * INSERT (not ON CONFLICT) because facts have no natural unique key
 * other than their full body, and re-extraction can produce a
 * different shape entirely.
 */
function persistFactRows(args: {
  extractionId: number;
  userId: number;
  date: string;
  facts: ExtractedFact[];
}): void {
  const db = getDb();
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      "DELETE FROM extracted_facts WHERE extraction_id = ?",
    ).run(args.extractionId);
    const ins = db.prepare(
      `INSERT INTO extracted_facts
         (extraction_id, user_id, date, fact, classification, brain_file, section, source_message_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const f of args.facts) {
      ins.run(
        args.extractionId,
        args.userId,
        args.date,
        f.fact,
        f.classification,
        f.brain_file,
        f.section,
        JSON.stringify(f.source_message_ids ?? []),
        now,
      );
    }
  })();
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function extractDailyFacts(
  opts: ExtractionOptions,
): Promise<ExtractionResult> {
  const date = opts.date ?? yesterdayLocalDate();
  const user = getUser(opts.userId);
  if (!user) {
    throw new Error(`no such user: ${opts.userId}`);
  }
  const slug = slugifyUser(user.name);
  const dryRun = !!opts.dryRun;
  const force = !!opts.force;
  const brainRoot = opts.brainRoot ?? BRAIN_ROOT;
  const log = (line: string) => logLine(line, opts.logger);

  await log(
    `[extract] start user=${opts.userId}(${user.name}) date=${date} force=${force} dryRun=${dryRun}`,
  );

  // Idempotency gate
  if (!force && !dryRun && existingSuccessful(opts.userId, date)) {
    await log(
      `[extract] already extracted user=${opts.userId} date=${date} — skipping`,
    );
    return {
      status: "skipped",
      userId: opts.userId,
      date,
      factCount: 0,
      classifications: {},
      filesWritten: [],
      factsSkippedDuplicate: 0,
      factsRejected: 0,
      errorText: null,
    };
  }

  const messages = loadDayMessages(opts.userId, date);
  if (messages.length === 0) {
    await log(
      `[extract] no messages for user=${opts.userId} date=${date} — skipping`,
    );
    if (!dryRun) {
      persistExtraction({
        userId: opts.userId,
        date,
        runAt: Date.now(),
        status: "skipped",
        factCount: 0,
        classifications: {},
        sourceMessageIds: [],
        errorText: "no messages for date",
      });
    }
    return {
      status: "skipped",
      userId: opts.userId,
      date,
      factCount: 0,
      classifications: {},
      filesWritten: [],
      factsSkippedDuplicate: 0,
      factsRejected: 0,
      errorText: "no messages for date",
    };
  }

  // Mark pending so a crashed run leaves an audit trail.
  if (!dryRun) {
    persistExtraction({
      userId: opts.userId,
      date,
      runAt: Date.now(),
      status: "pending",
      factCount: 0,
      classifications: {},
      sourceMessageIds: messages.map((m) => m.id),
      errorText: null,
    });
  }

  const allowlist = buildAllowlist(slug, date);
  const systemPrompt = buildSystemPrompt(slug, date);
  const userPrompt = buildUserPrompt(messages);

  await log(
    `[extract] dispatching model=${HAIKU_MODEL} messages=${messages.length} prompt_chars=${userPrompt.length}`,
  );

  const extractor = opts.extractor ?? defaultExtractor();
  let raw = "";
  try {
    raw = await extractor({ systemPrompt, userPrompt });
  } catch (err) {
    const errorText = err instanceof Error ? err.message : String(err);
    await log(`[extract] FAILED extractor user=${opts.userId} date=${date}: ${errorText}`);
    if (!dryRun) {
      persistExtraction({
        userId: opts.userId,
        date,
        runAt: Date.now(),
        status: "failed",
        factCount: 0,
        classifications: {},
        sourceMessageIds: messages.map((m) => m.id),
        errorText,
      });
    }
    return {
      status: "failed",
      userId: opts.userId,
      date,
      factCount: 0,
      classifications: {},
      filesWritten: [],
      factsSkippedDuplicate: 0,
      factsRejected: 0,
      errorText,
      rawResponse: raw,
    };
  }

  const { facts, rejected, error: parseErr } = parseExtractorResponse(
    raw,
    allowlist,
  );

  if (parseErr) {
    await log(
      `[extract] FAILED parse user=${opts.userId} date=${date}: ${parseErr}`,
    );
    await log(`[extract] raw response (first 600): ${raw.slice(0, 600)}`);
    if (!dryRun) {
      persistExtraction({
        userId: opts.userId,
        date,
        runAt: Date.now(),
        status: "failed",
        factCount: 0,
        classifications: {},
        sourceMessageIds: messages.map((m) => m.id),
        errorText: `parse failed: ${parseErr}`,
      });
    }
    return {
      status: "failed",
      userId: opts.userId,
      date,
      factCount: 0,
      classifications: {},
      filesWritten: [],
      factsSkippedDuplicate: 0,
      factsRejected: 0,
      errorText: `parse failed: ${parseErr}`,
      rawResponse: raw,
    };
  }

  // Route facts to brain files.
  const classifications: Record<string, number> = {};
  const filesWritten = new Set<string>();
  let duplicateCount = 0;
  let pathRejected = 0;
  for (const f of facts) {
    classifications[f.classification] = (classifications[f.classification] ?? 0) + 1;
    if (dryRun) continue;
    const abs = resolveBrainPath(f.brain_file, allowlist, brainRoot);
    if (!abs) {
      pathRejected++;
      await log(
        `[extract] path rejected: ${f.brain_file} (fact: "${f.fact.slice(0, 60)}…")`,
      );
      continue;
    }
    const idsForCite = f.source_message_ids.length > 0
      ? f.source_message_ids.join(",")
      : "n/a";
    const citation = `<!-- extracted from daily chat ${date}, messages: ${idsForCite} -->`;
    try {
      const result = await appendFactToSection({
        abs,
        section: f.section,
        fact: f.fact,
        citation,
      });
      if (result.written) {
        filesWritten.add(f.brain_file);
      } else if (result.reason === "duplicate") {
        duplicateCount++;
      }
    } catch (err) {
      pathRejected++;
      const msg = err instanceof Error ? err.message : String(err);
      await log(
        `[extract] write failed for ${f.brain_file}: ${msg}`,
      );
    }
  }

  const result: ExtractionResult = {
    status: "success",
    userId: opts.userId,
    date,
    factCount: facts.length,
    classifications,
    filesWritten: Array.from(filesWritten).sort(),
    factsSkippedDuplicate: duplicateCount,
    factsRejected: rejected + pathRejected,
    errorText: null,
  };

  if (!dryRun) {
    persistExtraction({
      userId: opts.userId,
      date,
      runAt: Date.now(),
      status: "success",
      factCount: facts.length,
      classifications,
      sourceMessageIds: messages.map((m) => m.id),
      errorText: null,
    });
    // Persist per-fact rows for the Layer 5 history sidebar + Layer 6
    // recall(type='keyword') search path. Done AFTER the parent row
    // is upserted to status=success so the FK link points at the
    // committed row, not an in-flight one.
    const extractionId = getExtractionId(opts.userId, date);
    if (extractionId !== null && facts.length > 0) {
      persistFactRows({
        extractionId,
        userId: opts.userId,
        date,
        facts,
      });
    }
  }

  const breakdown = Object.entries(classifications)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  await log(
    `[extract] success user=${opts.userId} date=${date} facts=${facts.length} dup=${duplicateCount} rejected=${rejected + pathRejected} files=${filesWritten.size} breakdown={${breakdown}}`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

export function yesterdayLocalDate(): string {
  const now = Date.now();
  const yesterday = now - 24 * 60 * 60 * 1000;
  return formatLocalDate(yesterday);
}

export { todayLocalDate };
