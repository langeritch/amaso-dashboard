import { NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import { commitAndPush } from "@/lib/git";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  // Only admins can deploy — pushing to the remote is a public action.
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as
    | { message?: string }
    | null;
  const message =
    body?.message?.trim() || `Deploy from Amaso dashboard @ ${new Date().toISOString()}`;
  try {
    const result = await commitAndPush(id, message);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
