import { getDb } from "./db";
import { listHeartbeats, readHeartbeat } from "./heartbeat";
import { pushToUsers } from "./push";
import { collectFromClaudeCli } from "./spar-claude";
import { loadConfig } from "./config";
import { getStatus as getTerminalStatus } from "./terminal-backend";
import { runProactiveTurn } from "./spar-proactive";

const TICK_MIN = Number(process.env.HEARTBEAT_TICK_MIN ?? "30");
const TICK_MS = Math.max(5, TICK_MIN) * 60 * 1000;
// Don't spam the same user more than once every this many minutes, even
// if the LLM keeps saying "yes alert".
const MIN_COOLDOWN_MIN = Number(process.env.HEARTBEAT_COOLDOWN_MIN ?? "60");
const COOLDOWN_MS = MIN_COOLDOWN_MIN * 60 * 1000;

// Activity gate — skip users who haven't touched the dashboard in this
// window entirely. Zero cost for inactive users, which is most of them
// most of the time. 24h is generous enough to still catch users who
// only show up once a day for a morning briefing.
const ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1000;

// Tier-1 staleness threshold — if the heartbeat body hasn't changed
// in this long AND has any open loops, escalate to Tier 2 to prompt
// for an update or a nudge.
const STALE_HEARTBEAT_MS = 4 * 60 * 60 * 1000;

// Heartbeat model is the same Opus the rest of the spar pipeline uses.
// Tier 1 makes the calls cheap on average — most ticks short-circuit
// before reaching the model — but when we DO call, we want the same
// quality of judgement as the live conversation. Never downgrade to
// Haiku here; the cost saving comes from skipping the model, not from
// using a worse one.
const HEARTBEAT_MODEL = process.env.AMASO_SPAR_MODEL || "claude-opus-4-6";

const lastAlertAt = new Map<number, number>();
let timer: NodeJS.Timeout | null = null;

interface AlertVerdict {
  alert: boolean;
  title?: string;
  message?: string;
  summary?: string;
}

interface Tier1Results {
  reasons: string[];
  openRemarks: number;
  hasTimeKeyword: boolean;
  isStale: boolean;
  staleHours: number;
  idleTerminals: string[];
  /** True when this tick fell inside the user's morning-briefing
   *  window (08:30-09:00 local) and they haven't been briefed today.
   *  Bypasses tier-2 entirely — the briefing is its own proactive
   *  turn rather than a "should we alert?" check. */
  morningBriefing: boolean;
}

const EVAL_SYSTEM = `You decide whether to interrupt the user with a push
notification right now. Tier-1 deterministic checks already detected at
least one signal (open remarks, idle terminal, time-sensitive heartbeat
content, stale heartbeat). Your job is to decide if the signal is worth
pushing or should stay silent.

The heartbeat is the user's "rolling right now" layer. It is
intentionally LEAN — three sections only:
  1. Now — what they are actively doing (1-2 lines)
  2. Today — time-bound commitments for today
  3. Open loops — things needing attention soon, not urgent right now

Project history, team plans, financial strategy, build backlogs all
live in separate brain files (projects.md, decisions.md, goals.md,
project_*.md). Do NOT propose adding any of that into the heartbeat —
it must stay short.

Rules:
- Only alert if there is a concrete, time-sensitive item that matches
  the current time ("today at 15:00", "Friday", etc.), a stale open
  loop the user is clearly forgetting, or a project terminal that's
  blocked waiting on the user.
- Prefer silence. A false positive is worse than a missed one.
- Keep title <= 40 chars, message <= 120 chars, spoken-style.
- "summary" is for the heartbeat tick log — one short sentence
  describing what you observed and why you did or did not alert.

Reply with JSON only, no prose. Shape:
{"alert": true|false, "title": "...", "message": "...", "summary": "..."}`;

interface Tier1Signal {
  /** Short reason this user warranted Tier-2 evaluation. Surfaced into
   *  the prompt so the model knows what triggered the call. */
  reason: string;
  /** Optional structured details that ride along into the prompt. */
  detail?: string;
  /** Structured snapshot of which checks fired — written to
   *  heartbeat_ticks.tier1_results so the UI can replay them. */
  results: Tier1Results;
}

// Per-user "last morning briefing fired on <YYYY-MM-DD>" so the
// proactive turn fires once a day even if the cron ticks twice
// inside the briefing window.
const lastMorningBriefingDay = new Map<number, string>();

