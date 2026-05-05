/**
 * Spar skills — workflow playbooks the assistant follows when the
 * user's question matches a known task. Files live under
 * `data/spar-skills/*.md` with Anthropic-style frontmatter:
 *
 *   ---
 *   name: deploy-project
 *   description: How to deploy any project to production
 *   tags: [deploy, ship, push, production, live]
 *   ---
 *   1. Check git status is clean
 *   2. ...
 *
 * The matcher is intentionally simple: lowercase the question, scan
 * for any tag from any skill (whole-word, with hyphens preserved).
 * No embeddings, no fuzzy matching — keeps the cold-path adding zero
 * latency and stays predictable when tags are added/removed.
 */

import fs from "node:fs";
import path from "node:path";

export interface SparSkill {
  name: string;
  description: string;
  tags: string[];
  body: string;
  /** Source path — used for cache invalidation and (eventually) UI. */
  filePath: string;
}

const SKILLS_DIR = path.resolve(process.cwd(), "data", "spar-skills");

interface CacheEntry {
  mtimeMs: number;
  size: number;
  skill: SparSkill;
}

// Per-file cache keyed by absolute path. We re-stat on each call so
// the user can drop a new skill into data/spar-skills/ and have it
// picked up without a restart, but we don't re-read+parse a file
// that hasn't changed.
const cache = new Map<string, CacheEntry>();

/** Parse a single skill file. Best-effort — files with broken
 *  frontmatter return null and the matcher silently skips them. */
function parseSkillFile(filePath: string): SparSkill | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  // Frontmatter: opening `---` line, key:value pairs (or YAML-ish
  // arrays), closing `---` line. We don't need full YAML — just the
  // three keys we care about, parsed line-by-line.
  if (!raw.startsWith("---")) return null;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return null;
  const fmText = raw.slice(3, end).replace(/^\r?\n/, "");
  const body = raw.slice(end + 4).replace(/^\r?\n/, "");
  const fm: Record<string, string> = {};
  for (const line of fmText.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    fm[m[1]] = m[2].trim();
  }
  const name = fm.name?.trim();
  if (!name) return null;
  const description = fm.description?.trim() ?? "";
  const tagsRaw = fm.tags?.trim() ?? "";
  // Accept either `[a, b, c]` or `a, b, c` for tags.
  const tags = tagsRaw
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((t) => t.trim().toLowerCase().replace(/^["']|["']$/g, ""))
    .filter((t) => t.length > 0);
  return {
    name,
    description,
    tags,
    body: body.trim(),
    filePath,
  };
}

/** Load the freshest version of every skill file under SKILLS_DIR.
 *  Missing directory → empty array (skills are optional). */
function loadSkills(): SparSkill[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(SKILLS_DIR);
  } catch {
    return [];
  }
  const skills: SparSkill[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    const fp = path.join(SKILLS_DIR, entry);
    seen.add(fp);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fp);
    } catch {
      continue;
    }
    const cached = cache.get(fp);
    if (
      cached &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      skills.push(cached.skill);
      continue;
    }
    const parsed = parseSkillFile(fp);
    if (!parsed) continue;
    cache.set(fp, { mtimeMs: stat.mtimeMs, size: stat.size, skill: parsed });
    skills.push(parsed);
  }
  // Drop cache entries for files that no longer exist.
  for (const key of [...cache.keys()]) {
    if (!seen.has(key)) cache.delete(key);
  }
  return skills;
}

/** Match the user's most-recent question against every skill's tags.
 *  Returns at most `limit` skills, in the order they're declared on
 *  disk (the alphabetical order readdirSync gives us). One match on
 *  any tag is enough — we don't rank, we just include. */
export function matchSkillsForQuestion(
  question: string,
  limit = 3,
): SparSkill[] {
  const text = (question || "").toLowerCase();
  if (!text.trim()) return [];
  const skills = loadSkills();
  const matched: SparSkill[] = [];
  for (const skill of skills) {
    if (matched.length >= limit) break;
    const hit = skill.tags.some((tag) => {
      if (!tag) return false;
      // Whole-word boundary on both sides — "deploy" should match
      // "let's deploy" but not "redeployment". Hyphens stay part of
      // the token so multi-word tags ("project-status") still work
      // when the user types them with the hyphen.
      const safe = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[^\\w-])${safe}([^\\w-]|$)`);
      return re.test(text);
    });
    if (hit) matched.push(skill);
  }
  return matched;
}

/** Format the matched skills as a block ready to drop into the
 *  system prompt. Empty array → "" so the prompt builder skips the
 *  whole section. */
export function formatSkillsForPrompt(skills: SparSkill[]): string {
  if (!skills.length) return "";
  const lines: string[] = [];
  for (const skill of skills) {
    lines.push(`## ${skill.name}`);
    if (skill.description) lines.push(skill.description);
    lines.push("");
    lines.push(skill.body);
    lines.push("");
  }
  return lines.join("\n").trim();
}
