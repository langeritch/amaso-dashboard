/**
 * Spar model router (Layer 2 of the token-cost reduction work).
 *
 * Picks Opus or Haiku for every spar turn based on a small set of
 * readable heuristics. Sonnet is reserved for one specific edge case
 * (auto-report turns) so the default is a clean 2-tier system: Haiku
 * for short conversational turns, Opus for anything that smells like
 * tool use, brain writes, or real decisions.
 *
 * Layer 1 (prompt caching) is unaffected. The cache_control breakpoints
 * in lib/spar-sdk.ts only depend on the system prompt + brain + tool
 * schemas, none of which the router touches. Cache hits keep working
 * across model swaps (within the same model family on the same prefix).
 *
 * ----------------------------------------------------------------------
 * Rules (in priority order). First match wins.
 * ----------------------------------------------------------------------
 * 1. Caller override (body.model on the request) wins everything. The
 *    mobile client lets the user pin a model explicitly; respect it.
 * 2. Explicit "quick" or "quick:" prefix on the user message: force
 *    Haiku. The user is asking for a fast cheap reply; trust them.
 * 3. Hard floor (Opus, never downgrade):
 *      a. dispatch_to_project intent (dispatch, kick off, send to project, ...)
 *      b. brain file writes (write_brain_file, write_graph,
 *         update_user_profile) — keyword hits on the prompt that imply
 *         the model will call those tools.
 *      c. Real decisions / planning turns: keywords like decide,
 *         decision, plan, architecture, should we, let's go with,
 *         new goal, kill the project, ...
 *      d. Explicit "think hard" anywhere in the message.
 * 4. Auto-report turns ("check the output of terminal for ..." — the
 *    synthetic nudge fired by lib/terminal-idle.ts) floor at Sonnet.
 *    The model often has to summarise + decide the next dispatch;
 *    Sonnet is the cheapest tier that can do both reliably.
 * 5. Length-based default:
 *      < HAIKU_MAX_CHARS → Haiku (short conversational turns, acks,
 *        single-word replies, status checks)
 *      otherwise → Opus (assume tool use or non-trivial reasoning)
 *
 * Every decision is logged to logs/spar-router.jsonl. Read with
 *   tail -f logs/spar-router.jsonl | jq
 * and group by tier to estimate savings.
 *
 * Tuning knobs — change them in one place at the top of this file.
 *   AMASO_SPAR_MODEL_OPUS / _SONNET / _HAIKU env vars override the model
 *   IDs without a redeploy.
 */

import fs from "node:fs";
import path from "node:path";

export type Tier = "opus" | "sonnet" | "haiku" | "custom";

export interface RouterModels {
  opus: string;
  sonnet: string;
  haiku: string;
}

/**
 * Concrete model IDs the router resolves to. Env-overridable so a
 * production swap (new Sonnet rev, emergency rollback) doesn't need a
 * code change.
 */
export const ROUTER_MODELS: RouterModels = {
  opus: process.env.AMASO_SPAR_MODEL_OPUS || "claude-opus-4-7",
  sonnet: process.env.AMASO_SPAR_MODEL_SONNET || "claude-sonnet-4-6",
  haiku: process.env.AMASO_SPAR_MODEL_HAIKU || "claude-haiku-4-5-20251001",
};

/**
 * Hard-floor keyword regexes. Any hit forces Opus regardless of length
 * or other signals. Kept loose on purpose: a false positive costs
 * pennies, a false negative dispatches a project edit on Haiku.
 */
