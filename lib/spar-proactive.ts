// Server-side proactive spar turns.
//
// Lets the assistant initiate a message without the user having spoken
// first. Three triggers wired today:
//
//   - dispatch_complete  — a dispatched terminal task just went idle.
//                          Server-side fallback for when the user has
//                          NO spar tab open (tab-open users keep the
//                          existing client-side queueCompletion path
//                          which produces an Opus-quality, voice-
//                          mode-aware reply).
//   - heartbeat          — the heartbeat cron's tier-2 model verdict
//                          said "alert this user". Replaces the bare
//                          push notification with a real spar turn the
//                          user can reply to.
//   - morning_briefing   — fired once per user per day in the 8:30-9:00
//                          window. The brain knows the user wants a
//                          coffee-chat-style daily roundup.
//
// Output of every trigger:
//   1. A persisted assistant message in spar_messages (so it shows up
//      in the sidebar list and the chat once a tab opens).
//   2. A spar:message WS broadcast (so any open tab renders it live).
//   3. A push notification with a slim summary (so the user sees it
//      on their phone even if the dashboard is closed).
//
// Rate limit: 5 minutes per user, ALL triggers combined. The user
// asked explicitly for "max 1 proactive message per 5 minutes". A
// trigger that hits the cooldown is logged-and-dropped.

import { collectFromClaudeCli } from "./spar-claude";
import { getDb, type User } from "./db";
import { getProject } from "./config";
import { readHeartbeat } from "./heartbeat";
import { readProfile } from "./user-profile";
import { loadBrainContext } from "./spar-brain";
import { getStatus as getTerminalStatus } from "./terminal-backend";
import { isAutopilotEnabled, readAutopilotDirective } from "./autopilot";
import { buildAutopilotPromptBlock } from "./autopilot-prompt";
import {
  appendMessage,
  createConversation,
  latestConversationId,
  getRecentMessages,
} from "./spar-conversations";
import { pushToUsers } from "./push";
import { broadcastSparMessage } from "./ws";
import {
  escalateToTelegramCall,
  isCallCooldownActive,
} from "./proactive-telegram";

const PROACTIVE_MODEL = process.env.AMASO_PROACTIVE_MODEL || "haiku";
// Autopilot mode upgrades the auto-report path: sonnet so the loop can
// reason across remarks + tool calls, with enough turns to actually run
// list_recent_remarks → resolve_remark → dispatch_to_project, and a
// looser char cap because the autonomous report needs room to explain
// the decision.
const AUTOPILOT_MODEL = "opus";
const AUTOPILOT_MAX_TURNS = 8;
const AUTOPILOT_MAX_REPLY_CHARS = 4000;
const RATE_LIMIT_MS = Number(process.env.AMASO_PROACTIVE_RATE_LIMIT_MS ?? "300000"); // 5 min
const MAX_PUSH_BODY_CHARS = 120;
const MAX_REPLY_CHARS = 800;

const lastSentAt = new Map<number, number>();

export type ProactiveKind =
  | "dispatch_complete"
  | "heartbeat"
  | "morning_briefing"
  | "custom";

interface BaseInput {
  userId: number;
  kind: ProactiveKind;
  /** Optional override for the rate-limit guard. The morning briefing
   *  uses this so it never gets shadowed by an earlier dispatch ping
   *  fired in the same window. Default: respect the global cooldown. */
  bypassRateLimit?: boolean;
}

interface DispatchCompleteInput extends BaseInput {
  kind: "dispatch_complete";
  projectId: string;
  /** The dispatch row id (passes through to the optional auto-report
   *  log lines so we can correlate). Cosmetic. */
  dispatchId?: string | null;
  /** Stage 3 of remark #285: which terminal session for the project
   *  just went idle. Equals projectId for the legacy single-session
   *  case. The proactive turn uses this to read THAT session's
   *  scrollback (instead of whichever session getStatus(projectId)
   *  resolves first) and to label the trigger line so the autopilot
   *  knows which sibling completed. Optional — fireIdle is the only
   *  caller today and always passes it, but kept loose so future
   *  triggers can stay project-scoped. */
  sessionId?: string;
  /** 1-based ordinal among the project's currently-live sessions when
   *  this turn was queued. Surfaces "session #N" in the prompt when
   *  the project has more than one live session. Snapshotted at fire-
   *  time by the caller (terminal-idle.fireIdle) so a session that
   *  exits between fire and turn-execution doesn't shift the label. */
  sessionOrdinal?: number;
  /** Total live sessions for the project at fire-time. Lets the
   *  prompt builder decide whether to surface the "#N" suffix at all
   *  — solo sessions look identical to pre-Stage-3 prompts. */
  projectSessionCount?: number;
}

