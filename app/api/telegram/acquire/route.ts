import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { activateChannel } from "@/lib/voice-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Called by the Python telegram-voice service the instant a call
 * becomes non-idle (ringing, dialing, or connected). The existing
 * /respond endpoint was the *only* path that flipped the shared
 * channel to "telegram" — but it doesn't fire until Whisper has
 * transcribed the caller's first utterance, which can be 2–10 s
 * after the call is already live. During that gap the dashboard
 * kept playing TTS into the phone. This endpoint closes that gap
 * by letting Python signal "I have the audio, mute yourself now"
 * before anyone speaks.
 *
 * It is safe to call repeatedly — activateChannel is a no-op when
 * the channel is already "telegram".
 *
 * Auth: the same shared-secret token as /respond and /release.
 */

interface Body {
  user_id?: number;
}

function resolveUserId(override: number | undefined): number | null {
  if (typeof override === "number" && override > 0) return override;
  const envOverride = Number(process.env.AMASO_TELEGRAM_USER_ID || 0);
  if (envOverride > 0) return envOverride;
  const row = getDb()
    .prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`)
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

export async function POST(req: NextRequest) {
  const expected = (process.env.TELEGRAM_VOICE_TOKEN || "").trim();
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "TELEGRAM_VOICE_TOKEN not set" },
      { status: 503 },
    );
  }
  if (req.headers.get("x-auth") !== expected) {
    return NextResponse.json({ ok: false, error: "bad token" }, { status: 401 });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* empty body is fine */
  }

  const userId = resolveUserId(body.user_id);
  if (userId == null) {
    return NextResponse.json({ ok: false, error: "no admin user" }, { status: 400 });
  }

  const { session, tookOver } = activateChannel(userId, "telegram");
  return NextResponse.json({
    ok: true,
    session_id: session.id,
    took_over_from: tookOver ? session.previousChannel : null,
  });
}
