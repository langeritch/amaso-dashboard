import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { canAccessProject } from "@/lib/access";
import { getGitStatus } from "@/lib/git";

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
  try {
    const status = await getGitStatus(id);
    return NextResponse.json(status);
  } catch (err) {
    // Git stderr can include local paths and branch names; log
    // server-side, send a generic code to the client.
    console.error(`[api/projects/${id}/git GET] failed:`, err);
    return NextResponse.json({ error: "git_status_failed" }, { status: 500 });
  }
}