const HARD_FLOOR_PATTERNS: Array<{ rule: string; re: RegExp }> = [
  // dispatch_to_project intent.
  {
    rule: "dispatch-intent",
    re: /\b(dispatch|kick off|send (?:it|this|that|the prompt|to)|push (?:to|into) (?:the )?project|run (?:this|that|it) in|fire off)\b/i,
  },
  // write_brain_file intent. "brain" alone is too generic; require a
  // write-shaped verb nearby OR an explicit brain/memory/daily-log
  // phrase.
  {
    rule: "brain-write-intent",
    re: /\b(write|update|edit|patch|append|add to|drop into|save to|log to|record in|note in)\b[^.\n]{0,40}\b(brain|memory|profile|graph|daily[ _-]?log)\b/i,
  },
  {
    rule: "brain-file-intent",
    re: /\b(brain[ _-]?file|memory[ _-]?file|daily[ _-]?log|knowledge[ _-]?graph)\b/i,
  },
  // write_graph / update_user_profile intent words.
  {
    rule: "graph-write-intent",
    re: /\b(write[ _-]?graph|update[ _-]?graph|add to (?:the )?graph|update (?:my )?profile|remember (?:that|this)|put (?:this|that) on (?:my|the) (?:profile|heartbeat))\b/i,
  },
  // Real decision / planning turns. "should we" is the giveaway for a
  // planning conversation; the rest cover declared decisions and goals.
  {
    rule: "decision-intent",
    re: /\b(decide|decision|let'?s go with|locking in|locked in|kill (?:the |this )?project|new goal|new project|priorities are|i (?:want|need) to (?:remember|track)|should we|what should|do we|are we (?:gonna|going to))\b/i,
  },
  {
    rule: "planning-intent",
    re: /\b(plan|planning|architecture|architect|roadmap|design (?:doc|the system)|strategy|tradeoff|trade-off)\b/i,
  },
];

/** Explicit user overrides. Cheap and obvious. */
const QUICK_PREFIX_RE = /^\s*quick\s*[:.\-,!?\s]/i;
const THINK_HARD_RE = /\bthink\s+hard\b/i;

/**
 * Length threshold, measured on the latest user message body only
 * (not the system prompt or history). Short turns are usually
 * acknowledgements, one-line questions, or status checks; anything
 * longer is assumed to need real reasoning or tool use and routes to
 * Opus.
 */
const HAIKU_MAX_CHARS = 80;

/**
 * Auto-report turns ("check the output of terminal for X") are
 * synthetic nudges fired by lib/terminal-idle.ts after a dispatched
 * task finishes. The model often has to summarise + decide the next
 * dispatch. Floor at Sonnet so we don't waste Opus on the summary but
 * keep enough headroom for the follow-up decision.
 */
const AUTO_REPORT_PREFIX_RE = /^check\s+(?:the\s+)?output\s+of\s+terminal[s]?\s+for\s+/i;

export interface RouteContext {
  /** Latest user message. The router only inspects this text. */
  message: string;
  /** Autopilot mode: we still apply the same rules, but log it so the
   *  audit trail tells us which decisions happened on autopilot. */
  autopilot?: boolean;
  /** Caller-supplied override (body.model on the spar request). Wins
   *  everything when set. Empty string / undefined is ignored. */
  requestedModel?: string;
  /** Conversation row id, for audit grouping. */
  conversationId?: number | null;
  /** User id, for audit grouping. */
  userId?: number | null;
  /** Free-form label so the log distinguishes the four call sites
   *  (api/spar, companion-relay, telegram-respond, mobile-chat). */
  source: string;
}

export interface RouteDecision {
  model: string;
  tier: Tier;
  /** Short human-readable explanation. Goes into the log + the chat
   *  message badge so a tail-able dev session shows the routing
   *  without opening the jsonl. */
  reason: string;
  /** Stable machine-readable rule id. Matches one of the rule names
   *  defined in HARD_FLOOR_PATTERNS plus the synthetic ids below. */
  rule: string;
}

/**
 * Pick the model for one spar turn. Pure function. No I/O.
 *
 * Callers should pass the result's `model` straight through to
 * streamFromClaudeCli / streamFromAnthropicSdk and call
 * `logRoutingDecision` separately so the audit log is written even if
 * the actual stream call later fails.
 */
export function resolveSparModel(ctx: RouteContext): RouteDecision {
  const text = (ctx.message ?? "").trim();

  // Rule 1: caller override always wins.
  if (ctx.requestedModel && ctx.requestedModel.trim()) {
    return {
      model: ctx.requestedModel.trim(),
      tier: "custom",
      reason: `caller override: ${ctx.requestedModel.trim()}`,
      rule: "caller-override",
    };
  }

  // Rule 2: explicit "quick" downgrade. Checked BEFORE hard floors so
  // the user can opt out of e.g. an Opus-dispatch reply when they
  // explicitly want a fast cheap take.
  if (QUICK_PREFIX_RE.test(text)) {
    return {
      model: ROUTER_MODELS.haiku,
      tier: "haiku",
      reason: `explicit downgrade: "quick" prefix`,
      rule: "quick-prefix",
    };
  }

  // Rule 3a-c: hard floors.
  for (const { rule, re } of HARD_FLOOR_PATTERNS) {
    if (re.test(text)) {
      return {
        model: ROUTER_MODELS.opus,
        tier: "opus",
        reason: `hard floor: ${rule} matched`,
        rule,
      };
    }
  }

  // Rule 3d: explicit "think hard" upgrade.
  if (THINK_HARD_RE.test(text)) {
    return {
      model: ROUTER_MODELS.opus,
      tier: "opus",
      reason: `explicit upgrade: "think hard"`,
      rule: "think-hard",
    };
  }

  // Rule 4: auto-report turns floor at Sonnet.
  if (AUTO_REPORT_PREFIX_RE.test(text)) {
    return {
      model: ROUTER_MODELS.sonnet,
      tier: "sonnet",
      reason: "auto-report turn, floored at sonnet",
      rule: "auto-report",
    };
  }

  // Rule 5: length-based default. Measured on the message body alone,
  // not the full prompt. Empty message (kickoff) gets Haiku since the
  // greeting is a short conversational opener.
  const len = text.length;
  if (len < HAIKU_MAX_CHARS) {
    return {
      model: ROUTER_MODELS.haiku,
      tier: "haiku",
      reason: `short turn (${len} chars < ${HAIKU_MAX_CHARS})`,
      rule: "length-haiku",
    };
  }
  return {
    model: ROUTER_MODELS.opus,
    tier: "opus",
    reason: `non-trivial turn (${len} chars), likely tool use or reasoning`,
    rule: "length-opus",
  };
}

// ----------------------------------------------------------------------
// Audit log
// ----------------------------------------------------------------------

const LOG_DIR = path.resolve(process.cwd(), "logs");
const LOG_PATH = path.join(LOG_DIR, "spar-router.jsonl");

let logDirEnsured = false;

function ensureLogDir(): void {
  if (logDirEnsured) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    logDirEnsured = true;
  } catch {
    // Logging is best-effort. If the dir can't be created we silently
    // skip writes rather than break the spar reply.
  }
}

