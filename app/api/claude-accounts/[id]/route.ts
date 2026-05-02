// Per-account routes — see app/api/claude-accounts/route.ts for the
// collection-level surface and rationale.
//
// PATCH  /api/claude-accounts/:id   — edit name and/or apiKey
// DELETE /api/claude-accounts/:id   — remove (refused for "default")

import { NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import {
  removeAccount,
  updateAccount,
  viewAccounts,
} from "@/lib/claude-accounts";
import { restartTelegramVoice } from "@/lib/telegram-voice-sidecar";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const { id } = await params;
  let body: { name?: string; apiKey?: string | null };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    const account = updateAccount(id, {
      name: body.name,
      apiKey: body.apiKey,
    });
    // If this account is the active one, the telegram-voice sidecar may be
    // running with the OLD api key — bounce it so the change is live.
    const accounts = viewAccounts();
    if (accounts.find((a) => a.id === id)?.active) {
      void restartTelegramVoice().catch(() => {});
    }
    return NextResponse.json({ account, accounts });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "update_failed";
    const status = msg === "account_not_found" ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  const { id } = await params;
  try {
    removeAccount(id);
    // If the deleted account was active, removeAccount() falls back to
    // default. Bounce the sidecar so it picks up the fallback's key.
    void restartTelegramVoice().catch(() => {});
    return NextResponse.json({ accounts: viewAccounts() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "delete_failed";
    const status = msg === "account_not_found" ? 404 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
