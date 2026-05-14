/**
 * Smart Topic System — Layer 7: topic-aware daily-log decay.
 *
 * Walks the brain root's daily logs (`daily/*.md` and
 * `users/<slug>/daily/*.md`), classifies each by age band, and
 * rewrites it via Haiku at the target detail level for that band.
 * Topic-aware: a section tied to a hot topic compresses ONE band
 * lighter than the default so durable threads don't get flattened
 * alongside dead ones.
 *
 * Decay bands (from brain.md):
 *   current-week (0–6 days)  → SKIP
 *   last-week    (7–13 days) → highlights
 *   last-month   (14–29 days)→ paragraph
 *   older        (30+ days)  → sentence
 *
 * Topic-aware bump (per section):
 *   has hot topic → one band lighter (last-month + hot = highlights;
 *                                     older + hot = paragraph).
 *
 * Hot topic = ≥1 tagged message in last 14 days OR appears in
 * today's top-5 topics.
 *
 * Idempotency: each file carries a `compaction_level` frontmatter
 * field; a re-run that targets the same level (or higher) is a
 * no-op. `topic_preserved: [<topic_ids>]` records which topics
 * pulled the level back.
 */

import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { getDb } from "./db";
import { BRAIN_ROOT } from "./spar-brain";
import { collectFromClaudeCli } from "./spar-claude";

// ---------------------------------------------------------------------------
// Types + constants
// ---------------------------------------------------------------------------

export type CompactionLevel = "detailed" | "highlights" | "paragraph" | "sentence";
export type AgeBand = "current-week" | "last-week" | "last-month" | "older";

/** Order of levels from most → least detail. Numeric index lets us
 *  compare "is X at-or-below target?" with simple < / >= checks. */
const LEVEL_RANK: Record<CompactionLevel, number> = {
  detailed: 0,
  highlights: 1,
  paragraph: 2,
  sentence: 3,
};

/** Default target per age band BEFORE topic-aware adjustment. */
const BAND_TARGET: Record<AgeBand, CompactionLevel> = {
  "current-week": "detailed",
  "last-week": "highlights",
  "last-month": "paragraph",
  older: "sentence",
};

/** Bump one band lighter when a section is tied to a hot topic.
 *  Returns the SAME level if the band doesn't bump (current-week,
 *  or last-week with hot stays at highlights — there's no level
 *  above that we'd promote to for last-week anyway). */
function bumpLighter(level: CompactionLevel): CompactionLevel {
  switch (level) {
    case "detailed": return "detailed";
    case "highlights": return "detailed";
    case "paragraph": return "highlights";
    case "sentence": return "paragraph";
  }
}

const HOT_TOPIC_WINDOW_DAYS = 14;
const TODAY_TOP_TOPIC_COUNT = 5;

const HAIKU_MODEL =
  process.env.AMASO_COMPACTION_MODEL ||
  process.env.AMASO_EXTRACTION_MODEL ||
  "claude-haiku-4-5-20251001";

const COMPACT_MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function todayLocalDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Amsterdam" });
}

function daysBetween(olderDate: string, newerDate: string): number {
  const [oy, om, od] = olderDate.split("-").map(Number);
  const [ny, nm, nd] = newerDate.split("-").map(Number);
  if (!oy || !ny) return 0;
  const a = Date.UTC(oy, om - 1, od);
  const b = Date.UTC(ny, nm - 1, nd);
  return Math.floor((b - a) / (24 * 60 * 60_000));
}

function classifyAge(date: string, today: string = todayLocalDate()): AgeBand {
  const age = daysBetween(date, today);
  if (age < 7) return "current-week";
  if (age < 14) return "last-week";
  if (age < 30) return "last-month";
  return "older";
}

