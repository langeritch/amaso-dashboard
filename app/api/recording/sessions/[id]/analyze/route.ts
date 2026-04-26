import { NextRequest } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { getSession, setAnalysisStatus } from "@/lib/recording";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/recording/sessions/[id]/analyze — flag this recording for
 * AI analysis. Today this just flips `analysis_status` to 'queued' and
 * returns; a future worker will pick queued sessions up and produce
 * `analysis_result`. The end-of-session modal's "Save & analyze" button
 * is the only caller.
 *
 * Idempotent — calling again on a queued/running/completed session is a
 * no-op beyond resetting the status back to 'queued'.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await params;
  const existing = getSession(id, auth.user.id);
  if (!existing) return new Response("not found", { status: 404 });
  const session = setAnalysisStatus(id, auth.user.id, "queued", null);
  if (!session) return new Response("not found", { status: 404 });
  return Response.json({ session });
}
