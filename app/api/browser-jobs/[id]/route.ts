// PATCH /api/browser-jobs/[id]: update a browser job's status / progress.
// DELETE /api/browser-jobs/[id]: cancel or hard-remove a job (treated as
//   a "complete and forget" so the workers panel can drop the row right
//   away instead of waiting on the 5-minute terminal-state fade-out).

import { NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import {
  deleteJob,
  getJob,
  updateJob,
  type BrowserJobStatus,
} from "@/lib/browser-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_STATUSES: BrowserJobStatus[] = [
  "running",
  "checking",
  "done",
  "failed",
  "stalled",
];

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "bad_id" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as {
    status?: unknown;
    progress?: unknown;
    touch?: unknown;
  } | null;
  if (!body) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const status =
    typeof body.status === "string" &&
    (ALLOWED_STATUSES as string[]).includes(body.status)
      ? (body.status as BrowserJobStatus)
      : undefined;
  const progress = typeof body.progress === "string" ? body.progress : undefined;
  const touch = body.touch === true;
  if (!status && progress === undefined && !touch) {
    return NextResponse.json(
      { error: "no_fields_to_update" },
      { status: 400 },
    );
  }
  if (!getJob(auth.user.id, id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const job = updateJob(auth.user.id, id, { status, progress, touch });
  if (!job) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ job });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  const removed = deleteJob(auth.user.id, id);
  return NextResponse.json({ ok: removed });
}