function dateFromFilename(rel: string): string | null {
  const m = rel.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  return m?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Markdown parsing
// ---------------------------------------------------------------------------

interface ParsedSection {
  /** H2 heading text without the leading "## ". Empty string for
   *  content above the first H2 (rarely useful but preserved). */
  heading: string;
  /** Body lines (including any leading blank line) between this H2
   *  and the next. Includes citation comments inline. */
  body: string;
  /** Message IDs harvested from inline `<!-- extracted from daily chat
   *  ..., messages: 1,2,3 -->` citations in this section. Empty when
   *  no citations are present. */
  messageIds: number[];
}

interface ParsedDailyLog {
  /** Raw YAML frontmatter (between the leading "---" markers). May
   *  be empty when no frontmatter is present. */
  frontmatter: string;
  /** Content between frontmatter and the first H2 (typically just
   *  the H1 title). */
  preamble: string;
  /** H2-anchored sections, in source order. */
  sections: ParsedSection[];
}

const CITATION_MSGIDS_RE = /<!--\s*extracted from daily chat\s+\d{4}-\d{2}-\d{2},\s*messages:\s*([^>]+?)\s*-->/g;

function extractMessageIds(text: string): number[] {
  const out: number[] = [];
  let m: RegExpExecArray | null;
  CITATION_MSGIDS_RE.lastIndex = 0;
  while ((m = CITATION_MSGIDS_RE.exec(text)) !== null) {
    for (const tok of m[1].split(",")) {
      const n = parseInt(tok.trim(), 10);
      if (Number.isFinite(n) && n > 0) out.push(n);
    }
  }
  return Array.from(new Set(out));
}

export function parseDailyLog(content: string): ParsedDailyLog {
  let cursor = 0;
  let frontmatter = "";
  if (content.startsWith("---")) {
    const end = content.indexOf("\n---", 3);
    if (end >= 0) {
      frontmatter = content.slice(0, end + 4).trim() + "\n";
      cursor = end + 4;
      // Skip the trailing newline after the closing ---
      while (cursor < content.length && content[cursor] === "\n") cursor++;
    }
  }
  const rest = content.slice(cursor);
  const lines = rest.split(/\r?\n/);

  // First, find the first H2. Everything before is preamble.
  let firstH2 = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i])) {
      firstH2 = i;
      break;
    }
  }
  const preamble = firstH2 < 0
    ? lines.join("\n").trimEnd() + "\n"
    : lines.slice(0, firstH2).join("\n").trimEnd() + "\n";

  const sections: ParsedSection[] = [];
  if (firstH2 >= 0) {
    let i = firstH2;
    while (i < lines.length) {
      const m = lines[i].match(/^##\s+(.+?)\s*$/);
      if (!m) {
        i++;
        continue;
      }
      const heading = m[1].trim();
      let j = i + 1;
      while (j < lines.length && !/^##\s+\S/.test(lines[j])) j++;
      const bodyLines = lines.slice(i + 1, j);
      const body = bodyLines.join("\n").replace(/^\n+|\n+$/g, "");
      sections.push({
        heading,
        body,
        messageIds: extractMessageIds(body),
      });
      i = j;
    }
  }
  return { frontmatter, preamble, sections };
}

// ---------------------------------------------------------------------------
// Frontmatter mutation (string-level, no YAML lib dep)
// ---------------------------------------------------------------------------

/** Read a top-level scalar field from raw frontmatter. Returns null
 *  when the field is missing or the frontmatter doesn't parse as the
 *  shape we expect (we never throw). */
function readFrontmatterField(frontmatter: string, key: string): string | null {
  if (!frontmatter) return null;
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}:\\s*(.*)$`, "m");
  const m = frontmatter.match(re);
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "");
}

/** Upsert a top-level scalar field in frontmatter. Returns the
 *  rewritten frontmatter. Builds a minimal `---\n…\n---\n` block when
 *  the input was empty. */
function upsertFrontmatterField(frontmatter: string, key: string, value: string): string {
  if (!frontmatter) {
    return `---\n${key}: ${value}\n---\n`;
  }
  const lines = frontmatter.replace(/\n+$/, "").split(/\r?\n/);
  // Frontmatter is wrapped in --- markers; find indices.
  const startIdx = lines.indexOf("---");
  const endIdx = lines.lastIndexOf("---");
  if (startIdx < 0 || endIdx <= startIdx) {
    return `---\n${key}: ${value}\n---\n` + frontmatter;
  }
  const before = lines.slice(0, startIdx + 1);
  const inner = lines.slice(startIdx + 1, endIdx);
  const after = lines.slice(endIdx);
  let replaced = false;
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}:\\s*`);
  const innerOut = inner.map((line) => {
    if (re.test(line)) {
      replaced = true;
      return `${key}: ${value}`;
    }
    return line;
  });
  if (!replaced) innerOut.push(`${key}: ${value}`);
  return [...before, ...innerOut, ...after].join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Topic hotness
