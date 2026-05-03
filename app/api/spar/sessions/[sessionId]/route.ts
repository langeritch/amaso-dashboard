// Kill a single terminal session for a project (Stage 2 of remark #285).
//
// DELETE /api/spar/sessions/<sessionId>?projectId=<id>
//   → { ok: true|false }
//
// `projectId` is required as a query param because the underlying
// stop() takes both — and the in-memory registry is keyed by
// sessionId, not projectId, so we don't try to look up the project
// from the sessionId here. The caller already knows it from the
// worker-status row that surfaced the kill button.

import { NextRequest, NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { visibleProjects } from "@/lib/access";
import { stop as stopTerminal } from "@/lib/terminal-backend";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;

  const { sessionId } = await ctx.params;
  if (!sessionId) {
    return NextResponse.json(
      { error: "missing sessionId" },
      { status: 400 },
    );
  }
  const projectId = req.nextUrl.searchParams.get("projectId") ?? "";
  if (!projectId) {
    return NextResponse.json(
      { error: "missing projectId" },
      { status: 400 },
    );
  }

  const visible = visibleProjects(auth.user);
  if (!visible.some((p) => p.id === projectId)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const ok = stopTerminal(projectId, sessionId);
  return NextResponse.json({ ok });
}
