// Spawn a new terminal session for a project.
//
// POST /api/spar/sessions { projectId }
//   → { projectId, sessionId }
//
// Stage 2 of remark #285: lets the workers panel run multiple
// concurrent Claude CLI sessions per project. The first session a
// project ever gets keeps the legacy projectId-keyed id so existing
// dispatch / scrollback paths see no change; every subsequent spawn
// allocates a fresh `<projectId>__s<rand>` id.
//
// Auth: any logged-in user with visibility on the project. Same gate
// as /api/spar/worker-status — if you can see the worker, you can
// spawn another session for it. The spawned session inherits the
// project cwd + the active Claude account env (handled inside
// `start`).

import { NextRequest, NextResponse } from "next/server";
import { apiRequireNonClient } from "@/lib/guard";
import { visibleProjects } from "@/lib/access";
import {
  listSessionsForProject,
  start as startTerminal,
} from "@/lib/terminal-backend";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await apiRequireNonClient();
  if (!auth.ok) return auth.res;

  const body = (await req.json().catch(() => null)) as
    | { projectId?: unknown }
    | null;
  const projectId =
    body && typeof body.projectId === "string" ? body.projectId : "";
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

  const existing = listSessionsForProject(projectId);
  if (existing.length > 0) {
    return NextResponse.json({
      projectId,
      sessionId: existing[0].sessionId ?? projectId,
      reused: true,
    });
  }
  const sessionId = projectId;

  let view;
  try {
    view = startTerminal(projectId, undefined, undefined, sessionId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  // Belt-and-suspenders: even after fix #1 makes start() idempotent at
  // the registry level, two concurrent POSTs that both pass the
  // listSessionsForProject check above will both call startTerminal —
  // the first spawns, the second is handed the existing session by
  // the registry. Detect that second case via startedAt: a fresh spawn
  // has startedAt ≈ now, a reused session is older than ~1s. Surface
  // it so the client can avoid double-counting.
  const reused = typeof view?.startedAt === "number" &&
    view.startedAt < Date.now() - 1000;
  return NextResponse.json({
    projectId,
    sessionId,
    ...(reused ? { reused: true } : {}),
  });
}
