import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import { broadcastRemark } from "@/lib/ws";
import { deleteAttachmentsOfRemark } from "@/lib/attachments";

export const dynamic = "force-dynamic";

// Item 6 — remark task fields. Validated here because SQLite ALTER can't
// add CHECK constraints to the pre-existing remarks table.
const REMARK_STATUSES = ["open", "in-progress", "blocked", "done"] as const;
const REMARK_PRIORITIES = ["low", "med", "high"] as const;

/**
 * PATCH a remark's task fields: status, priority, assignee_id, due_at.
 * Any subset may be supplied; omitted fields are left unchanged. Sending
 * an explicit null for assigneeId / dueAt clears that field. Editable by
 * an admin or the remark's author (same rule as DELETE). status='done'
 * also stamps resolved_at so the existing resolved filter stays in sync;
 * moving off 'done' clears it.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; remarkId: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id, remarkId } = await ctx.params;
  if (!canAccessProject(auth.user, id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rid = Number(remarkId);
  const row = getDb()
    .prepare(
      "SELECT user_id, project_id, path FROM remarks WHERE id = ? AND project_id = ?",
    )
    .get(rid, id) as
    | { user_id: number; project_id: string; path: string | null }
    | undefined;
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (auth.user.role !== "admin" && row.user_id !== auth.user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    status?: string;
    priority?: string;
    assigneeId?: number | null;
    dueAt?: number | null;
  } | null;
  if (!body) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (body.status !== undefined) {
    if (!REMARK_STATUSES.includes(body.status as (typeof REMARK_STATUSES)[number])) {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    sets.push('status = ?');
    vals.push(body.status);
    // Keep resolved_at coherent with the done state.
    sets.push("resolved_at = ?");
    vals.push(body.status === "done" ? Date.now() : null);
  }
  if (body.priority !== undefined) {
    if (
      !REMARK_PRIORITIES.includes(body.priority as (typeof REMARK_PRIORITIES)[number])
    ) {
      return NextResponse.json({ error: "invalid_priority" }, { status: 400 });
    }
    sets.push("priority = ?");
    vals.push(body.priority);
  }
  if (body.assigneeId !== undefined) {
    const aid =
      body.assigneeId === null
        ? null
        : Number.isFinite(body.assigneeId)
          ? Math.floor(body.assigneeId as number)
          : null;
    sets.push("assignee_id = ?");
    vals.push(aid);
  }
  if (body.dueAt !== undefined) {
    const due =
      body.dueAt === null
        ? null
        : Number.isFinite(body.dueAt)
          ? Math.floor(body.dueAt as number)
          : null;
    sets.push("due_at = ?");
    vals.push(due);
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: "no_fields" }, { status: 400 });
  }
  sets.push("updated_at = ?");
  vals.push(Date.now());

  vals.push(rid);
  getDb()
    .prepare(`UPDATE remarks SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals);

  broadcastRemark(id, row.path ?? "", rid, "added"); // nudge connected clients to reload
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; remarkId: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id, remarkId } = await ctx.params;
  if (!canAccessProject(auth.user, id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rid = Number(remarkId);
  const row = getDb()
    .prepare(
      "SELECT user_id, project_id, path FROM remarks WHERE id = ? AND project_id = ?",
    )
    .get(rid, id) as
    | { user_id: number; project_id: string; path: string | null }
    | undefined;
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (auth.user.role !== "admin" && row.user_id !== auth.user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  // CASCADE removes the attachment rows; we still need to delete the files.
  await deleteAttachmentsOfRemark(rid);
  getDb().prepare("DELETE FROM remarks WHERE id = ?").run(rid);
  broadcastRemark(id, row.path ?? "", rid, "deleted");
  return NextResponse.json({ ok: true });
}
