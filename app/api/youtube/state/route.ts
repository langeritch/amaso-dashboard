import { NextRequest, NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import {
  getYouTubeState,
  playYouTube,
  pauseYouTube,
  stopYouTube,
  reportPosition,
  enqueueYouTube,
  clearYouTubeQueue,
  advanceYouTube,
  removeFromQueue,
  reorderQueue,
} from "@/lib/youtube-state";
import { enableYouTubeMode, disableYouTubeMode } from "@/lib/filler-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Browser <-> server channel for YouTube filler state.
 *
 * GET  — snapshot of the server's current intent (video + status).
 *        The 100 ms voice-session poll also piggybacks this shape
 *        (see /api/telegram/session), so most clients won't need
 *        to hit this directly. Useful as a one-shot debug endpoint
 *        and for the MCP tools.
 *
 * POST — two roles:
 *          action:"report_position"   (browser writes its playhead)
 *          action:"play" / "pause" / "stop"  (typically hit through
 *                 MCP tools rather than the browser; exposed here
 *                 for completeness and direct curl testing).
 */

export async function GET() {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  return NextResponse.json({ state: getYouTubeState(auth.user.id) });
}

interface PostBody {
  action?: string;
  // play:
  video_id?: string;
  title?: string | null;
  thumbnail_url?: string | null;
  duration_sec?: number | null;
  // report_position:
  position_sec?: number;
  // reorder_queue:
  from_index?: number;
  to_index?: number;
}

export async function POST(req: NextRequest) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const action = (body.action ?? "").trim();
  const uid = auth.user.id;

  switch (action) {
    case "play": {
      const videoId = (body.video_id ?? "").trim();
      if (!videoId) {
        return NextResponse.json(
          { error: "video_id required" },
          { status: 400 },
        );
      }
      const state = playYouTube(uid, {
        videoId,
        title: body.title ?? null,
        thumbnailUrl: body.thumbnail_url ?? null,
        durationSec:
          typeof body.duration_sec === "number" && body.duration_sec > 0
            ? body.duration_sec
            : null,
      });
      // Flip filler mode to "youtube" automatically. enableYouTubeMode
      // snapshots the user's current mode into previousMode so the
      // matching disableYouTubeMode call (on stop / advance-to-empty)
      // can restore it instead of hard-coding "news".
      try {
        await enableYouTubeMode();
      } catch {
        /* non-fatal */
      }
      return NextResponse.json({ state });
    }
    case "pause": {
      return NextResponse.json({ state: pauseYouTube(uid) });
    }
    case "stop": {
      const state = stopYouTube(uid);
      // Restore the user's pre-YouTube mode (news / fun-facts /
      // calendar / quiet — whatever the dropdown was on before
      // playback started). No-op if mode wasn't currently "youtube".
      try {
        await disableYouTubeMode();
      } catch {
        /* non-fatal */
      }
      return NextResponse.json({ state });
    }
    case "report_position": {
      const pos = Number(body.position_sec);
      if (!Number.isFinite(pos)) {
        return NextResponse.json(
          { error: "position_sec must be a number" },
          { status: 400 },
        );
      }
      return NextResponse.json({ state: reportPosition(uid, pos) });
    }
    case "enqueue": {
      const videoId = (body.video_id ?? "").trim();
      if (!videoId) {
        return NextResponse.json(
          { error: "video_id required" },
          { status: 400 },
        );
      }
      const state = enqueueYouTube(uid, {
        videoId,
        title: body.title ?? null,
        thumbnailUrl: body.thumbnail_url ?? null,
        durationSec:
          typeof body.duration_sec === "number" && body.duration_sec > 0
            ? body.duration_sec
            : null,
      });
      // If the enqueue promoted into now-playing (state.videoId now
      // matches what we just enqueued AND status flipped to playing),
      // auto-switch the filler mode to "youtube" via enableYouTubeMode
      // so the previousMode snapshot is captured. Otherwise leave
      // mode alone — user might be in news mode and just stacking
      // tracks for later.
      if (state.videoId === videoId && state.status === "playing") {
        try {
          await enableYouTubeMode();
        } catch {
          /* non-fatal */
        }
      }
      return NextResponse.json({ state });
    }
    case "clear_queue": {
      return NextResponse.json({ state: clearYouTubeQueue(uid) });
    }
    case "remove_from_queue": {
      const videoId = (body.video_id ?? "").trim();
      if (!videoId) {
        return NextResponse.json(
          { error: "video_id required" },
          { status: 400 },
        );
      }
      return NextResponse.json({ state: removeFromQueue(uid, videoId) });
    }
    case "reorder_queue": {
      const from = Number(body.from_index);
      const to = Number(body.to_index);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        return NextResponse.json(
          { error: "from_index and to_index must be numbers" },
          { status: 400 },
        );
      }
      return NextResponse.json({ state: reorderQueue(uid, from, to) });
    }
    case "advance": {
      const state = advanceYouTube(uid);
      // Empty queue → advance falls back to stop semantics, which
      // mirrors the explicit /stop branch — restore the user's
      // pre-YouTube mode rather than hard-coding "news".
      if (!state.videoId) {
        try {
          await disableYouTubeMode();
        } catch {
          /* non-fatal */
        }
      }
      return NextResponse.json({ state });
    }
    default:
      return NextResponse.json(
        { error: `unknown action: ${action || "(none)"}` },
        { status: 400 },
      );
  }
}