function localDayKey(now: Date): string {
  const y = now.getFullYear();
  const m = `${now.getMonth() + 1}`.padStart(2, "0");
  const d = `${now.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isMorningBriefingWindow(now: Date): boolean {
  // 08:30 - 09:00 local. The user's stored preference is 08:45 (see
  // memory user_morning_briefing); a 30-minute window absorbs the
  // 30-minute cron tick without missing the slot.
  const h = now.getHours();
  const m = now.getMinutes();
  if (h !== 8) return false;
  return m >= 30 && m < 60;
}

const TIME_SENSITIVE_PATTERN =
  /\b(today|tonight|tomorrow|this morning|this afternoon|this evening|in \d+ ?(?:m|min|minute|h|hr|hour)s?|at \d{1,2}(:\d{2})? ?(?:am|pm)?|by \d{1,2}(:\d{2})?|deadline|due (?:today|tomorrow|by)|asap|urgent|right now)\b/i;

function lastActivityAt(userId: number): number {
  // Latest of: last heartbeat ping (live tab) or last activity log row.
  // We don't read user_activity directly because page_visit events fire
  // every route change — presence captures the same signal cheaper.
  const db = getDb();
  const presence = db
    .prepare(
      `SELECT MAX(last_seen_at) AS t FROM user_presence WHERE user_id = ?`,
    )
    .get(userId) as { t: number | null } | undefined;
  const action = db
    .prepare(
      `SELECT MAX(at) AS t FROM user_activity WHERE user_id = ? AND kind = 'action'`,
    )
    .get(userId) as { t: number | null } | undefined;
  return Math.max(presence?.t ?? 0, action?.t ?? 0);
}

function unresolvedRemarkCount(userId: number): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM remarks WHERE user_id = ? AND resolved_at IS NULL`,
    )
    .get(userId) as { n: number };
  return row.n;
}

function heartbeatMtime(userId: number): number {
  // listHeartbeats gives us mtime per file. We re-use it instead of a
  // second fs.stat because it's already cached as a single readdir.
  const entries = listHeartbeats();
  const match = entries.find((e) => e.userId === userId);
  return match?.mtime ?? 0;
}

function checkTier1(userId: number, heartbeat: string, now: number): Tier1Signal | null {
  // 1. Open remarks — if anything is sitting unresolved, the user
  //    probably wants a periodic nudge. We don't escalate JUST on
  //    remark count (it'd alert every tick); the model still has the
  //    final say. But this counts as a signal that warrants thinking.
  const openRemarks = unresolvedRemarkCount(userId);

  // 2. Time-sensitive content in the heartbeat body — words that say
  //    "this is happening soon".
  const hasTimeKeyword = TIME_SENSITIVE_PATTERN.test(heartbeat);

  // 3. Stale heartbeat — body hasn't been touched in a while. Only
  //    interesting if it's non-empty (otherwise nothing to be stale
  //    about) and there are also open loops to nudge on.
  const mtime = heartbeatMtime(userId);
  const staleAge = mtime > 0 ? now - mtime : 0;
  const isStale =
    heartbeat.trim().length > 0 &&
    staleAge >= STALE_HEARTBEAT_MS &&
    openRemarks > 0;

  // 4. Idle terminals — any project whose Claude Code terminal is
  //    running but has been quiet for a while. We don't have per-line
  //    timestamps inside the scrollback ring buffer, so the heuristic
  //    is just "is there a terminal session attached and visibly at a
  //    permission gate". We surface RUNNING + tail of scrollback for
  //    Tier 2 to evaluate.
  const idleTerminals: string[] = [];
  for (const project of loadConfig().projects) {
    const status = getTerminalStatus(project.id);
    if (!status.running) continue;
    const tail = status.scrollback.slice(-2000);
    // Permission gates and prompt waits are the gates worth alerting on
    // — a quietly running build is not. The TUI uses these phrases.
    if (/\b(permission|approve|continue\?|\(y\/n\))\b/i.test(tail)) {
      idleTerminals.push(project.id);
    }
  }

  // 5. Morning briefing window. Once-per-day proactive turn at the
  //    user's preferred 08:45 slot. Doesn't depend on any other
  //    signal — even an empty heartbeat gets the briefing because
  //    the user explicitly wants the wake-up touchpoint.
  const nowDate = new Date(now);
  const morningBriefing =
    isMorningBriefingWindow(nowDate) &&
    lastMorningBriefingDay.get(userId) !== localDayKey(nowDate);

  if (
    !hasTimeKeyword &&
    !isStale &&
    idleTerminals.length === 0 &&
    openRemarks === 0 &&
    !morningBriefing
  ) {
    return null;
  }

  const reasons: string[] = [];
  if (morningBriefing) reasons.push("morning briefing window");
  if (hasTimeKeyword) reasons.push("time-sensitive heartbeat content");
  if (isStale) reasons.push(`heartbeat stale ${Math.round(staleAge / 3_600_000)}h with open loops`);
  if (idleTerminals.length) reasons.push(`terminal awaiting input: ${idleTerminals.join(", ")}`);
  if (openRemarks > 0) reasons.push(`${openRemarks} open remark${openRemarks === 1 ? "" : "s"}`);

  // Time-sensitive content + idle terminal + stale-with-loops are the
  // strong signals. Open remarks alone is a weak signal — we still
  // pass it through to the model, but we don't fabricate stronger
  // detail strings that bias the verdict.
  return {
    reason: reasons.join("; "),
    detail: idleTerminals.length
      ? `Idle terminals: ${idleTerminals.join(", ")}`
      : undefined,
    results: {
      reasons,
      openRemarks,
      hasTimeKeyword,
      isStale,
      staleHours: staleAge > 0 ? Math.round(staleAge / 3_600_000) : 0,
      idleTerminals,
      morningBriefing,
    },
  };
}

