import { NextResponse } from "next/server";
import { apiRequireAdmin, apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import { getStatus, liveCheck, start, stop } from "@/lib/devserver";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!canAccessProject(auth.user, id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const status = getStatus(id);
  const reachable = await liveCheck(id);
  // If someone started the dev server by hand, reflect that in the status
  if (reachable && status.state === "idle") {
    status.state = "ready";
  }
  return NextResponse.json({ ...status, reachable });
}

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  try {
    const status = await start(id);
    return NextResponse.json(status);
  } catch (err) {
    // Dev-server boot errors leak the project's local path + the
    // child process's stderr (port-in-use, missing scripts, etc.).
    // Admin-gated, but generic-on-the-wire is the right default.
    console.error(`[api/projects/${id}/dev POST] failed:`, err);
    return NextResponse.json({ error: "dev_start_failed" }, { status: 400 });
  }
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  stop(id);
  return NextResponse.json({ ok: true });
}
