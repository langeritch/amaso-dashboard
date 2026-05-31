// GET /api/admin/costs?granularity=day|month&days=<n>
// Admin-only Claude API cost rollup (Item 9). Returns cost buckets
// grouped by (project, period) plus a grand total. project "(spar)" is
// the sparring partner's own unattributed spend. See lib/cost-events.ts.

import { NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import { aggregateCosts } from "@/lib/cost-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;

  const url = new URL(req.url);
  const granularity =
    url.searchParams.get("granularity") === "month" ? "month" : "day";
  const daysRaw = Number(url.searchParams.get("days"));
  const days =
    Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 365
      ? Math.floor(daysRaw)
      : 90;
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const buckets = aggregateCosts(granularity, sinceMs);

  const totalUsd =
    Math.round(buckets.reduce((s, b) => s + b.costUsd, 0) * 1e6) / 1e6;
  const totalTurns = buckets.reduce((s, b) => s + b.turns, 0);

  // Per-project rollup across the whole window (sum the period buckets).
  const byProjectMap = new Map<string, { costUsd: number; turns: number }>();
  for (const b of buckets) {
    const cur = byProjectMap.get(b.projectId) ?? { costUsd: 0, turns: 0 };
    cur.costUsd += b.costUsd;
    cur.turns += b.turns;
    byProjectMap.set(b.projectId, cur);
  }
  const byProject = Array.from(byProjectMap.entries())
    .map(([projectId, v]) => ({
      projectId,
      costUsd: Math.round(v.costUsd * 1e6) / 1e6,
      turns: v.turns,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return NextResponse.json({
    granularity,
    days,
    totalUsd,
    totalTurns,
    byProject,
    buckets,
  });
}