/**
 * Append one routing decision to logs/spar-router.jsonl. Never throws.
 * Schema is intentionally flat so jq queries stay readable.
 */
export function logRoutingDecision(
  decision: RouteDecision,
  ctx: RouteContext,
): void {
  ensureLogDir();
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    source: ctx.source,
    userId: ctx.userId ?? null,
    conversationId: ctx.conversationId ?? null,
    autopilot: ctx.autopilot ?? false,
    requestedModel: ctx.requestedModel || null,
    chosenModel: decision.model,
    tier: decision.tier,
    rule: decision.rule,
    reason: decision.reason,
    messageLength: (ctx.message ?? "").length,
    messagePreview: (ctx.message ?? "").slice(0, 120),
  });
  try {
    fs.appendFileSync(LOG_PATH, line + "\n", "utf8");
  } catch {
    // ignore
  }
  // Console echo so a tail of app.log shows routing decisions without
  // opening the jsonl. Single-line, prefixed for easy grep.
  console.log(
    `[spar-router] source=${ctx.source} tier=${decision.tier} ` +
      `model=${decision.model} rule=${decision.rule} ` +
      `len=${(ctx.message ?? "").length}`,
  );
}

/**
 * Convenience: resolve + log in one call. Returns the same decision.
 * Most call sites want this; the two-step API exists for tests and
 * for callers that want to mutate the decision before logging.
 */
export function routeAndLog(ctx: RouteContext): RouteDecision {
  const decision = resolveSparModel(ctx);
  logRoutingDecision(decision, ctx);
  return decision;
}
