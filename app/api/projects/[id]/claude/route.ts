import { NextResponse } from "next/server";
import { apiRequireAdmin, apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import {
  cancelRun,
  getRun,
  getRunById,
  startRun,
  type ClaudeRun,
} from "@/lib/claude";
import { buildFixAllPrompt, markResolved } from "@/lib/prompt";
import { getDb } from "@/lib/db";
import { restoreSnapshot, snapshotProject } from "@/lib/revert";

export const dynamic = "force-dynamic";

// Safety net for Claude runs on the dashboard's own code: if the admin
// hasn't approved (resolved) the remarks within this window, undo the edits
// so a broken change can't lock us out of the UI we use to approve.
//
// Disabled by default — it was clobbering hand-edited work in this repo
// (including mobile/PWA changes authored outside the Claude fix-all flow).
// Re-enable by setting AMASO_SELF_REVERT=on in the server environment.
const SELF_PROJECT_ID = "project-dashboard";
const SELF_REVERT_MS = 120_000;
const SELF_REVERT_ENABLED = process.env.AMASO_SELF_REVERT === "on";

function publicRun(run: ClaudeRun) {
  return {
    id: run.id,
    projectId: run.projectId,
    remarkIds: run.remarkIds,
    state: run.state,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    exitCode: run.exitCode,
    log: run.log,
  };
}

/** GET — latest run for this project, if any. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!canAccessProject(auth.user, id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId");
  const run = runId ? getRunById(runId) : getRun(id);
  if (!run) return NextResponse.json({ run: null });
  return NextResponse.json({ run: publicRun(run) });
}

/** POST — start fix-all. Admin only. */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;

  const built = buildFixAllPrompt(id);
  if (!built) {
    return NextResponse.json(
      { error: "no_open_remarks" },
      { status: 400 },
    );
  }

  const isSelf = id === SELF_PROJECT_ID;
  // Snapshot BEFORE the run starts so we can roll back to clean state. Only
  // for the dashboard's own repo — other projects have no kill-switch
  // concern because breaking them doesn't break the approval UI.
  const snapshot =
    isSelf && SELF_REVERT_ENABLED ? await snapshotProject(built.projectRoot) : null;

  try {
    const run = startRun(id, built.projectRoot, built.prompt, built.remarkIds);

    if (isSelf && SELF_REVERT_ENABLED && snapshot) {
      // Don't auto-resolve — the admin has to actively approve each remark
      // within SELF_REVERT_MS, otherwise we undo Claude's edits.
      run.emitter.on("end", (r: ClaudeRun) => {
        if (r.state !== "completed") return;
        const projectRoot = built.projectRoot;
        const remarkIds = r.remarkIds;
        setTimeout(() => {
          try {
            const unresolved =
              remarkIds.length === 0
                ? []
                : (getDb()
                    .prepare(
                      `SELECT id FROM remarks WHERE id IN (${remarkIds
                        .map(() => "?")
                        .join(",")}) AND resolved_at IS NULL`,
                    )
                    .all(...remarkIds) as { id: number }[]);
            if (unresolved.length === 0) return;
            void restoreSnapshot(projectRoot, snapshot).then((touched) => {
              console.log(
                `[revert] dashboard rollback: ${touched.length} file(s) restored after ${
                  SELF_REVERT_MS / 1000
                }s without approval`,
              );
            });
          } catch (err) {
            console.error("[revert] check failed:", err);
          }
        }, SELF_REVERT_MS);
      });
    } else {
      // Default: mark remarks resolved optimistically on success. Keeps
      // the UI tidy even if the user forgets to click through each one.
      run.emitter.on("end", (r: ClaudeRun) => {
        if (r.state === "completed") markResolved(r.remarkIds);
      });
    }

    return NextResponse.json({ run: publicRun(run) });
  } catch (err) {
    // Log the full error server-side; the client gets a generic
    // "bad_request" so we don't leak internal stack traces or
    // filesystem paths in the JSON response. The route is admin-
    // gated, but defence-in-depth is cheap here.
    console.error("[api/projects/[id]/claude POST] failed:", err);
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
}

/** DELETE — cancel a running job. Admin only. */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  await ctx.params; // consume
  const url = new URL(req.url);
  const runId = url.searchParams.get("runId");
  if (!runId) return NextResponse.json({ error: "runId_required" }, { status: 400 });
  const ok = cancelRun(runId);
  return NextResponse.json({ ok });
}