// ---------------------------------------------------------------------------

interface HotTopicSet {
  hotIds: Set<number>;
  todayTopIds: Set<number>;
}

function loadHotTopics(userId: number, today: string = todayLocalDate()): HotTopicSet {
  const db = getDb();
  const cutoff = (() => {
    const t = new Date(today + "T00:00:00Z");
    t.setUTCDate(t.getUTCDate() - HOT_TOPIC_WINDOW_DAYS);
    return t.toISOString().slice(0, 10);
  })();
  const hotRows = db
    .prepare(
      `SELECT DISTINCT topic_id FROM daily_topic_stats
        WHERE user_id = ? AND date >= ?`,
    )
    .all(userId, cutoff) as Array<{ topic_id: number }>;
  const hotIds = new Set(hotRows.map((r) => r.topic_id));

  const todayRows = db
    .prepare(
      `SELECT topic_id FROM daily_topic_stats
        WHERE user_id = ? AND date = ?
        ORDER BY message_count DESC
        LIMIT ?`,
    )
    .all(userId, today, TODAY_TOP_TOPIC_COUNT) as Array<{ topic_id: number }>;
  const todayTopIds = new Set(todayRows.map((r) => r.topic_id));
  for (const id of todayTopIds) hotIds.add(id);
  return { hotIds, todayTopIds };
}

/** Resolve a set of message IDs to the topics they're attached to.
 *  Returns the deduped topic-id set. Cheap batched query. */
