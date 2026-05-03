import { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { isSuperUser } from "@/lib/heartbeat";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TickRow {
  id: number;
  user_id: number;
  at: number;
  status: "ok" | "alert";
  tier1_results: string | null;
  tier2_summary: string | null;
  notified: number;
}

function parseUserId(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return new Response("unauthorized", { status: 401 });
  if (me.role === "client") return new Response("forbidden", { status: 403 });
  const url = new URL(req.url);
  const ownerId = parseUserId(url.searchParams.get("user"), me.id);
  if (ownerId !== me.id && !isSuperUser(me)) {
    return new Response("forbidden", { status: 403 });
  }
  const limit = parseLimit(url.searchParams.get("limit"));
  const rows = getDb()
    .prepare(
      `SELECT id, user_id, at, status, tier1_results, tier2_summary, notified
         FROM heartbeat_ticks
        WHERE user_id = ?
        ORDER BY at DESC
        LIMIT ?`,
    )
    .all(ownerId, limit) as TickRow[];
  return Response.json({
    userId: ownerId,
    ticks: rows.map((r) => ({
      id: r.id,
      at: r.at,
      status: r.status,
      tier1: r.tier1_results ? safeParse(r.tier1_results) : null,
      tier2Summary: r.tier2_summary,
      notified: r.notified === 1,
    })),
  });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
