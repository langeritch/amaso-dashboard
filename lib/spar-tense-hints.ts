/**
 * Smart Topic System — Layer 6.5: tense-aware recall hints.
 *
 * Pure regex detector that scans a user message for present-perfect /
 * past-perfect tense constructions that almost always reference
 * earlier conversation context. When a match fires, we inject a soft
 * hint into the system prompt for THIS TURN ONLY telling the model:
 *
 *   "User used a perfect tense ('<matched fragment>') — they're
 *    likely referencing earlier context. Consider invoking recall
 *    with <suggested keyword>."
 *
 * The model still decides whether to actually fire recall — the hint
 * nudges, it does not auto-execute. Cost discipline lives in that
 * separation: false-positive regex hits cost a couple of dozen
 * prompt tokens, not a whole recall round-trip.
 *
 * Conservatism is the design principle: false positives waste tokens
 * AND make the hint noise that the model learns to ignore. The
 * matchers + reject list below ship intentionally small. Iterate
 * after we see usage patterns in tense_hint_invocations.
 */

export interface TenseHint {
  /** The exact substring that triggered the match — surfaced to the
   *  model so it can ground its recall call on the same fragment. */
  matchedPhrase: string;
  /** Best-effort salient keyword from the surrounding sentence,
   *  picked by the heuristic below. Null when nothing usable was
   *  found — the model falls back to its own keyword choice. */
  suggestedKeyword: string | null;
  /** Up to ~150 chars of context starting at the matched fragment.
   *  Stored in the audit row for later prompt-engineering review. */
  context: string;
}

// ---------------------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------------------

/**
 * Present-perfect / present-perfect-progressive constructions that
 * lean backwards in time. Verb list is hand-curated: every verb here
 * is one we've actually seen Santi use when he's referencing earlier
 * threads (decisions, lessons, projects). "Got"/"received" style verbs
 * deliberately omitted — they tend to be present-perfect of acquisition
 * (idiomatic), not of conversation.
 */
const PERFECT_PROGRESSIVE = new RegExp(
  "\\b(?:i'?ve|we'?ve|you'?ve|they'?ve|she'?s|he'?s)\\s+been\\s+" +
    "(thinking|talking|discussing|considering|trying|working|struggling|dealing|wondering|chewing|debating|going|planning|building|shipping|stuck)" +
    "\\b",
  "i",
);

const PERFECT_VERB_LIST = new RegExp(
  "\\b(?:i'?ve|we'?ve|you'?ve|they'?ve|she'?s|he'?s)\\s+" +
    "(decided|chosen|finished|completed|settled|figured|talked|discussed|considered|tried|started|agreed|locked\\s+in|signed\\s+off|wrapped|drafted|pitched|reviewed|landed|shipped|killed|paused|resumed|scoped)" +
    "\\b",
  "i",
);

const HAS_HAVE_BEEN = /\b(have|has)\s+been\s+\w+(ing|ed)\b/i;

const PAST_PERFECT = new RegExp(
  "\\bhad\\s+(" +
    "been\\s+\\w+(ing|ed)|" +
    "decided|chosen|finished|completed|settled|figured|talked|discussed|considered|tried|started|agreed|landed|shipped|locked\\s+in" +
    ")\\b",
  "i",
);

/**
 * Reject list — phrases that LOOK perfect-tense but don't actually
 * reference earlier conversation context. Kept short because each
 * entry shaves a real-world false-positive class we've seen.
 */
const REJECT_PATTERNS: RegExp[] = [
  // Idiomatic acquisition — "I've got coffee", "I've got a question"
  /\bi'?ve\s+got\b/i,
  // Second-person question / interrogative — "have you eaten?",
  // "have you seen X?" — these ASK rather than reference.
  /\bhave\s+you\b/i,
  // Weather / generic time — "has it been raining", "has it been long"
  /\bhas\s+it\s+been\b/i,
  // Polite hedges that don't reference past convo — "I've a feeling…",
  // "I've a question" — apostrophe-only contractions, conservative.
  /\bi'?ve\s+a\s+\w+\b/i,
];

