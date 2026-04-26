import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import {
  createRoadmapStep,
  listRoadmapSteps,
  type RoadmapStep,
} from "@/lib/roadmap";

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
  const steps: RoadmapStep[] = listRoadmapSteps(id);
  return NextResponse.json({ steps });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  if (!canAccessProject(auth.user, id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { title?: unknown; parentId?: unknown };
  try {
    body = (await req.json()) as { title?: unknown; parentId?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "missing_title" }, { status: 400 });
  }
  if (title.length > 500) {
    return NextResponse.json({ error: "title_too_long" }, { status: 400 });
  }
  let parentId: number | null = null;
  if (body.parentId !== null && body.parentId !== undefined) {
    if (typeof body.parentId !== "number" || !Number.isInteger(body.parentId)) {
      return NextResponse.json({ error: "invalid_parent_id" }, { status: 400 });
    }
    parentId = body.parentId;
  }

  try {
    const step = createRoadmapStep({ projectId: id, parentId, title });
    return NextResponse.json({ step });
  } catch (err) {
    if (err instanceof Error && err.message === "invalid_parent") {
      return NextResponse.json({ error: "invalid_parent" }, { status: 400 });
    }
    // Don't echo the raw error string back — better-sqlite3 / FS
    // exceptions can include constraint names and disk paths. Log
    // the detail server-side, send a stable error code to the client.
    console.error(`[api/projects/${id}/roadmap POST] failed:`, err);
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }
}