function resolveTopicsForMessages(messageIds: number[]): Set<number> {
  const out = new Set<number>();
  if (messageIds.length === 0) return out;
  const placeholders = messageIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT topic_id FROM spar_message_topics
        WHERE message_id IN (${placeholders})`,
    )
    .all(...messageIds) as Array<{ topic_id: number }>;
  for (const r of rows) out.add(r.topic_id);
  return out;
}

// ---------------------------------------------------------------------------
// Model rewrite
// ---------------------------------------------------------------------------

export type CompactExecutor = (input: {
  systemPrompt: string;
  userPrompt: string;
}) => Promise<string>;

/**
 * lib/spar-claude's `findClaudeBinary` only checks ${APPDATA}\npm\claude.cmd
 * which is the legacy npm shim. The current Claude Code install lays
 * the binary down as claude.exe deeper in the package. This helper
 * probes the actual landing zones and, if it finds one, writes the
 * absolute path into AMASO_CLAUDE_CMD so collectFromClaudeCli picks
 * it up. No-op when the shim path is already valid or an explicit
 * override is already set.
 */
function ensureClaudeBinaryOnPath(): void {
  if (process.env.AMASO_CLAUDE_CMD) return;
  try {
    // Already-resolved binary from the parent process (Claude Code
    // itself, when this runs interactively).
    const fromEnv = process.env.CLAUDE_CODE_EXECPATH;
    if (fromEnv) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      if (fs.existsSync(fromEnv)) {
        process.env.AMASO_CLAUDE_CMD = fromEnv;
        return;
      }
    }
    const candidates: string[] = [];
    const appdata = process.env.APPDATA;
    if (appdata) {
      candidates.push(`${appdata}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`);
      candidates.push(`${appdata}\\npm\\claude.cmd`);
    }
    const localAppdata = process.env.LOCALAPPDATA;
    if (localAppdata) {
      candidates.push(`${localAppdata}\\Programs\\@anthropic-ai\\claude-code\\bin\\claude.exe`);
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        process.env.AMASO_CLAUDE_CMD = c;
        return;
      }
    }
  } catch {
    /* silent — caller will fall back to spar-claude's default */
  }
}

function defaultExecutor(): CompactExecutor {
  const apiKey =
    process.env.AMASO_SPAR_ANTHROPIC_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    const client = new Anthropic({ apiKey });
    return async ({ systemPrompt, userPrompt }) => {
      const resp = await client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: COMPACT_MAX_TOKENS,
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
  ensureClaudeBinaryOnPath();
  return async ({ systemPrompt, userPrompt }) =>
    collectFromClaudeCli({
      systemPrompt,
      heartbeat: "",
      history: [{ role: "user", content: userPrompt }],
      model: "haiku",
      maxTurns: 1,
    });
}

function levelInstruction(level: CompactionLevel): string {
  switch (level) {
    case "detailed":
      return "Keep all detail. No compression. Return the section body unchanged.";
    case "highlights":
      return "Keep the section as bullets but cut to the 3–6 most load-bearing items (decisions, shippings, durable facts). Drop chatter, motion, mood asides. Each bullet stays one line.";
    case "paragraph":
      return "Replace the entire section body with ONE short paragraph (2–4 sentences) summarising the durable content. No bullets. No frontmatter. No headings.";
    case "sentence":
      return "Replace the entire section body with ONE sentence that names the most durable fact or outcome. No bullets. No frontmatter. No headings.";
  }
}

function buildRewriteSystemPrompt(): string {
  return [
    "You compress one section of a daily-log markdown file to a target detail level.",
    "Output ONLY the rewritten section body — no heading, no frontmatter, no fences, no explanation.",
    "Preserve durable facts (decisions, shippings, names, dates, numbers, project references).",
    "Drop ephemeral chatter (mood asides, conversational interjections, motion).",
    "Keep any 'see <path>' cross-references that already appear in the body.",
    "If the original body is already at or below the target detail level, return it unchanged.",
    "Never return an empty string when the original body has any durable signal.",
  ].join("\n");
}

function buildRewriteUserPrompt(args: {
  heading: string;
  body: string;
  level: CompactionLevel;
  topicTitles: string[];
}): string {
  const tail = args.topicTitles.length > 0
    ? `\n\nTopics this section is tied to (preserve any direct references to these in the rewrite): ${args.topicTitles.join(", ")}.`
    : "";
  return [
    `Target detail level: ${args.level}.`,
    levelInstruction(args.level),
    "",
    `Section heading (do NOT include this in the output): ${args.heading}`,
    "",
    "Original section body:",
    "```",
    args.body,
    "```" + tail,
  ].join("\n");
}