interface HeartbeatInput extends BaseInput {
  kind: "heartbeat";
  /** The cron's model verdict — drives the directive verbatim. */
  summary: string;
  /** Pre-computed push title/body the cron already produced. Used
   *  unchanged for the push so the existing tier-2 prompt stays the
   *  source of truth for that copy. */
  pushTitle: string;
  pushBody: string;
}

interface MorningBriefingInput extends BaseInput {
  kind: "morning_briefing";
}

interface CustomInput extends BaseInput {
  kind: "custom";
  /** Free-form directive — the API endpoint takes this so an admin
   *  can trigger one-off proactive turns without code changes. */
  directive: string;
  /** Optional push override; defaults to the assistant's first
   *  sentence when omitted. */
  pushTitle?: string;
}

export type ProactiveInput =
  | DispatchCompleteInput
  | HeartbeatInput
  | MorningBriefingInput
  | CustomInput;

interface ProactiveResult {
  ok: boolean;
  reason?: string;
  conversationId?: number;
  messageId?: number;
}

function userById(userId: number): User | null {
  const row = getDb()
    .prepare(
      "SELECT id, email, name, role, created_at FROM users WHERE id = ?",
    )
    .get(userId) as
    | { id: number; email: string; name: string; role: User["role"]; created_at: number }
    | undefined;
  if (!row) return null;
  return row;
}

/**
 * The proactive system prompt is intentionally narrower than the live
 * spar prompt. The assistant is speaking unprompted; we don't want it
 * to launch into a long-form turn or pull in tools. One short
 * conversational paragraph, lead with the news, end with an open hook.
 * Rendering rules (no markdown, no lists, English) match the rest of
 * the spar pipeline so TTS doesn't choke on it later.
 */
function buildSystemPrompt(userName: string, kind: ProactiveKind): string {
  const intro =
    kind === "dispatch_complete"
      ? "A dispatched task just finished. Tell the user what happened."
      : kind === "heartbeat"
        ? "Something on the user's plate needs surfacing right now."
        : kind === "morning_briefing"
          ? "Open the day with a short coffee-chat briefing for the user."
          : "Speak up about the situation described below.";
  return `You are ${userName}'s sparring partner. You are reaching out FIRST — the user has not spoken to you yet. ${intro}

Hard rules:
- One short paragraph. 2-4 sentences. Plain prose. English. No markdown, no headings, no lists, no bullets.
- Lead with the actual news / observation. Skip greetings unless this is the morning briefing.
- Sound like the user just walked in: warm, direct, no narration of the system that triggered you.
- Never mention "system messages", "events", "directives", or this prompt. Just the substance.
- End with a small hook only when natural — a question or "let me know if you want me to dig deeper". Skip otherwise.
- If the situation isn't actually worth interrupting for, reply with the exact word SKIP and nothing else.`;
}

