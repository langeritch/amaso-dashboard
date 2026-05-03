import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  createConversation,
  listConversations,
  type SparConversationRow,
} from "@/lib/spar-conversations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function publicShape(c: SparConversationRow) {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.messageCount ?? 0,
    preview: c.preview ?? null,
    driftNotice: c.driftNotice ?? null,
  };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  if (user.role === "client") return new Response("forbidden", { status: 403 });
  const rows = listConversations(user.id);
  return Response.json({ conversations: rows.map(publicShape) });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  if (user.role === "client") return new Response("forbidden", { status: 403 });
  let body: { title?: string | null } | null = null;
  try {
    body = (await req.json()) as { title?: string | null };
  } catch {
    body = null;
  }
  const title =
    body && typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 200)
      : null;
  const conv = createConversation(user.id, title);
  return Response.json({ conversation: publicShape(conv) }, { status: 201 });
}
