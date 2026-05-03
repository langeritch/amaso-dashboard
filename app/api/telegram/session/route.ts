import { NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { getSession } from "@/lib/voice-session";
import { getYouTubeState } from "@/lib/youtube-state";
import { getFillerMode } from "@/lib/filler-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Snapshot of the user's voice session — the single shared
 * conversation across Spar, Telegram, and chat. Returns null if no
 * session is live or it's past the staleness window.
 *
 * Polled by the voice UI on a short cadence. All in-memory so this
 * is effectively free.
 *
 * Also piggybacks the YouTube filler state so the browser's hook
 * can react to MCP-tool-triggered "play this video" without opening
 * a second poll loop — the existing 100 ms cadence already matches
 * the latency we want for filler transitions.
 */
export async function GET() {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  const [youtube, fillerMode] = await Promise.all([
    Promise.resolve(getYouTubeState(auth.user.id)),
    getFillerMode(),
  ]);
  const session = getSession(auth.user.id);
  if (!session) {
    return NextResponse.json({ session: null, youtube, fillerMode });
  }
  return NextResponse.json({
    session: {
      id: session.id,
      channel: session.channel,
      previousChannel: session.previousChannel,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      turns: session.turns,
    },
    youtube,
    fillerMode,
  });
}
