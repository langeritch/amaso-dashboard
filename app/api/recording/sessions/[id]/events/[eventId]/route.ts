import { NextRequest } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { setEventClarification } from "@/lib/recording";
import type { ClarifyEventRequest } from "@/types/recording";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH /api/recording/sessions/[id]/events/[eventId] — set the user's
 * post-hoc clarification text on a flagged event. The session id is in
 * the path for symmetry with the rest of the routes; ownership is
 * actually verified through the join inside setEventClarification.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; eventId: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { eventId } = await params;
  const numericId = Number(eventId);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return new Response("bad eventId", { status: 400 });
  }
  let body: ClarifyEventRequest | null = null;
  try {
    body = (await req.json()) as ClarifyEventRequest;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const text = typeof body?.clarification === "string" ? body.clarification : "";
  const updated = setEventClarification(numericId, auth.user.id, text);
  if (!updated) return new Response("not found", { status: 404 });
  return Response.json({ event: updated });
}
