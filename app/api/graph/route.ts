import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/graph — full graph for canvas rendering. Strips claude_md from
 * the payload; the panel fetches it lazily via /api/graph/nodes/[id] when
 * the user actually opens a project. Keeps the canvas request small even
 * when CLAUDE.md files grow.
 */
export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;

  const db = getDb();
  const nodes = db
    .prepare(
      `SELECT id, type, label, status, notes,
              (claude_md IS NOT NULL) AS has_claude_md,
              updated_at
         FROM graph_nodes
         ORDER BY type, id`,
    )
    .all() as {
    id: string;
    type: string;
    label: string;
    status: string | null;
    notes: string | null;
    has_claude_md: number;
    updated_at: number;
  }[];

  const edges = db
    .prepare("SELECT id, source, target, label FROM graph_edges ORDER BY id")
    .all() as {
    id: number;
    source: string;
    target: string;
    label: string | null;
  }[];

  return NextResponse.json({
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      status: n.status,
      notes: n.notes,
      hasClaudeMd: Boolean(n.has_claude_md),
      updatedAt: n.updated_at,
    })),
    edges,
  });
}
