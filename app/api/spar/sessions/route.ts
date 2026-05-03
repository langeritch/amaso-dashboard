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
import { apiRequireUser } from "@/lib/guard";
import { visibleProjects } from "@/lib/access";
import {
  listSessionsForProject,
  start as startTerminal,
} from "@/lib/terminal-backend";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await apiRequireUser();
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

  // First session for a project keeps the legacy id (= projectId) so
  // single-session usage stays bit-for-bit compatible. Mirrors the
  // resolver's "no live sessions yet → return projectId" branch.
  const existing = listSessionsForProject(projectId);
  const sessionId =
    existing.length === 0
      ? projectId
      : `${projectId}__s${Date.now().toString(36)}${Math.random()
          .toString(36)
          .slice(2, 6)}`;

  try {
    startTerminal(projectId, undefined, undefined, sessionId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  return NextResponse.json({ projectId, sessionId });
}