function cleanRewrite(out: string): string {
  let s = out.trim();
  // Strip leading code fence the model sometimes wraps despite the system prompt.
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z0-9_-]*\n?/, "").replace(/\n?```$/, "").trim();
  }
  // Strip a leading heading the model occasionally re-emits.
  s = s.replace(/^##\s+\S[^\n]*\n+/, "");
  return s;
}

// ---------------------------------------------------------------------------
// File-level orchestration
// ---------------------------------------------------------------------------

export interface FileCompactionPlan {
  /** Path relative to BRAIN_ROOT. Forward slashes. */
  relPath: string;
  /** Userid the file belongs to (resolved from users/<slug>/ — defaults to 1
   *  for root daily files since santi=admin owns shared content). */
  userId: number;
  /** YYYY-MM-DD from the filename. */
  date: string;
  band: AgeBand;
  /** File-level effective target (the lightest section's level). */
  fileTarget: CompactionLevel;
  /** Frontmatter compaction_level prior to this run, if any. */
  currentLevel: CompactionLevel | null;
  /** Per-section adjusted targets. */
  sections: Array<{
    heading: string;
    sectionTarget: CompactionLevel;
    topicIds: number[];
    topicPreservedIds: number[];
  }>;
  /** Topics that pulled at least one section back a level. */
  topicPreserved: number[];
  /** True when this file is at-or-below the file-level target already. */
  alreadyCompacted: boolean;
}

export interface FileCompactionResult {
  plan: FileCompactionPlan;
  /** True when the file was actually rewritten. */
  wrote: boolean;
  /** Errors per section (if any). */
  sectionErrors: Array<{ heading: string; error: string }>;
  /** Byte counts for the diff stat. */
  bytesBefore: number;
  bytesAfter: number;
}

export interface CompactOptions {
  dryRun?: boolean;
  /** Override BRAIN_ROOT (test injection). */
  brainRoot?: string;
  /** Override the model dispatcher (test injection). */
  executor?: CompactExecutor;
  /** Only consider files for these users (by id). Default = all. */
  userIds?: number[];
  /** Override today's date (test injection). */
  today?: string;
  /** Logger sink. */
  logger?: (line: string) => void;
}

export interface CompactRunSummary {
  scanned: number;
  wouldChange: number;
  wrote: number;
  skippedAlready: number;
  skippedCurrentWeek: number;
  errored: number;
  topicPreservedFiles: number;
  files: FileCompactionResult[];
}

interface UserSlug {
  userId: number;
  slug: string;
}

async function listDailyLogFiles(
  brainRoot: string,
): Promise<Array<{ relPath: string; absPath: string; userScopeSlug: string | null }>> {
  const out: Array<{ relPath: string; absPath: string; userScopeSlug: string | null }> = [];

  // Root shared dailies.
  const rootDailyAbs = path.join(brainRoot, "daily");
  try {
    const entries = await fs.readdir(rootDailyAbs);
    for (const f of entries) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
      out.push({
        relPath: `daily/${f}`,
        absPath: path.join(rootDailyAbs, f),
        userScopeSlug: null,
      });
    }
  } catch {
    /* missing dir ok */
  }

  // Per-user dailies.
  const usersAbs = path.join(brainRoot, "users");
  let userDirs: string[] = [];
  try {
    userDirs = await fs.readdir(usersAbs);
  } catch {
    /* no users dir */
  }
  for (const slug of userDirs) {
    const dailyAbs = path.join(usersAbs, slug, "daily");
    let entries: string[];
    try {
      entries = await fs.readdir(dailyAbs);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) continue;
      out.push({
        relPath: `users/${slug}/daily/${f}`,
        absPath: path.join(usersAbs, slug, "daily", f),
        userScopeSlug: slug,
      });
    }
  }
  return out;
}

/** Resolve a slug → userId via the users table. Memoised across the
 *  call so we don't query per-file. Shared files (no slug) map to
 *  santi (id=1) — shared brain content is santi-owned in practice. */
function makeSlugResolver(): (slug: string | null) => number {
  const cache = new Map<string | null, number>();
  return (slug) => {
    if (cache.has(slug)) return cache.get(slug)!;
    if (slug === null) {
      // Default to santi for shared content.
      const row = getDb()
        .prepare("SELECT id FROM users WHERE LOWER(name) = LOWER(?)")
        .get("santi") as { id: number } | undefined;
      const id = row?.id ?? 1;
      cache.set(null, id);
      return id;
    }
    const row = getDb()
      .prepare("SELECT id FROM users WHERE LOWER(name) = LOWER(?)")
      .get(slug) as { id: number } | undefined;
    const id = row?.id ?? 1;
    cache.set(slug, id);
    return id;
  };
}

function loadTopicTitles(topicIds: number[]): Map<number, string> {
  const map = new Map<number, string>();
  if (topicIds.length === 0) return map;
  const placeholders = topicIds.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT id, title FROM topics WHERE id IN (${placeholders})`)
    .all(...topicIds) as Array<{ id: number; title: string }>;
  for (const r of rows) map.set(r.id, r.title);
  return map;
}

/** Build the per-section + file-level plan WITHOUT calling the model.
 *  Pure: same input → same output. Drives both dry-run output and the
 *  real-run path. */
