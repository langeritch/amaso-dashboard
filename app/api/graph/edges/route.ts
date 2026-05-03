import { NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CreateEdgeBody {
  source?: unknown;
  target?: unknown;
  label?: unknown;
}

/** POST /api/graph/edges — create an edge. Both endpoints must already
 *  exist (FOREIGN KEY constraint enforced by SQLite). Self-loops are
 *  refused — they have no useful meaning in the current model. */
export async function POST(req: Request) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  const body = (await req.json().catch(() => null)) as CreateEdgeBody | null;
  if (!body) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const source = typeof body.source === "string" ? body.source : "";
  const target = typeof body.target === "string" ? body.target : "";
  if (!source || !target) {
    return NextResponse.json(
      { error: "source_and_target_required" },
      { status: 400 },
    );
  }
  if (source === target) {
    return NextResponse.json({ error: "self_loop" }, { status: 400 });
  }
  const label = typeof body.label === "string" ? body.label : null;

  const db = getDb();
  try {
    const result = db
      .prepare(
        "INSERT INTO graph_edges (source, target, label) VALUES (?, ?, ?)",
      )
      .run(source, target, label);
    return NextResponse.json({
      edge: {
        id: Number(result.lastInsertRowid),
        source,
        target,
        label,
      },
    });
  } catch (e) {
    if (e instanceof Error && e.message.includes("FOREIGN KEY")) {
      return NextResponse.json({ error: "unknown_node" }, { status: 400 });
    }
    throw e;
  }
}
