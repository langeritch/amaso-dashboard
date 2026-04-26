import { apiRequireUser } from "@/lib/guard";
import { createSession, listSessions, findActiveSession } from "@/lib/recording";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/recording/sessions — list this user's sessions, newest first. */
export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  return Response.json({
    sessions: listSessions(auth.user.id),
    active: findActiveSession(auth.user.id),
  });
}

/**
 * POST /api/recording/sessions — start a new session for the current
 * user. The headless Chromium that captures events is launched on
 * demand by the /api/browser WebSocket when the user opens /browser;
 * this endpoint just allocates the session id.
 */
export async function POST() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const session = createSession(auth.user.id);
  return Response.json({ session });
}
