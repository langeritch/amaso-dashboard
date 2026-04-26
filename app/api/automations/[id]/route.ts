import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import {
  deleteAutomation,
  getAutomationStats,
  patchAutomation,
} from "@/lib/automations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchBody {
  name?: unknown;
  description?: unknown;
  url?: unknown;
  enabled?: unknown;
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  const body = (await req.json().catch(() => null)) as PatchBody | null;
  if (!body) return NextResponse.json({ error: "bad_request" }, { status: 400 });

  const patch: Parameters<typeof patchAutomation>[1] = {};
  if (typeof body.name === "string") patch.name = body.name.trim();
  if (body.description !== undefined) {
    patch.description =
      typeof body.description === "string" ? body.description.trim() || null : null;
  }
  if (typeof body.url === "string") patch.payload = { url: body.url.trim() };
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  const updated = patchAutomation(id, patch);
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Re-attach stats so the client's AutomationWithStats shape stays
  // consistent across edits (PATCH doesn't change run history but the
  // typed contract expects the field present).
  return NextResponse.json({
    automation: { ...updated, stats: getAutomationStats(id) },
  });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const { id: idRaw } = await ctx.params;
  const id = Number(idRaw);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }
  const ok = deleteAutomation(id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