export function planFileCompaction(args: {
  parsed: ParsedDailyLog;
  relPath: string;
  date: string;
  userId: number;
  band: AgeBand;
  hot: HotTopicSet;
}): FileCompactionPlan {
  const currentLevel = (readFrontmatterField(args.parsed.frontmatter, "compaction_level") ?? null) as
    | CompactionLevel
    | null;

  const defaultLevel = BAND_TARGET[args.band];
  const sections = args.parsed.sections.map((s) => {
    const topicIds = Array.from(resolveTopicsForMessages(s.messageIds));
    const topicPreservedIds = topicIds.filter((id) => args.hot.hotIds.has(id));
    const sectionTarget =
      topicPreservedIds.length > 0 ? bumpLighter(defaultLevel) : defaultLevel;
    return {
      heading: s.heading,
      sectionTarget,
      topicIds,
      topicPreservedIds,
    };
  });

  // File-level effective target = MIN level (lightest compression)
  // across sections. If any section stays detailed (current-week
  // shouldn't get here but defensive), the whole file's level reads
  // detailed.
  const ranks = sections.map((s) => LEVEL_RANK[s.sectionTarget]);
  const minRank = ranks.length > 0 ? Math.min(...ranks) : LEVEL_RANK[defaultLevel];
  const fileTarget = (Object.entries(LEVEL_RANK).find(
    ([, r]) => r === minRank,
  )?.[0] ?? defaultLevel) as CompactionLevel;

  const topicPreserved = Array.from(
    new Set(sections.flatMap((s) => s.topicPreservedIds)),
  );

  const alreadyCompacted =
    currentLevel !== null &&
    LEVEL_RANK[currentLevel] >= LEVEL_RANK[fileTarget];

  return {
    relPath: args.relPath,
    userId: args.userId,
    date: args.date,
    band: args.band,
    fileTarget,
    currentLevel,
    sections,
    topicPreserved,
    alreadyCompacted,
  };
}

async function rewriteSection(args: {
  heading: string;
  body: string;
  level: CompactionLevel;
  topicTitles: string[];
  executor: CompactExecutor;
}): Promise<string> {
  // detailed → don't call the model.
  if (args.level === "detailed") return args.body;
  const systemPrompt = buildRewriteSystemPrompt();
  const userPrompt = buildRewriteUserPrompt(args);
  const raw = await args.executor({ systemPrompt, userPrompt });
  const cleaned = cleanRewrite(raw);
  // Defensive: empty / short rewrite when original had content →
  // keep the original. Better to over-preserve than to lose data.
  if (!cleaned || cleaned.length < 5) return args.body;
  return cleaned;
}

