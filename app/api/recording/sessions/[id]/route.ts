import { NextRequest } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import {
  deleteSession,
  getSession,
  listEvents,
  setSessionAutomation,
  setSessionName,
} from "@/lib/recording";
import { stopSession as stopLiveBrowser } from "@/lib/browser-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/recording/sessions/[id] — session metadata + every event. */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await params;
  const session = getSession(id, auth.user.id);
  if (!session) return new Response("not found", { status: 404 });
  return Response.json({ session, events: listEvents(id) });
}

/**
 * PATCH /api/recording/sessions/[id] — update editable fields. `name`
 * is set from the end-of-session modal; `automationId` is set by the
 * launcher when the user clicks ▶ on an automation card during an
 * active recording (first-write wins, so re-launches don't change
 * attribution).
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await params;
  let body: { name?: unknown; automationId?: unknown } | null = null;
  try {
    body = (await req.json()) as { name?: unknown; automationId?: unknown };
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return new Response("bad body", { status: 400 });
  }
  if ("name" in body && body.name != null && typeof body.name !== "string") {
    return new Response("name must be string or null", { status: 400 });
  }
  if (
    "automationId" in body &&
    body.automationId != null &&
    (typeof body.automationId !== "number" || !Number.isInteger(body.automationId))
  ) {
    return new Response("automationId must be integer or null", { status: 400 });
  }

  let session = getSession(id, auth.user.id);
  if (!session) return new Response("not found", { status: 404 });

  if ("name" in body) {
    const nameRaw = (body.name as string | null | undefined) ?? null;
    session = setSessionName(id, auth.user.id, nameRaw);
    if (!session) return new Response("not found", { status: 404 });
  }
  if ("automationId" in body) {
    const automationIdRaw = (body.automationId as number | null | undefined) ?? null;
    session = setSessionAutomation(id, auth.user.id, automationIdRaw);
    if (!session) return new Response("not found", { status: 404 });
  }

  return Response.json({ session });
}

/**
 * DELETE /api/recording/sessions/[id] — discard a recording. Tears
 * down any live headless browser still bound to the session, then
 * removes the row (events cascade). Used by the end-of-session
 * "Discard" button.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await params;
  // Be defensive: confirm ownership by fetching first, so a stray
  // DELETE can't 500 on an unrelated session.
  const existing = getSession(id, auth.user.id);
  if (!existing) return new Response("not found", { status: 404 });
  await stopLiveBrowser(auth.user.id);
  const ok = deleteSession(id, auth.user.id);
  if (!ok) return new Response("not found", { status: 404 });
  return Response.json({ ok: true });
}
