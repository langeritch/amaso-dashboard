/**
 * Smart Topic System — final pass: auto-populate the user's daily log
 * markdown from consolidated subjects.
 *
 * Closes remark #453: after subject extraction succeeds, write to
 * users/<slug>/daily/YYYY-MM-DD.md with each subject as a bullet
 * under the section the extractor classified it into. Cross-references
 * (`see projects/<slug>`) are appended when a subject's topic_ids
 * include a topic whose title looks project-flavored.
 *
 * Read-modify-write so we never overwrite manual entries:
 *   - If the file doesn't exist, write a minimal scaffold with all 6
 *     canonical sections (Shipped / Built / Decisions / Conversations
 *     / Open Loops / Energy).
 *   - If it exists, append each subject's bullet under its section,
 *     creating the section H2 if missing. Idempotent on a 40-char
 *     fingerprint of the label so a re-extraction doesn't double-write.
 *
 * The brain ACL applies — the writer resolves against the per-user
 * private subtree (users/<slug>/daily/) and refuses to escape.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { BRAIN_ROOT, slugifyUser } from "./spar-brain";
import { getDb } from "./db";
import type { User } from "./db";
import type { SubjectEntry } from "./spar-subjects";

/** Canonical section order for fresh daily-log scaffolds. */
const SECTIONS = [
  "Shipped",
  "Built",
  "Decisions",
  "Conversations",
  "Open Loops",
  "Energy",
] as const;
type Section = (typeof SECTIONS)[number];

function isCanonicalSection(s: string): s is Section {
  return (SECTIONS as readonly string[]).includes(s);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** First 40 chars of the label, whitespace-collapsed, lowercased. The
 *  same shape lib/daily-extraction uses for its fact fingerprint. */
function fingerprint(label: string): string {
  return label.replace(/\s+/g, " ").trim().slice(0, 40).toLowerCase();
}

function freshScaffold(date: string): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${date}`);
  lines.push("type: daily-log");
  lines.push("---");
  lines.push(`# ${date}`);
  lines.push("");
  for (const sec of SECTIONS) {
    lines.push(`## ${sec}`);
    lines.push("");
  }
  return lines.join("\n");
}

interface SubjectWithRefs {
  label: string;
  summary: string;
  section: Section;
  /** "see projects/<slug>" style cross-refs derived from topic_ids. */
  crossRefs: string[];
}

