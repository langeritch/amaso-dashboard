import { NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface NodeRow {
  id: string;
  type: string;
  label: string;
  status: string | null;
  notes: string | null;
  claude_md: string | null;
  updated_at: number;
}

/** GET /api/graph/nodes/[id] — full node record incl. claude_md. */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;

  const row = getDb()
    .prepare(
      "SELECT id, type, label, status, notes, claude_md, updated_at FROM graph_nodes WHERE id = ?",
    )
    .get(id) as NodeRow | undefined;
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  return NextResponse.json({
    node: {
      id: row.id,
      type: row.type,
      label: row.label,
      status: row.status,
      notes: row.notes,
      claudeMd: row.claude_md,
      updatedAt: row.updated_at,
    },
  });
}

interface PatchBody {
  label?: unknown;
  status?: unknown;
  notes?: unknown;
}

/** PATCH /api/graph/nodes/[id] — update label/status/notes. Type and id
 *  are immutable; change them by deleting and recreating the node. */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;

  const body = (await req.json().catch(() => null)) as PatchBody | null;
  if (!body) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  if (body.label !== undefined) {
    if (typeof body.label !== "string" || !body.label.trim()) {
      return NextResponse.json({ error: "invalid_label" }, { status: 400 });
    }
    sets.push("label = ?");
    args.push(body.label.trim());
  }
  if (body.status !== undefined) {
    sets.push("status = ?");
    args.push(typeof body.status === "string" ? body.status : null);
  }
  if (body.notes !== undefined) {
    sets.push("notes = ?");
    args.push(typeof body.notes === "string" ? body.notes : null);
  }
  if (sets.length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  sets.push("updated_at = ?");
  args.push(Date.now());
  args.push(id);

  const result = getDb()
    .prepare(`UPDATE graph_nodes SET ${sets.join(", ")} WHERE id = ?`)
    .run(...args);
  if (result.changes === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

/** DELETE /api/graph/nodes/[id] — removes the node and (via foreign-key
 *  cascade) every edge touching it. */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;

  const result = getDb()
    .prepare("DELETE FROM graph_nodes WHERE id = ?")
    .run(id);
  if (result.changes === 0) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
