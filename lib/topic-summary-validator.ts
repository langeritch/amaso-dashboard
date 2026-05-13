/**
 * Remark #431 — topic / subject summary quality validator.
 *
 * Pure function. Given a summary string and a set of acceptable topic
 * labels (title + aliases), returns `{ ok, reasons, signals }`:
 *
 *   ok       = passed every check.
 *   reasons  = which checks failed (empty array on pass).
 *   signals  = the concrete-detail signals we found, for logging.
 *
 * Two checks ship in this first cut:
 *
 *   1. NAME ANCHOR — the summary mentions at least one of the topic
 *      labels (case-insensitive substring, normalised through a
 *      whitespace + punctuation strip). Slug fragments count as
 *      aliases for free — "hyet-pricing" → ["hyet", "pricing"].
 *
 *   2. CONCRETE DETAIL — the summary is at least 40 chars AND
 *      contains at least one of:
 *        • a number (digit run)
 *        • a date-shaped fragment (YYYY-MM-DD or 'Friday'/'May' etc.)
 *        • a proper noun (capitalised token mid-sentence)
 *        • a verb-noun decision phrase: decided / shipped / chose /
 *          locked / picked / launched / finished / merged / killed
 *          followed by a noun within ~3 tokens
 *
 * Conservative on purpose: a vague summary that happens to mention
 * the label still passes if it has a concrete signal. The bar is
 * "could a future reader pull anything actionable from this", not
 * "is this prose elegant."
 *
 * Never throws. Empty / null / non-string inputs return ok=false with
 * a 'empty' reason — callers treat that as a weak summary.
 */

export type SummaryValidationReason =
  | "empty"
  | "no-name-anchor"
  | "too-short"
  | "no-concrete-detail";

export interface SummaryValidation {
  ok: boolean;
  reasons: SummaryValidationReason[];
  signals: string[];
}

const MIN_DETAIL_CHARS = 40;

const VERB_NOUN_RE = new RegExp(
  "\\b(decided|chose|chosen|locked|picked|shipped|launched|finished|merged|killed|" +
    "agreed|settled|wrapped|landed|deployed|drafted|signed|paused|resumed|scoped|" +
    "rejected|approved|cancelled|cancelled|completed|started|kicked|reviewed|" +
    "added|removed|fixed|broke|migrated|switched|moved)" +
    "(\\s+\\w+){1,3}",
  "i",
);

const DATE_RE = new RegExp(
  "\\b(?:\\d{4}-\\d{2}-\\d{2}" +
    "|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*" +
    "|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\s+\\d{1,2}" +
    "|monday|tuesday|wednesday|thursday|friday|saturday|sunday" +
    "|next\\s+week|last\\s+week|today|tomorrow|yesterday)" +
    "\\b",
  "i",
);

const NUMBER_RE = /\b\d+([.,]\d+)?\b/;

// Capitalised proper-noun: a token that starts uppercase mid-sentence
// (i.e. has at least one preceding word). We split on whitespace and
// require ≥1 token before the candidate.
function hasProperNoun(text: string): boolean {
  const tokens = text.split(/\s+/);
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!t) continue;
    // Skip uppercase-only words (acronyms can pass) but require at
    // least one lowercase letter after the cap to filter ALL-CAPS
    // shouting words.
    if (/^[A-Z][a-z]/.test(t) || /^[A-Z]{2,}/.test(t)) return true;
  }
  return false;
}

function normalise(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Build the list of acceptable names from a topic title + optional
 * slug + aliases. We split slugs on hyphens / underscores so a slug
 * like 'hyet-pricing' gives us two distinct anchor candidates the
 * summary can match against. Single-character tokens are dropped to
 * avoid false-positives from articles / single letters.
 */
export function buildNameAnchors(input: {
  title?: string | null;
  slug?: string | null;
  aliases?: string[] | null;
}): string[] {
  const out: string[] = [];
  const push = (raw: string | null | undefined) => {
    if (!raw) return;
    const trimmed = raw.replace(/\s+/g, " ").trim();
    if (!trimmed) return;
    out.push(trimmed.toLowerCase());
    // Split slugs / hyphenated phrases into their parts so a 2-word
    // title still anchors if the summary uses only one of the words.
    for (const part of trimmed.split(/[\s_\-]+/)) {
      if (part.length >= 3) out.push(part.toLowerCase());
    }
  };
  push(input.title);
  push(input.slug);
  for (const a of input.aliases ?? []) push(a);
  // Dedupe.
  return Array.from(new Set(out));
}

export function validateSummary(
  summary: string | null | undefined,
  topic: { title?: string | null; slug?: string | null; aliases?: string[] | null },
): SummaryValidation {
  const reasons: SummaryValidationReason[] = [];
  const signals: string[] = [];

  const raw = typeof summary === "string" ? summary.trim() : "";
  if (!raw) {
    return { ok: false, reasons: ["empty"], signals: [] };
  }

  const normalised = normalise(raw);

  // Name anchor check.
  const anchors = buildNameAnchors(topic);
  const hasAnchor = anchors.some((a) => normalised.includes(a));
  if (!hasAnchor) reasons.push("no-name-anchor");

  // Concrete-detail check.
  if (raw.length < MIN_DETAIL_CHARS) {
    reasons.push("too-short");
  } else {
    if (NUMBER_RE.test(raw)) signals.push("number");
    if (DATE_RE.test(raw)) signals.push("date");
    if (hasProperNoun(raw)) signals.push("proper-noun");
    if (VERB_NOUN_RE.test(raw)) signals.push("verb-noun");
    if (signals.length === 0) reasons.push("no-concrete-detail");
  }

  return { ok: reasons.length === 0, reasons, signals };
}

/**
 * Convenience wrapper that turns the validation outcome into the
 * quality_flag string the DB stores. Pass → 'pass'. Any failure →
 * 'weak'. Distinguished string lets the writer decide whether to
 * regenerate or accept-as-weak based on retry context.
 */
export function qualityFlag(validation: SummaryValidation): "pass" | "weak" {
  return validation.ok ? "pass" : "weak";
}
