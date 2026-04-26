import { NextRequest } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { endSession } from "@/lib/recording";
import { stopSession as stopLiveBrowser } from "@/lib/browser-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/recording/sessions/[id]/end — flips status to 'ended' and
 * tears down the user's live headless Chromium if one is running. Both
 * the dashboard's stop button and the /browser viewer's stop control
 * funnel through here so cleanup stays in one place.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await params;
  const session = endSession(id, auth.user.id);
  if (!session) return new Response("not found", { status: 404 });
  // Best-effort: if no live browser, this resolves to a no-op.
  await stopLiveBrowser(auth.user.id);
  return Response.json({ session });
}