function recordTick(
  userId: number,
  at: number,
  status: "ok" | "alert",
  tier1: Tier1Results | null,
  tier2Summary: string | null,
  notified: boolean,
): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO heartbeat_ticks (user_id, at, status, tier1_results, tier2_summary, notified)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        at,
        status,
        tier1 ? JSON.stringify(tier1) : null,
        tier2Summary,
        notified ? 1 : 0,
      );
  } catch (err) {
    console.warn("[heartbeat] failed to record tick:", err);
  }
}

async function evaluateHeartbeat(
  heartbeat: string,
  signal: Tier1Signal,
): Promise<AlertVerdict> {
  const now = new Date().toISOString();
  const detailLine = signal.detail ? `\n${signal.detail}` : "";
  const userMessage = `Current time: ${now}\n\nTier-1 signal: ${signal.reason}${detailLine}\n\nHeartbeat:\n${heartbeat.trim() || "(empty)"}\n\nShould I alert the user right now? Respond with JSON only.`;
  const raw = await collectFromClaudeCli({
    systemPrompt: EVAL_SYSTEM,
    heartbeat: "",
    history: [{ role: "user", content: userMessage }],
    model: HEARTBEAT_MODEL,
  });
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { alert: false };
  try {
    return JSON.parse(m[0]) as AlertVerdict;
  } catch {
    return { alert: false };
  }
}