function renderLog(plan: ParsedDailyLog, rewrittenSections: Array<{ heading: string; body: string }>): string {
  const parts: string[] = [];
  if (plan.frontmatter) parts.push(plan.frontmatter.trimEnd());
  if (plan.preamble) parts.push(plan.preamble.trimEnd());
  for (const s of rewrittenSections) {
    parts.push(`## ${s.heading}`);
    parts.push(s.body.trimEnd());
  }
  return parts.filter((p) => p.length > 0).join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Top-level entry
// ---------------------------------------------------------------------------

export async function compactDailyLogs(opts: CompactOptions = {}): Promise<CompactRunSummary> {
  const brainRoot = opts.brainRoot ?? BRAIN_ROOT;
  const today = opts.today ?? todayLocalDate();
  const executor = opts.executor ?? defaultExecutor();
  const log = opts.logger ?? ((line: string) => console.log(line));
  const allFiles = await listDailyLogFiles(brainRoot);
  const slugResolver = makeSlugResolver();
  const hotCache = new Map<number, HotTopicSet>();
  const summary: CompactRunSummary = {
    scanned: 0,
    wouldChange: 0,
    wrote: 0,
    skippedAlready: 0,
    skippedCurrentWeek: 0,
    errored: 0,
    topicPreservedFiles: 0,
    files: [],
  };

  for (const f of allFiles) {
    summary.scanned++;
    const date = dateFromFilename(f.relPath);
    if (!date) continue;
    const band = classifyAge(date, today);
    if (band === "current-week") {
      summary.skippedCurrentWeek++;
      log(`[compact] skip current-week ${f.relPath}`);
      continue;
    }
    const userId = slugResolver(f.userScopeSlug);
    if (opts.userIds && !opts.userIds.includes(userId)) continue;

    let raw: string;
    try {
      raw = await fs.readFile(f.absPath, "utf8");
    } catch (err) {
      summary.errored++;
      log(`[compact] read failed ${f.relPath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const parsed = parseDailyLog(raw);
    if (!hotCache.has(userId)) hotCache.set(userId, loadHotTopics(userId, today));
    const hot = hotCache.get(userId)!;
    const plan = planFileCompaction({ parsed, relPath: f.relPath, date, userId, band, hot });

    if (plan.alreadyCompacted) {
      summary.skippedAlready++;
      log(
        `[compact] skip already-at-target ${f.relPath} band=${band} current=${plan.currentLevel} target=${plan.fileTarget}`,
      );
      summary.files.push({
        plan,
        wrote: false,
        sectionErrors: [],
        bytesBefore: raw.length,
        bytesAfter: raw.length,
      });
      continue;
    }

    summary.wouldChange++;
    if (plan.topicPreserved.length > 0) summary.topicPreservedFiles++;

    log(
      `[compact] ${opts.dryRun ? "DRY " : ""}${f.relPath} band=${band} ` +
        `target=${plan.fileTarget} ` +
        `preserved=${plan.topicPreserved.length > 0 ? plan.topicPreserved.join(",") : "—"}`,
    );

    if (opts.dryRun) {
      summary.files.push({
        plan,
        wrote: false,
        sectionErrors: [],
        bytesBefore: raw.length,
        bytesAfter: raw.length,
      });
      continue;
    }

    const allTopicIds = Array.from(
      new Set(plan.sections.flatMap((s) => s.topicIds)),
    );
    const topicTitles = loadTopicTitles(allTopicIds);
    const sectionErrors: FileCompactionResult["sectionErrors"] = [];
    const rewritten: Array<{ heading: string; body: string }> = [];

    for (let i = 0; i < parsed.sections.length; i++) {
      const orig = parsed.sections[i];
      const sp = plan.sections[i];
      try {
        const newBody = await rewriteSection({
          heading: orig.heading,
          body: orig.body,
          level: sp.sectionTarget,
          topicTitles: sp.topicIds
            .map((id) => topicTitles.get(id))
            .filter((t): t is string => !!t),
          executor,
        });
        rewritten.push({ heading: orig.heading, body: newBody });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sectionErrors.push({ heading: orig.heading, error: msg });
        rewritten.push({ heading: orig.heading, body: orig.body });
      }
    }

    // If EVERY section errored, do not write the file and do not
    // stamp the frontmatter. Idempotency contract: compaction_level
    // must reflect actual content. A stamped-but-unchanged file
    // would silently be treated as "already at target" on the next
    // pass — masking the underlying CLI / model failure.
    const allFailed = sectionErrors.length > 0 && sectionErrors.length >= parsed.sections.length;
    if (allFailed) {
      summary.errored++;
      summary.files.push({
        plan,
        wrote: false,
        sectionErrors,
        bytesBefore: raw.length,
        bytesAfter: raw.length,
      });
      log(`[compact] all sections failed for ${f.relPath}; leaving file untouched`);
      continue;
    }

    let fm = parsed.frontmatter;
    fm = upsertFrontmatterField(fm, "compaction_level", plan.fileTarget);
    if (plan.topicPreserved.length > 0) {
      fm = upsertFrontmatterField(
        fm,
        "topic_preserved",
        `[${plan.topicPreserved.join(", ")}]`,
      );
    }
    const rendered = renderLog({ ...parsed, frontmatter: fm }, rewritten);

    try {
      await fs.writeFile(f.absPath, rendered, "utf8");
      summary.wrote++;
      summary.files.push({
        plan,
        wrote: true,
        sectionErrors,
        bytesBefore: raw.length,
        bytesAfter: rendered.length,
      });
    } catch (err) {
      summary.errored++;
      sectionErrors.push({
        heading: "(write)",
        error: err instanceof Error ? err.message : String(err),
      });
      summary.files.push({
        plan,
        wrote: false,
        sectionErrors,
        bytesBefore: raw.length,
        bytesAfter: rendered.length,
      });
    }
  }

  log(
    `[compact] done scanned=${summary.scanned} wrote=${summary.wrote} ` +
      `dry=${summary.wouldChange - summary.wrote} ` +
      `skipped-current-week=${summary.skippedCurrentWeek} ` +
      `skipped-already=${summary.skippedAlready} ` +
      `errored=${summary.errored} ` +
      `topic-preserved-files=${summary.topicPreservedFiles}`,
  );
  return summary;
}
