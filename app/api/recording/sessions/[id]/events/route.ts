import { NextRequest } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { appendEvents } from "@/lib/recording";
import type { IngestEventsRequest, RecordingEvent } from "@/types/recording";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_TYPES: ReadonlySet<RecordingEvent["type"]> = new Set([
  "click",
  "input",
  "submit",
  "navigation",
  "keydown",
]);

function isValidEvent(x: unknown): x is RecordingEvent {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.clientId === "string" &&
    typeof e.type === "string" &&
    ALLOWED_TYPES.has(e.type as RecordingEvent["type"]) &&
    typeof e.timestamp === "number" &&
    typeof e.url === "string" &&
    typeof e.needs_clarification === "boolean"
  );
}

/**
 * POST /api/recording/sessions/[id]/events — extension flush endpoint.
 * Body: { events: RecordingEvent[] }. Duplicate clientIds are silently
 * skipped via UNIQUE(session_id, client_id), so a retry from a flaky
 * network is safe.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await params;
  let body: IngestEventsRequest | null = null;
  try {
    body = (await req.json()) as IngestEventsRequest;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!body || !Array.isArray(body.events)) {
    return new Response("missing events[]", { status: 400 });
  }
  const events = body.events.filter(isValidEvent);
  if (events.length === 0) {
    return Response.json({ appended: 0, skipped: 0 });
  }
  const result = appendEvents(id, auth.user.id, events);
  if (!result) return new Response("not found", { status: 404 });
  return Response.json(result);
}
