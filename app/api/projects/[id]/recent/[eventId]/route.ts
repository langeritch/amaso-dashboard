import { NextResponse } from "next/server";
import { createPatch } from "diff";
import { apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import { getHistory } from "@/lib/history";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; eventId: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id, eventId } = await ctx.params;
  if (!canAccessProject(auth.user, id)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const numericId = Number(eventId);
  const recent = getHistory().recent(id, 100);
  const evt = recent.find((e) => e.id === numericId);
  if (!evt) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const previous = evt.previous ?? "";
  const current = evt.current ?? "";
  const patch = createPatch(
    evt.path,
    previous,
    current,
    evt.type === "add" ? "(new file)" : "before",
    evt.type === "unlink" ? "(deleted)" : "after",
  );
  return NextResponse.json({
    event: {
      id: evt.id,
      type: evt.type,
      path: evt.path,
      ts: evt.ts,
    },
    patch,
    hasPrevious: evt.previous !== null,
    hasCurrent: evt.current !== null,
  });
}
