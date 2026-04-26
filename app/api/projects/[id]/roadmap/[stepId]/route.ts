import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import {
  deleteRoadmapStep,
  getRoadmapStep,
  updateRoadmapStep,
} from "@/lib/roadmap";

export const dynamic = "force-dynamic";

async function resolveAndAuthorize(
  ctx: { params: Promise<{ id: string; stepId: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return { error: auth.res } as const;
  const { id, stepId } = await ctx.params;
  if (!canAccessProject(auth.user, id)) {
    return {
      error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    } as const;
  }
  const sid = Number(stepId);
  if (!Number.isInteger(sid) || sid <= 0) {
    return {
      error: NextResponse.json({ error: "invalid_step_id" }, { status: 400 }),
    } as const;
  }
  const step = getRoadmapStep(sid);
  if (!step || step.projectId !== id) {
    return {
      error: NextResponse.json({ error: "not_found" }, { status: 404 }),
    } as const;
  }
  return { stepId: sid } as const;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; stepId: string }> },
) {
  const resolved = await resolveAndAuthorize(ctx);
  if ("error" in resolved) return resolved.error;

  let body: { title?: unknown; done?: unknown };
  try {
    body = (await req.json()) as { title?: unknown; done?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const patch: { title?: string; done?: boolean } = {};
  if (body.title !== undefined) {
    if (typeof body.title !== "string") {
      return NextResponse.json({ error: "invalid_title" }, { status: 400 });
    }
    const t = body.title.trim();
    if (!t) {
      return NextResponse.json({ error: "missing_title" }, { status: 400 });
    }
    if (t.length > 500) {
      return NextResponse.json({ error: "title_too_long" }, { status: 400 });
    }
    patch.title = t;
  }
  if (body.done !== undefined) {
    if (typeof body.done !== "boolean") {
      return NextResponse.json({ error: "invalid_done" }, { status: 400 });
    }
    patch.done = body.done;
  }
  const step = updateRoadmapStep(resolved.stepId, patch);
  return NextResponse.json({ step });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; stepId: string }> },
) {
  const resolved = await resolveAndAuthorize(ctx);
  if ("error" in resolved) return resolved.error;
  deleteRoadmapStep(resolved.stepId);
  return NextResponse.json({ ok: true });
}
