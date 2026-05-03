import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getFillerMode } from "@/lib/filler-mode";
import {
  getYouTubeState,
  reportPosition,
  setActiveOutput,
  stopYouTube,
  type YouTubeOutput,
} from "@/lib/youtube-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Python-facing YouTube state endpoint. The dashboard's own
 * `/api/youtube/state` and `/api/telegram/session` are cookie-gated
 * (apiRequireNonClient); the Python service has no session cookie, so it
 * uses the same X-Auth + service-token pattern as
 * `/api/telegram/acquire` and `/respond`.
 *
 * GET — snapshot the user's YT state + filler mode. Used by the
 * Python filler manager at call start to decide whether to play
 * news (the existing default) or a YouTube stream (when mode=youtube
 * and a videoId is selected).
 *
 * POST — write actions. Two flavours:
 *   action="report_position" + position_sec=N
 *     The Python YouTube player advances the playhead during a call;
 *     this lets the dashboard's resume logic pick up at the right
 *     second when the call ends.
 *   action="set_active_output" + output="dashboard"|"telegram"|"none"
 *     Manual override (rare). The channel-acquire/release path
 *     already flips this in lockstep with the call channel; this is
 *     just an escape hatch for cases like "Python is the source but
 *     the call hasn't formally activated yet".
 *   action="stop"
 *     Symmetric with the dashboard's stop — clears the selection
 *     and flips filler mode back to news. Useful when the YouTube
 *     branch decides the video is unplayable mid-call and wants the
 *     filler manager to fall back cleanly.
 *
 * Auth: TELEGRAM_VOICE_TOKEN env var on Node side, must match
 *       SERVICE_TOKEN on Python side.
 * User: resolved the same way as /acquire — body override → env
 *       (AMASO_TELEGRAM_USER_ID) → first admin user.
 */

interface ReadResponse {
  ok: true;
  user_id: number;
  filler_mode: string;
  youtube: ReturnType<typeof getYouTubeState>;
}

interface PostBody {
  user_id?: number;
  action?: string;
  position_sec?: number;
  output?: YouTubeOutput;
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

function checkAuth(req: NextRequest): NextResponse | null {
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
  return null;
}

export async function GET(req: NextRequest) {
  const fail = checkAuth(req);
  if (fail) return fail;
  const url = new URL(req.url);
  const userIdParam = url.searchParams.get("user_id");
  const userId = resolveUserId(
    userIdParam ? Number(userIdParam) : undefined,
  );
  if (userId == null) {
    return NextResponse.json(
      { ok: false, error: "no admin user" },
      { status: 400 },
    );
  }
  const fillerMode = await getFillerMode();
  const youtube = getYouTubeState(userId);
  const body: ReadResponse = {
    ok: true,
    user_id: userId,
    filler_mode: fillerMode,
    youtube,
  };
  return NextResponse.json(body);
}

export async function POST(req: NextRequest) {
  const fail = checkAuth(req);
  if (fail) return fail;
  let body: PostBody = {};
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const userId = resolveUserId(body.user_id);
  if (userId == null) {
    return NextResponse.json(
      { ok: false, error: "no admin user" },
      { status: 400 },
    );
  }
  const action = (body.action ?? "").trim();
  switch (action) {
    case "report_position": {
      const pos = Number(body.position_sec);
      if (!Number.isFinite(pos)) {
        return NextResponse.json(
          { ok: false, error: "position_sec must be a number" },
          { status: 400 },
        );
      }
      const state = reportPosition(userId, pos);
      return NextResponse.json({ ok: true, youtube: state });
    }
    case "set_active_output": {
      const output = body.output;
      if (output !== "dashboard" && output !== "telegram" && output !== "none") {
        return NextResponse.json(
          { ok: false, error: "output must be dashboard|telegram|none" },
          { status: 400 },
        );
      }
      const state = setActiveOutput(userId, output);
      return NextResponse.json({ ok: true, youtube: state });
    }
    case "stop": {
      const state = stopYouTube(userId);
      return NextResponse.json({ ok: true, youtube: state });
    }
    default:
      return NextResponse.json(
        { ok: false, error: `unknown action: ${action || "(none)"}` },
        { status: 400 },
      );
  }
}
