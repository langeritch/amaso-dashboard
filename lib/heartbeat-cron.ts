import { getDb } from "./db";
import { listHeartbeats, readHeartbeat } from "./heartbeat";
import { pushToUsers } from "./push";
import { collectFromClaudeCli } from "./spar-claude";

const TICK_MIN = Number(process.env.HEARTBEAT_TICK_MIN ?? "30");
const TICK_MS = Math.max(5, TICK_MIN) * 60 * 1000;
// Don't spam the same user more than once every this many minutes, even
// if the LLM keeps saying "yes alert".
const MIN_COOLDOWN_MIN = Number(process.env.HEARTBEAT_COOLDOWN_MIN ?? "60");
const COOLDOWN_MS = MIN_COOLDOWN_MIN * 60 * 1000;

const lastAlertAt = new Map<number, number>();
let timer: NodeJS.Timeout | null = null;

interface AlertVerdict {
  alert: boolean;
  title?: string;
  message?: string;
}

const EVAL_SYSTEM = `You decide whether to interrupt the user with a push
notification right now. Rules:
- Only alert if there is a concrete, time-sensitive item in the heartbeat
  that matches the current time ("today at 15:00", "Friday", etc.), or a
  stale open loop the user is clearly forgetting.
- Prefer silence. A false positive is worse than a missed one.
- Keep title <= 40 chars, message <= 120 chars, spoken-style.

Reply with JSON only, no prose. Shape:
{"alert": true|false, "title": "...", "message": "..."}`;

async function evaluateHeartbeat(heartbeat: string): Promise<AlertVerdict> {
  const now = new Date().toISOString();
  const userMessage = `Current time: ${now}\n\nHeartbeat:\n${heartbeat.trim() || "(empty)"}\n\nShould I alert the user right now? Respond with JSON only.`;
  const raw = await collectFromClaudeCli({
    systemPrompt: EVAL_SYSTEM,
    heartbeat: "",
    history: [{ role: "user", content: userMessage }],
    model: "haiku",
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
    const subs = db
      .prepare("SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1")
      .get(userId);
    if (!subs) continue;
    const heartbeat = readHeartbeat(userId);
    if (!heartbeat.trim()) continue;
    let verdict: AlertVerdict;
    try {
      verdict = await evaluateHeartbeat(heartbeat);
    } catch (err) {
      console.warn("[heartbeat] CLI evaluation failed:", err);
      continue;
    }
    if (!verdict.alert) continue;
    const title = (verdict.title ?? "Heartbeat").slice(0, 40);
    const message = (verdict.message ?? "Something on your plate.").slice(0, 120);
    try {
      await pushToUsers([userId], {
        title,
        body: message,
        url: "/spar",
        tag: "heartbeat",
      });
      lastAlertAt.set(userId, now);
      console.log(`[heartbeat] alerted user ${userId}: ${title}`);
    } catch (err) {
      console.warn("[heartbeat] push failed:", err);
    }
  }
}

export function startHeartbeatCron(): void {
  if (timer) return;
  console.log(`[heartbeat] cron tick every ${TICK_MIN}min (via Claude CLI)`);
  const run = () => {
    void tick().catch((err) => console.warn("[heartbeat] tick error:", err));
  };
  // Fire once after a short delay so the server is fully up, then on interval.
  setTimeout(run, 15_000);
  timer = setInterval(run, TICK_MS);
}