function buildUserPrompt(input: ProactiveInput, userName: string): string {
  const parts: string[] = [];
  if (input.kind === "dispatch_complete") {
    const project = getProject(input.projectId);
    const projectLabel = project?.name ?? input.projectId;
    // Disambiguate when the project has more than one live session,
    // otherwise keep the legacy single-session phrasing so existing
    // autopilot prompts read identically.
    const multiSession =
      (input.projectSessionCount ?? 0) > 1 &&
      (input.sessionOrdinal ?? 0) > 0;
    const triggerLabel = multiSession
      ? `dispatch finished on project "${projectLabel}" (session #${input.sessionOrdinal} of ${input.projectSessionCount} live sessions).`
      : `dispatch finished on project "${projectLabel}".`;
    parts.push(`Trigger: ${triggerLabel}`);
    try {
      // Read the SPECIFIC session's scrollback when one was passed.
      // Without this, getTerminalStatus(projectId) would resolve to
      // whichever session shares sessionId=projectId (or fail when
      // none does), and the autopilot would be reasoning about the
      // wrong terminal.
      const status = getTerminalStatus(input.projectId, input.sessionId);
      const tail = status.scrollback.slice(-6_000).trim();
      if (tail) {
        parts.push(`Recent terminal output (most recent on the right):`);
        parts.push("```");
        parts.push(tail);
        parts.push("```");
      } else {
        parts.push("No terminal scrollback was captured.");
      }
    } catch (err) {
      parts.push(
        `Could not read terminal scrollback: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    parts.push(
      "Summarise what got done, whether it succeeded, and any open questions. Keep it brief and conversational.",
    );
    if (isAutopilotEnabled(input.userId)) {
      parts.push(
        buildAutopilotPromptBlock({
          directive: readAutopilotDirective(input.userId),
        }),
      );
    }
  } else if (input.kind === "heartbeat") {
    parts.push("Trigger: heartbeat-cron flagged this for the user just now.");
    parts.push(`Cron summary: ${input.summary}`);
    const heartbeat = readHeartbeat(input.userId).trim();
    if (heartbeat) {
      parts.push("User's current heartbeat:");
      parts.push(heartbeat);
    }
    parts.push(
      "Re-state the cron's signal in your own warm voice — one short paragraph the user can act on.",
    );
  } else if (input.kind === "morning_briefing") {
    parts.push(
      `Trigger: morning briefing window for ${userName}. Cover what's on their plate today and any open loops worth surfacing.`,
    );
    const heartbeat = readHeartbeat(input.userId).trim();
    if (heartbeat) {
      parts.push("Current heartbeat:");
      parts.push(heartbeat);
    } else {
      parts.push("Heartbeat is empty — keep the briefing short.");
    }
  } else {
    parts.push(`Trigger: ${input.directive}`);
  }
  return parts.join("\n\n");
}

/** Heuristic: does the heartbeat have any TODAY-tagged item that
 *  isn't crossed off? Walks the "## Today" section verbatim and the
 *  "## Deadlines" section's TODAY rows. Done items are recognised by
 *  trailing ✓ / ✅ / ✔, the literal word "DONE", a `[x]` checkbox, or
 *  GitHub-flavoured strikethrough. Anything else in those sections
 *  is treated as an open item. False positives are tolerable — the
 *  cost of extra phone calls is bounded by the 30-min cooldown. */
function hasUndoneTodayItems(heartbeat: string): boolean {
  if (!heartbeat) return false;
  const sectionRe = /^##\s+(today|deadlines)\b[^\n]*$/gim;
  let match: RegExpExecArray | null;
  while ((match = sectionRe.exec(heartbeat)) !== null) {
    const start = match.index + match[0].length;
    const rest = heartbeat.slice(start);
    const next = rest.search(/^##\s+/m);
    const sectionBody = next === -1 ? rest : rest.slice(0, next);
    const isDeadlineSection = match[1].toLowerCase() === "deadlines";
    for (const raw of sectionBody.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith("-")) continue;
      // The Today section is implicitly all-today; the Deadlines
      // section mixes future dates so we only count rows tagged
      // TODAY (case-insensitive).
      if (isDeadlineSection && !/\bTODAY\b/i.test(line)) continue;
      const done =
        /[✓✅✔]/.test(line) ||
        /\bDONE\b/.test(line) ||
        /\[x\]/i.test(line) ||
        /~~.*~~/.test(line);
      if (!done) return true;
    }
  }
  return false;
}

/** Heuristic: does the recent terminal scrollback look like a
 *  failure? Cheap regex over the tail; the assistant turn itself
 *  always reads the full output via read_terminal_scrollback when
 *  the user follows up. */
function looksLikeTerminalError(scrollback: string): boolean {
  if (!scrollback) return false;
  const tail = scrollback.slice(-4_000);
  return /\b(error|failed|fatal|exception|traceback|panic|denied|cannot find)\b/i.test(
    tail,
  );
}

type Urgency = "high" | "normal";

/** Pick HIGH only when the event genuinely deserves a phone call.
 *  See lib/proactive-telegram.ts for the cooldown and call mechanics. */
function classifyUrgency(
  input: ProactiveInput,
  scrollback: string,
  heartbeat: string,
): Urgency {
  if (input.kind === "morning_briefing") return "high";
  if (input.kind === "dispatch_complete") {
    return looksLikeTerminalError(scrollback) ? "high" : "normal";
  }
  if (input.kind === "heartbeat") {
    return hasUndoneTodayItems(heartbeat) ? "high" : "normal";
  }
  if (input.kind === "custom" && /\burgent\b/i.test(input.directive)) {
    return "high";
  }
  return "normal";
}

function summariseForPush(reply: string): string {
  const cleaned = reply.replace(/\s+/g, " ").trim();
  if (!cleaned) return "Spar wants your attention.";
  // Cut on the first sentence boundary, falling back to a hard char cap.
  const firstStop = cleaned.search(/[.!?](\s|$)/);
  const sentence = firstStop > 0 ? cleaned.slice(0, firstStop + 1) : cleaned;
  if (sentence.length <= MAX_PUSH_BODY_CHARS) return sentence;
  return sentence.slice(0, MAX_PUSH_BODY_CHARS - 1).trimEnd() + "…";
}

/**
 * Fire-and-forget wrapper. Always returns; never throws. Logs failures.
 */
export async function runProactiveTurn(
  input: ProactiveInput,
): Promise<ProactiveResult> {
  const now = Date.now();
  const last = lastSentAt.get(input.userId) ?? 0;
  if (!input.bypassRateLimit && now - last < RATE_LIMIT_MS) {
    const waitS = Math.round((RATE_LIMIT_MS - (now - last)) / 1000);
    console.log(
      `[proactive] rate-limited user=${input.userId} kind=${input.kind} wait=${waitS}s`,
    );
    return { ok: false, reason: "rate_limited" };
  }

  const user = userById(input.userId);
  if (!user) {
    console.warn(`[proactive] unknown user id=${input.userId} kind=${input.kind}`);
    return { ok: false, reason: "unknown_user" };
  }

  const autopilotOn =
    input.kind === "dispatch_complete" && isAutopilotEnabled(input.userId);

  let reply: string;
  try {
    const systemPrompt = buildSystemPrompt(user.name, input.kind);
    const userPrompt = buildUserPrompt(input, user.name);
    let brainBlock = "";
    try {
      brainBlock = loadBrainContext().block;
    } catch {
      /* brain load failed — proceed without */
    }
    const userProfile = readProfile(input.userId);
    reply = await collectFromClaudeCli({
      systemPrompt,
      heartbeat: "",
      userProfile,
      brain: brainBlock,
      history: [{ role: "user", content: userPrompt }],
      model: autopilotOn ? AUTOPILOT_MODEL : PROACTIVE_MODEL,
      maxTurns: autopilotOn ? AUTOPILOT_MAX_TURNS : 1,
    });
  } catch (err) {
    console.warn(
      `[proactive] CLI failed user=${input.userId} kind=${input.kind}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: "cli_failed" };
  }

  const trimmed = reply.replace(/\s+$/g, "").trim();
  if (!trimmed) {
    console.log(`[proactive] empty reply user=${input.userId} kind=${input.kind}`);
    return { ok: false, reason: "empty_reply" };
  }
  if (/^skip\s*$/i.test(trimmed)) {
    console.log(
      `[proactive] model said SKIP user=${input.userId} kind=${input.kind}`,
    );
    return { ok: false, reason: "model_skipped" };
  }
  // Hard cap so a runaway reply can't flood the transcript. Autopilot
  // gets a much higher cap because the autonomous loop reports
  // multi-step decisions (which remark, why, what was dispatched).
  const replyCap = autopilotOn ? AUTOPILOT_MAX_REPLY_CHARS : MAX_REPLY_CHARS;
  const content =
    trimmed.length > replyCap ? trimmed.slice(0, replyCap) + "…" : trimmed;

  // Resolve the destination conversation. If the user has any
  // existing thread we append there so the proactive turn sits in
  // context with whatever the user was last working on. Otherwise
  // we create a fresh thread named server-side (the auto-namer will
  // back-fill once the user replies).
  let conversationId = latestConversationId(input.userId);
  if (conversationId == null) {
    const conv = createConversation(input.userId, null);
    conversationId = conv.id;
  }

  // To keep the model's reply consistent with the live transcript
  // (e.g. if the user just talked about project X and a dispatch on
  // project Y finishes, we'd rather not say "as we discussed" about
  // X), pull the last few messages into the prompt. The append
  // happens regardless of this readback.
  void getRecentMessages(conversationId, 4);

  const persisted = appendMessage({
    conversationId,
    userId: input.userId,
    role: "assistant",
    content,
  });
  if (!persisted) {
    console.warn(
      `[proactive] appendMessage failed user=${input.userId} conv=${conversationId}`,
    );
    return { ok: false, reason: "persist_failed" };
  }

  try {
    broadcastSparMessage(input.userId, {
      conversationId,
      message: {
        id: persisted.id,
        role: persisted.role,
        content: persisted.content,
        toolCalls: persisted.toolCalls,
        createdAt: persisted.createdAt,
      },
    });
  } catch (err) {
    console.warn(
      `[proactive] broadcast failed user=${input.userId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Push notification. The heartbeat cron already produced its own
  // copy; reuse that verbatim. Other triggers derive from the
  // assistant's first sentence so the user sees the same lede in the
  // notification shade and in the conversation.
  const pushTitle =
    input.kind === "heartbeat"
      ? input.pushTitle.slice(0, 80)
      : input.kind === "morning_briefing"
        ? "Morning briefing"
        : input.kind === "dispatch_complete"
          ? (() => {
              const base =
                getProject(input.projectId)?.name ?? input.projectId;
              return (input.projectSessionCount ?? 0) > 1 &&
                (input.sessionOrdinal ?? 0) > 0
                ? `${base} #${input.sessionOrdinal} done`
                : `${base} done`;
            })()
          : (input as CustomInput).pushTitle?.slice(0, 80) ?? "Spar";
  const pushBody =
    input.kind === "heartbeat"
      ? input.pushBody.slice(0, MAX_PUSH_BODY_CHARS)
      : summariseForPush(content);
  const pushUrl = "/spar";
  try {
    await pushToUsers([input.userId], {
      title: pushTitle,
      body: pushBody,
      url: pushUrl,
      tag: `proactive-${input.kind}`,
      data: { kind: input.kind, conversationId },
    });
  } catch (err) {
    console.warn(
      `[proactive] push failed user=${input.userId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  // Telegram-call escalation. Push is the always-on path above; the
  // call is a real interruption that should only fire when the
  // event is genuinely urgent. classifyUrgency picks HIGH on:
  //   • morning_briefing  (the daily ritual the user explicitly
  //                        opted into via brain memory)
  //   • dispatch_complete with error keywords in the scrollback tail
  //   • heartbeat with TODAY items not crossed off
  //   • custom turns whose directive contains "urgent"
  // Cooldown (1 / 30 min) prevents a flurry of urgent events from
  // stacking back-to-back rings on Santi's phone. Fire-and-forget
  // because the call → speak → hangup sequence can take 30 s+ and
  // we don't want to block the runProactiveTurn return.
  try {
    let scrollbackForUrgency = "";
    if (input.kind === "dispatch_complete") {
      try {
        // Same per-session lookup as the prompt builder above —
        // urgency triage has to read the session that actually
        // completed, not whichever session the project resolves to
        // by default.
        scrollbackForUrgency = getTerminalStatus(
          input.projectId,
          input.sessionId,
        ).scrollback;
      } catch {
        /* terminal may be gone — treat as "no error signal" */
      }
    }
    const heartbeatForUrgency =
      input.kind === "heartbeat" || input.kind === "morning_briefing"
        ? readHeartbeat(input.userId)
        : "";
    const urgency = classifyUrgency(
      input,
      scrollbackForUrgency,
      heartbeatForUrgency,
    );
    if (urgency === "high" && !isCallCooldownActive(input.userId)) {
      console.log(
        `[proactive] escalating to telegram call user=${input.userId} kind=${input.kind}`,
      );
      void escalateToTelegramCall({
        userId: input.userId,
        spokenText: content,
      }).catch((err) => {
        console.warn(
          `[proactive] telegram escalation threw user=${input.userId}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  } catch (err) {
    console.warn(
      `[proactive] urgency classification failed user=${input.userId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }

  lastSentAt.set(input.userId, Date.now());
  console.log(
    `[proactive] sent user=${input.userId} kind=${input.kind} conv=${conversationId} msg=${persisted.id} chars=${content.length}`,
  );
  return { ok: true, conversationId, messageId: persisted.id };
}
