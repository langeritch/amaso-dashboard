import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  appendMessage,
  type SparMessageRole,
} from "@/lib/spar-conversations";
import { broadcastSparMessage } from "@/lib/ws";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

interface IncomingBody {
  role?: string;
  content?: string;
  toolCalls?: unknown;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  if (user.role === "client") return new Response("forbidden", { status: 403 });
  const { id: rawId } = await params;
  const id = parseId(rawId);
  if (id === null) return new Response("bad id", { status: 400 });

  let body: IncomingBody | null = null;
  try {
    body = (await req.json()) as IncomingBody;
  } catch {
    return new Response("bad json", { status: 400 });
  }
  if (!body) return new Response("bad json", { status: 400 });

  const role = body.role;
  if (role !== "user" && role !== "assistant" && role !== "system") {
    return new Response("bad role", { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content : "";
  if (!content.trim()) return new Response("empty content", { status: 400 });

  const row = appendMessage({
    conversationId: id,
    userId: user.id,
    role: role as SparMessageRole,
    content,
    toolCalls: body.toolCalls ?? null,
  });
  if (!row) return new Response("not found", { status: 404 });

  // Cross-device sync: every other tab/device this user has open gets
  // an immediate push, no polling needed. Best-effort — broadcast
  // failures must not break the write path.
  try {
    broadcastSparMessage(user.id, {
      conversationId: row.conversationId,
      message: {
        id: row.id,
        role: row.role,
        content: row.content,
        toolCalls: row.toolCalls,
        createdAt: row.createdAt,
      },
    });
  } catch {
    /* ignore — persistence already succeeded */
  }

  return Response.json(
    {
      message: {
        id: row.id,
        conversationId: row.conversationId,
        role: row.role,
        content: row.content,
        toolCalls: row.toolCalls,
        createdAt: row.createdAt,
      },
    },
    { status: 201 },
  );
}
