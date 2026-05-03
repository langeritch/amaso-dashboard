import { NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NODE_TYPES = [
  "project",
  "person",
  "tech",
  "blocker",
  "decision",
  "milestone",
] as const;
type NodeType = (typeof NODE_TYPES)[number];

interface CreateNodeBody {
  id?: unknown;
  type?: unknown;
  label?: unknown;
  status?: unknown;
  notes?: unknown;
}

function isNodeType(t: unknown): t is NodeType {
  return typeof t === "string" && (NODE_TYPES as readonly string[]).includes(t);
}

/** POST /api/graph/nodes — create a new node. Server enforces the type
 *  whitelist and requires a non-empty id + label. */
export async function POST(req: Request) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  const body = (await req.json().catch(() => null)) as CreateNodeBody | null;
  if (!body) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!id || !label) {
    return NextResponse.json(
      { error: "id_and_label_required" },
      { status: 400 },
    );
  }
  if (!isNodeType(body.type)) {
    return NextResponse.json({ error: "invalid_type" }, { status: 400 });
  }
  const status = typeof body.status === "string" ? body.status : null;
  const notes = typeof body.notes === "string" ? body.notes : null;

  const db = getDb();
  try {
    db.prepare(
      "INSERT INTO graph_nodes (id, type, label, status, notes, claude_md, updated_at) VALUES (?, ?, ?, ?, ?, NULL, ?)",
    ).run(id, body.type, label, status, notes, Date.now());
  } catch (e) {
    if (e instanceof Error && e.message.includes("UNIQUE")) {
      return NextResponse.json({ error: "duplicate_id" }, { status: 409 });
    }
    throw e;
  }

  return NextResponse.json({
    node: { id, type: body.type, label, status, notes, hasClaudeMd: false },
  });
}
