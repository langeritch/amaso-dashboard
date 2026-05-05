// Dashboard-native filler-content feed. Unlike `/api/filler/clip/[id]`
// which serves pre-rendered WAVs from the Python pipeline, this route
// returns one TEXT item at a time so the dashboard can synthesise it
// through the same `/api/tts` path as a real reply. The MCP tool path
// (Spar setting filler mode via filler_set_mode) feeds straight into
// this — same registry, same dedup.
//
// Returns 204 when:
//   - the current mode isn't a TTS-content mode (e.g. "news" still
//     plays via the WAV pool, "youtube" / "quiet" have no TTS-spoken
//     content)
//   - all sources for the mode produced empty pools (network-failed
//     RSS, empty heartbeat for calendar mode, etc.)
// 204 means "nothing to play right now"; the dashboard falls back
// to the chime in that case.

import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import {
  TTS_CONTENT_MODES,
  getFillerConfig,
  type FillerMode,
} from "@/lib/filler-mode";
import {
  pickNextFillerItem,
  resetFillerSession,
} from "@/lib/filler-content/registry";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;

  const { mode, urlOrTopic } = await getFillerConfig();
  if (!(TTS_CONTENT_MODES as readonly FillerMode[]).includes(mode)) {
    return new Response(null, { status: 204 });
  }
  const picked = await pickNextFillerItem(auth.user.id, mode, urlOrTopic);
  if (!picked) {
    return new Response(null, { status: 204 });
  }
  return NextResponse.json(picked);
}

export async function DELETE() {
  // Explicit session-reset hook. Called by the dashboard on
  // call-start / call-end so a fresh session never inherits the
  // dedup state of the previous one. Idempotent — clearing an
  // already-empty set is a no-op.
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  resetFillerSession(auth.user.id);
  return NextResponse.json({ ok: true });
}
