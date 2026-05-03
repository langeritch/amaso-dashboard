import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  deleteConversation,
  getConversation,
  getMessages,
  setDriftNotice,
} from "@/lib/spar-conversations";
import { broadcastSparConversation } from "@/lib/ws";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  if (user.role === "client") return new Response("forbidden", { status: 403 });
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) return new Response("bad id", { status: 400 });
  const conv = getConversation(user.id, id);
  if (!conv) return new Response("not found", { status: 404 });
  const messages = getMessages(conv.id);
  return Response.json({
    conversation: {
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      driftNotice: conv.driftNotice,
    },
    messages: messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolCalls: m.toolCalls,
      createdAt: m.createdAt,
    })),
  });
}

/**
 * Lightweight update endpoint. Currently only used to dismiss the
 * drift notice from the chat UI ("Got it, hide this" → PATCH with
 * `driftNotice: null`). Kept narrow on purpose — title edits go
 * through the auto-namer; rename UI hasn't shipped yet.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  if (user.role === "client") return new Response("forbidden", { status: 403 });
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) return new Response("bad id", { status: 400 });
  let body: { driftNotice?: string | null } | null = null;
  try {
    body = (await req.json()) as { driftNotice?: string | null };
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!body || !("driftNotice" in body)) {
    return new Response("nothing to update", { status: 400 });
  }
  const updated = setDriftNotice(user.id, id, body.driftNotice ?? null);
  if (!updated) return new Response("not found", { status: 404 });
  try {
    broadcastSparConversation(user.id, {
      conversationId: updated.id,
      driftNotice: updated.driftNotice,
      updatedAt: updated.updatedAt,
    });
  } catch {
    /* broadcast failure is non-fatal */
  }
  return Response.json({
    conversation: {
      id: updated.id,
      title: updated.title,
      driftNotice: updated.driftNotice,
      updatedAt: updated.updatedAt,
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  if (user.role === "client") return new Response("forbidden", { status: 403 });
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) return new Response("bad id", { status: 400 });
  const ok = deleteConversation(user.id, id);
  if (!ok) return new Response("not found", { status: 404 });
  return new Response(null, { status: 204 });
}
