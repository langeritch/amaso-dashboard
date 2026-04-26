import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import {
  canEditHeartbeat,
  isSuperUser,
  listHeartbeats,
  readHeartbeat,
  writeHeartbeat,
} from "@/lib/heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseUserId(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return new Response("unauthorized", { status: 401 });
  const url = new URL(req.url);
  const ownerId = parseUserId(url.searchParams.get("user"), me.id);
  if (ownerId !== me.id && !isSuperUser(me)) {
    return new Response("forbidden", { status: 403 });
  }
  const body = readHeartbeat(ownerId);
  return Response.json({ userId: ownerId, body });
}

export async function PUT(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return new Response("unauthorized", { status: 401 });
  let json: { userId?: number; body?: string } | null = null;
  try {
    json = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const ownerId = parseUserId(
    json?.userId != null ? String(json.userId) : null,
    me.id,
  );
  if (!canEditHeartbeat(me, ownerId)) {
    return new Response("forbidden", { status: 403 });
  }
  const body = typeof json?.body === "string" ? json.body : "";
  writeHeartbeat(ownerId, body);
  return Response.json({ userId: ownerId, bytes: body.length });
}

export async function OPTIONS(_req: NextRequest) {
  const me = await getCurrentUser();
  if (!me || !isSuperUser(me)) return new Response("forbidden", { status: 403 });
  // Diagnostic listing — super-user only.
  return Response.json({ heartbeats: listHeartbeats() });
}