async function tick(): Promise<void> {
  const entries = listHeartbeats();
  if (entries.length === 0) return;
  const db = getDb();
  const now = Date.now();
  for (const { userId } of entries) {
    const last = lastAlertAt.get(userId) ?? 0;
    if (now - last < COOLDOWN_MS) continue;

    // Activity gate — cheapest possible filter, runs first. A user who
    // hasn't been on the dashboard in 24h almost certainly isn't going
    // to act on a push right now either. Skipping them costs nothing.
    if (now - lastActivityAt(userId) > ACTIVITY_WINDOW_MS) continue;

    const subs = db
      .prepare("SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1")
      .get(userId);
    if (!subs) continue;

    const heartbeat = readHeartbeat(userId);
    if (!heartbeat.trim()) continue;

    // Tier 1 — deterministic checks. ~ms, no model call.
    const signal = checkTier1(userId, heartbeat, now);
    if (!signal) {
      console.log(`[heartbeat] user ${userId} HEARTBEAT_OK (no tier-1 signal)`);
      recordTick(userId, now, "ok", null, null, false);
      continue;
    }

    // Morning briefing path — bypass tier-2. The user explicitly
    // asked for an 08:45 daily touchpoint; we don't need a model
    // verdict on whether to send it. The proactive helper handles
    // the persona, persists the message, and sends the push.
    if (signal.results.morningBriefing) {
      const dayKey = localDayKey(new Date(now));
      // Stamp BEFORE the await so a slow CLI call can't double-fire
      // when the next 30-min tick lands inside the same window.
      lastMorningBriefingDay.set(userId, dayKey);
      lastAlertAt.set(userId, now);
      try {
        const result = await runProactiveTurn({
          userId,
          kind: "morning_briefing",
          bypassRateLimit: true,
        });
        recordTick(
          userId,
          now,
          "alert",
          signal.results,
          result.ok
            ? `Morning briefing sent (conv=${result.conversationId} msg=${result.messageId}).`
            : `Morning briefing skipped: ${result.reason ?? "unknown"}.`,
          result.ok,
        );
        if (result.ok) {
          console.log(`[heartbeat] morning briefing sent to user ${userId}`);
        } else {
          // Roll back the day stamp so we can retry on the next
          // tick when the helper said "rate_limited" / "cli_failed".
          if (result.reason !== "model_skipped") {
            lastMorningBriefingDay.delete(userId);
          }
          console.log(
            `[heartbeat] morning briefing skipped for user ${userId}: ${result.reason ?? "unknown"}`,
          );
        }
      } catch (err) {
        lastMorningBriefingDay.delete(userId);
        recordTick(
          userId,
          now,
          "alert",
          signal.results,
          `Morning briefing threw: ${err instanceof Error ? err.message : String(err)}`,
          false,
        );
      }
      continue;
    }

    // Tier 2 — model call. Only reached when tier 1 found a reason.
    let verdict: AlertVerdict;
    try {
      verdict = await evaluateHeartbeat(heartbeat, signal);
    } catch (err) {
      console.warn("[heartbeat] CLI evaluation failed:", err);
      recordTick(
        userId,
        now,
        "alert",
        signal.results,
        `Tier-2 evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
      continue;
    }
    if (!verdict.alert) {
      console.log(
        `[heartbeat] user ${userId} signal=${signal.reason} → model said no alert`,
      );
      recordTick(
        userId,
        now,
        "alert",
        signal.results,
        verdict.summary ?? `Model declined to alert. Tier-1: ${signal.reason}.`,
        false,
      );
      continue;
    }
    const title = (verdict.title ?? "Heartbeat").slice(0, 40);
    const message = (verdict.message ?? "Something on your plate.").slice(0, 120);
    // Stamp lastAlertAt before the await so a flapping cron can't
    // re-enter the alert path mid-flight.
    lastAlertAt.set(userId, now);
    let pushed = false;
    let proactiveNote: string | null = null;
    try {
      const result = await runProactiveTurn({
        userId,
        kind: "heartbeat",
        summary: verdict.summary ?? `${title} — ${message}`,
        pushTitle: title,
        pushBody: message,
      });
      pushed = result.ok;
      proactiveNote = result.ok
        ? `proactive turn sent (conv=${result.conversationId} msg=${result.messageId})`
        : `proactive turn skipped: ${result.reason ?? "unknown"}`;
      if (!result.ok) {
        // Fall back to the bare push so the user still gets nudged
        // when the proactive path was rate-limited / model said skip.
        try {
          await pushToUsers([userId], {
            title,
            body: message,
            url: "/spar",
            tag: "heartbeat",
          });
          pushed = true;
        } catch (err) {
          console.warn("[heartbeat] fallback push failed:", err);
        }
      }
      console.log(`[heartbeat] alerted user ${userId}: ${title} (${proactiveNote})`);
    } catch (err) {
      console.warn("[heartbeat] proactive turn threw:", err);
      try {
        await pushToUsers([userId], {
          title,
          body: message,
          url: "/spar",
          tag: "heartbeat",
        });
        pushed = true;
      } catch (innerErr) {
        console.warn("[heartbeat] fallback push failed:", innerErr);
      }
    }
    recordTick(
      userId,
      now,
      "alert",
      signal.results,
      `${verdict.summary ?? `${title} — ${message}`}${proactiveNote ? ` (${proactiveNote})` : ""}`,
      pushed,
    );
  }
}

export function startHeartbeatCron(): void {
  if (timer) return;
  console.log(
    `[heartbeat] cron tick every ${TICK_MIN}min — tier-1 checks first, ${HEARTBEAT_MODEL} only on signal`,
  );
  const run = () => {
    void tick().catch((err) => console.warn("[heartbeat] tick error:", err));
  };
  // Fire once after a short delay so the server is fully up, then on interval.
  setTimeout(run, 15_000);
  timer = setInterval(run, TICK_MS);
}
