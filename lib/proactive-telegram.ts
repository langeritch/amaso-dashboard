// Telegram call escalation for proactive initiation.
//
// When something is urgent enough, the spar partner can phone Santi
// directly instead of just buzzing his phone. This module owns the
// "should we, can we, do we" decision and the call → speak → hang up
// sequence so spar-proactive.ts stays focused on producing the
// assistant turn.
//
// Constraints:
//   • Cooldown: at most one call per user per 30 minutes. The push
//     is the always-on path; a real ring earns its interruption and
//     should stay rare. The cooldown is in-memory — a dashboard
//     restart resets it, which is acceptable: the watchdog only
//     cycles us when something has actually changed, and an extra
//     call now and then is far less bad than missing a genuine
//     escalation.
//   • If the Python service is unreachable we log once and let the
//     push stand on its own. Same for any service-side error during
//     the call sequence — never throw out of escalateToTelegramCall;
//     the caller already invoked it as fire-and-forget.
//   • If a call is already connected (the user is on a previous
//     proactive call, or talking to spar via the Telegram leg), DO
//     NOT start a new one — speak into the active leg instead. Mid-
//     transition states (dialing/ringing/hanging_up/starting) are
//     too risky to interrupt; we skip and let the push do the work.

import {
  getStatus,
  hangup,
  speak,
  startCall,
  TelegramVoiceUnavailable,
} from "./telegram-voice";

const CALL_COOLDOWN_MS = Number(
  process.env.AMASO_TELEGRAM_CALL_COOLDOWN_MS ?? "1800000", // 30 min
);
const CONNECT_TIMEOUT_MS = Number(
  process.env.AMASO_TELEGRAM_CONNECT_TIMEOUT_MS ?? "30000",
);
const POLL_INTERVAL_MS = 1_000;
// Wall-clock estimate of how long the TTS audio takes to play.
// Empirically Kokoro-en delivers ~13–15 chars per second of audio;
// we round down to 12 to bias toward "wait a touch longer" so the
// hangup never chops the last word. Plus a small tail so the Python
// side finishes flushing before we hang up.
const SPEAK_CHARS_PER_SEC = 12;
const SPEAK_TAIL_PADDING_MS = 2_000;
const SPEAK_MAX_WAIT_MS = 60_000;

const lastCallAt = new Map<number, number>();

/** True if a proactive call has fired for this user inside the
 *  cooldown window. Exported so callers can short-circuit the
 *  urgency check before doing anything expensive. */
export function isCallCooldownActive(userId: number): boolean {
  const last = lastCallAt.get(userId) ?? 0;
  return Date.now() - last < CALL_COOLDOWN_MS;
}

interface EscalateOptions {
  userId: number;
  /** What to say once the call connects. Plain prose, English, no
   *  markdown — same constraints as the /speak endpoint. */
  spokenText: string;
  /** Phone or telegram user_id override for the call. Defaults to
   *  the TARGET_PHONE configured on the Python service (Santi). */
  phone?: string;
  user_id?: number;
}

interface EscalateResult {
  ok: boolean;
  reason: string;
}

export async function escalateToTelegramCall(
  opts: EscalateOptions,
): Promise<EscalateResult> {
  const text = opts.spokenText.trim();
  if (!text) return { ok: false, reason: "empty_text" };

  if (isCallCooldownActive(opts.userId)) {
    const since = Math.round(
      (Date.now() - (lastCallAt.get(opts.userId) ?? 0)) / 1000,
    );
    console.log(
      `[proactive-tg] cooldown active user=${opts.userId} (${since}s since last call)`,
    );
    return { ok: false, reason: "cooldown" };
  }

  let status;
  try {
    status = await getStatus();
  } catch (err) {
    if (err instanceof TelegramVoiceUnavailable) {
      console.info(
        `[proactive-tg] service unreachable user=${opts.userId} — skipping call`,
      );
      return { ok: false, reason: "service_unavailable" };
    }
    console.warn(
      `[proactive-tg] status check failed user=${opts.userId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: "status_failed" };
  }

  if (status.state === "connected") {
    // Active call: piggy-back. The cooldown still updates so a
    // flurry of urgent events doesn't stack five utterances back-
    // to-back into a call the user is already on.
    try {
      await speak({ text });
      lastCallAt.set(opts.userId, Date.now());
      console.log(
        `[proactive-tg] piggy-backed onto active call user=${opts.userId} chars=${text.length}`,
      );
      return { ok: true, reason: "piggyback" };
    } catch (err) {
      console.warn(
        `[proactive-tg] piggyback speak failed user=${opts.userId}:`,
        err instanceof Error ? err.message : String(err),
      );
      return { ok: false, reason: "piggyback_failed" };
    }
  }

  if (status.state !== "idle") {
    // Mid-transition (dialing, ringing, hanging_up, starting).
    // Calling again would race the existing leg.
    console.log(
      `[proactive-tg] busy state=${status.state} user=${opts.userId} — skipping call`,
    );
    return { ok: false, reason: `busy_${status.state}` };
  }

  // Reserve the cooldown BEFORE the call so a slow ring + a second
  // urgent event in the same window don't stack two outgoing rings
  // on the user's phone.
  lastCallAt.set(opts.userId, Date.now());

  try {
    await startCall({
      ...(opts.phone ? { phone: opts.phone } : {}),
      ...(opts.user_id ? { user_id: opts.user_id } : {}),
    });
  } catch (err) {
    if (err instanceof TelegramVoiceUnavailable) {
      console.info(
        `[proactive-tg] service unreachable on startCall user=${opts.userId}`,
      );
      return { ok: false, reason: "service_unavailable" };
    }
    console.warn(
      `[proactive-tg] startCall failed user=${opts.userId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, reason: "start_failed" };
  }

  const connected = await waitForConnect(CONNECT_TIMEOUT_MS);
  if (!connected) {
    console.warn(
      `[proactive-tg] no pickup within ${CONNECT_TIMEOUT_MS}ms user=${opts.userId} — pushing instead`,
    );
    try {
      await hangup();
    } catch {
      /* best effort */
    }
    return { ok: false, reason: "no_pickup" };
  }

  try {
    await speak({ text });
  } catch (err) {
    console.warn(
      `[proactive-tg] speak failed user=${opts.userId}:`,
      err instanceof Error ? err.message : String(err),
    );
    try {
      await hangup();
    } catch {
      /* ignore */
    }
    return { ok: false, reason: "speak_failed" };
  }

  // Wait long enough for the audio to actually play before hanging
  // up. /speak returns when the bytes are queued, not when playback
  // finishes — cutting the call early chops the message off mid-
  // word. Hard cap at 60s so a runaway estimate can't pin us open.
  const speakDurationMs = Math.min(
    Math.ceil(text.length / SPEAK_CHARS_PER_SEC) * 1000 + SPEAK_TAIL_PADDING_MS,
    SPEAK_MAX_WAIT_MS,
  );
  await new Promise((r) => setTimeout(r, speakDurationMs));

  try {
    await hangup();
  } catch (err) {
    console.warn(
      `[proactive-tg] hangup failed user=${opts.userId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  console.log(
    `[proactive-tg] delivered call user=${opts.userId} chars=${text.length}`,
  );
  return { ok: true, reason: "delivered" };
}

async function waitForConnect(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let s;
    try {
      s = await getStatus();
    } catch {
      return false;
    }
    if (s.state === "connected") return true;
    if (s.state === "idle" || s.state === "hanging_up") return false;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}