// ---------------------------------------------------------------------------
// Keyword extraction
// ---------------------------------------------------------------------------

/**
 * Stopwords for the salient-keyword extractor. Bias: drop the verbs
 * the matchers already pinned (they shouldn't be the keyword) plus
 * function words. Names + proper nouns survive (uppercase detected
 * separately).
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "at",
  "for", "with", "from", "this", "that", "these", "those",
  "is", "was", "are", "were", "been", "be", "being",
  "have", "has", "had",
  "do", "does", "did",
  "will", "would", "should", "could", "can", "may", "might",
  "i", "you", "we", "they", "he", "she", "it",
  "him", "her", "them", "us", "my", "your", "our", "their", "his", "its", "hers",
  "thinking", "talking", "discussing", "wondering", "struggling", "dealing", "considering",
  "trying", "working", "stuck", "wrapping", "drafting", "pitching", "reviewing", "scoping",
  "decided", "chosen", "finished", "completed", "settled", "figured", "talked", "discussed",
  "considered", "tried", "started", "agreed", "landed", "shipped", "killed", "paused",
  "resumed", "again", "really", "just", "also", "still", "more",
  "about", "around", "into", "onto", "over", "through", "while",
  "very", "much", "some", "any", "all", "both", "either", "neither",
  "so", "now", "then", "there", "here", "when", "where", "what",
  "why", "how", "which", "who", "whose",
]);

function extractKeyword(after: string): string | null {
  const cleaned = after
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}'\-\s]/gu, " ");
  const tokens = cleaned
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()));
  if (tokens.length === 0) return null;
  // Prefer the first capitalized word — it's usually the proper-noun
  // anchor of the sentence (project name, person, etc.).
  const proper = tokens.find((t) => /^[A-Z][a-z]/.test(t) || /^[A-Z]{2,}/.test(t));
  if (proper) return proper;
  // Fall back to the longest remaining token — biased toward
  // domain-specific words (which are usually longer than fillers).
  const sorted = [...tokens].sort((a, b) => b.length - a.length);
  return sorted[0] ?? null;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

const MATCHERS: RegExp[] = [
  PERFECT_PROGRESSIVE,
  PERFECT_VERB_LIST,
  HAS_HAVE_BEEN,
  PAST_PERFECT,
];

export function detectTenseHint(text: string): TenseHint | null {
  if (!text || text.length < 3) return null;
  for (const r of REJECT_PATTERNS) {
    if (r.test(text)) return null;
  }
  let match: RegExpExecArray | null = null;
  for (const r of MATCHERS) {
    match = r.exec(text);
    if (match) break;
  }
  if (!match) return null;
  const matchStart = match.index;
  const matchedPhrase = match[0];
  const contextEnd = Math.min(text.length, matchStart + matchedPhrase.length + 150);
  const context = text.slice(matchStart, contextEnd);
  const after = text.slice(matchStart + matchedPhrase.length);
  const suggestedKeyword = extractKeyword(after);
  return { matchedPhrase: matchedPhrase.trim(), suggestedKeyword, context };
}

/**
 * Render the soft hint block that gets appended to the system prompt
 * for the current turn. Kept short on purpose — every token here is
 * paid on every spar turn the gate lets through.
 */
export function buildTenseHintBlock(hint: TenseHint): string {
  const kw = hint.suggestedKeyword
    ? `Suggested call: recall({type:'keyword', value:'${hint.suggestedKeyword}'}).`
    : "Consider invoking recall with a noun from the surrounding sentence.";
  return [
    "Tense hint:",
    `User used a perfect tense ("${hint.matchedPhrase}") — they're likely referencing earlier context.`,
    kw,
    "Only call recall if the noun actually appears in past conversation; otherwise ignore this hint.",
  ].join(" ");
}