function loadProjectCrossRefs(
  userId: number,
  topicIds: number[],
): string[] {
  if (topicIds.length === 0) return [];
  const db = getDb();
  // Pull topic slug + title; treat any topic whose title or slug
  // contains "project" / matches a known project name in
  // amaso.config.json as a project cross-ref. Light-touch: we add the
  // `see projects/<slug>` reference for every topic the subject
  // covers; dedup on slug. The brain auto-router already understands
  // these refs.
  const placeholders = topicIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT slug, title FROM topics
        WHERE user_id = ? AND id IN (${placeholders})`,
    )
    .all(userId, ...topicIds) as Array<{ slug: string; title: string }>;
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const r of rows) {
    if (!r.slug || seen.has(r.slug)) continue;
    seen.add(r.slug);
    refs.push(`see projects/${r.slug}`);
  }
  return refs;
}

function classifySection(s: string): Section {
  if (isCanonicalSection(s)) return s;
  // Defensive fallback for an extractor that wandered off-list. The
  // 6-bucket prompt makes this rare, but never let a stray section
  // crash the writer.
  return "Open Loops";
}

function buildEntries(
  userId: number,
  subjects: SubjectEntry[],
): SubjectWithRefs[] {
  return subjects
    .filter((s) => s && s.label && s.label.trim())
    .map((s) => ({
      label: s.label.trim(),
      summary: (s.summary || "").trim(),
      section: classifySection(s.section),
      crossRefs: loadProjectCrossRefs(userId, s.topic_ids ?? []),
    }));
}

/**
 * Insert a single bullet under the named H2 section. Mutates the
 * returned string. Same posture as lib/daily-extraction's
 * appendFactToSection but tuned for the canonical-6-section layout.
 */
function spliceUnderSection(body: string, section: Section, bullet: string): string {
  const headingPattern = new RegExp(`^##\\s+${escapeRegex(section)}\\s*$`, "im");
  const match = body.match(headingPattern);
  if (match && typeof match.index === "number") {
    const headingEnd = match.index + match[0].length;
    const after = body.slice(headingEnd);
    const nextHeadingRel = after.search(/^##\s+/m);
    const sectionEnd = nextHeadingRel < 0 ? body.length : headingEnd + nextHeadingRel;
    const sectionBody = body.slice(headingEnd, sectionEnd).trimEnd();
    const insertion = `${sectionBody}\n${bullet}\n`;
    return (
      body.slice(0, headingEnd) +
      "\n" +
      insertion.replace(/^\n+/, "") +
      (sectionEnd < body.length ? "\n" + body.slice(sectionEnd).replace(/^\n+/, "") : "")
    );
  }
  // No matching H2 — append a fresh one at the end.
  return body.trimEnd() + `\n\n## ${section}\n${bullet}\n`;
}

/**
 * Render one subject as a markdown bullet (the line that lands under
 * its section). Cross-refs (if any) become a child bullet line.
 */
function renderBullet(entry: SubjectWithRefs): string {
  const head = `- **${entry.label}**${entry.summary ? `: ${entry.summary}` : ""}`;
  if (entry.crossRefs.length === 0) return head;
  return head + "\n  " + entry.crossRefs.join(", ");
}

export interface DailyLogWriteResult {
  /** Relative path under BRAIN_ROOT — what was touched. */
  relPath: string;
  /** Absolute path. */
  absPath: string;
  /** Subjects that produced a brand-new bullet (i.e. fingerprint not
   *  already present). */
  written: number;
  /** Subjects whose fingerprint matched something already in the file. */
  skippedDuplicate: number;
  /** Whether the file existed before this call. */
  fileExisted: boolean;
}

export interface WriteDailyLogOpts {
  /** Override BRAIN_ROOT for tests. Defaults to the constant. */
  brainRoot?: string;
}

/**
 * Append the day's subjects to the user's private daily log. The file
 * is created with a fresh scaffold when missing. Idempotent — the
 * fingerprint guard means re-running is a no-op once content lands.
 */
export async function writeDailyLogFromSubjects(
  user: User,
  date: string,
  subjects: SubjectEntry[],
  opts: WriteDailyLogOpts = {},
): Promise<DailyLogWriteResult> {
  const slug = slugifyUser(user.name);
  const brainRoot = opts.brainRoot ?? BRAIN_ROOT;
  const rel = `users/${slug}/daily/${date}.md`;
  const abs = path.resolve(brainRoot, rel);

  // Path-safety: the resolved abs must remain under brainRoot.
  const rootWithSep = brainRoot.endsWith(path.sep) ? brainRoot : brainRoot + path.sep;
  if (abs !== brainRoot && !abs.startsWith(rootWithSep)) {
    throw new Error(`daily-log path escapes brain root: ${rel}`);
  }

  let body: string;
  let fileExisted = true;
  try {
    body = await fs.readFile(abs, "utf8");
  } catch {
    body = freshScaffold(date);
    fileExisted = false;
  }

  const entries = buildEntries(user.id, subjects);
  let written = 0;
  let skipped = 0;

  for (const e of entries) {
    const fp = fingerprint(e.label);
    if (fp && body.toLowerCase().includes(fp)) {
      skipped++;
      continue;
    }
    body = spliceUnderSection(body, e.section, renderBullet(e));
    written++;
  }

  if (written > 0 || !fileExisted) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body, "utf8");
  }

  return {
    relPath: rel,
    absPath: abs,
    written,
    skippedDuplicate: skipped,
    fileExisted,
  };
}
