import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import { getHistory } from "@/lib/history";

export const dynamic = "force-dynamic";

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
  const limit = Math.min(
    Number(new URL(req.url).searchParams.get("limit") ?? 50),
    100,
  );
  const events = getHistory()
    .recent(id, limit)
    .map((e) => ({
      id: e.id,
      type: e.type,
      path: e.path,
      ts: e.ts,
    }));
  return NextResponse.json({ events });
}
