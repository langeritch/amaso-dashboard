import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSession, releaseChannel } from "@/lib/voice-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Called by the Python telegram-voice service when a call ends
 * (hangup, peer left, discarded, busy). Flips the shared voice
 * session's active channel off Telegram so the dashboard UI un-
 * mutes its TTS, drops the "on Telegram" chip, and the next
 * laptop-side turn lands on the Spar channel cleanly.
 *
 * Auth: same shared-secret token Python uses for /respond.
 * No user cookie — this is service-to-service.
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

  // Only release if we're currently holding it as Telegram. If the
  // laptop has already taken the line back for some reason (unlikely
  // but not impossible — concurrent Spar submit during hangup), a
  // stale hangup shouldn't stomp it.
  const session = getSession(userId);
  if (session?.channel !== "telegram") {
    return NextResponse.json({ ok: true, released: false });
  }

  releaseChannel(userId);
  return NextResponse.json({ ok: true, released: true });
}
