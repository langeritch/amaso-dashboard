// REST surface for the Claude account switcher. See lib/claude-accounts.ts
// for the data model and wiring rationale.
//
// GET    /api/claude-accounts        — list (API keys masked)
// POST   /api/claude-accounts        — add account
// PUT    /api/claude-accounts        — switch active account ({ id })
//
// Per-account update/delete live in [id]/route.ts.
//
// Admin-only — switching accounts is a privileged action: the new active
// identity drives every dispatch / spar prompt / inbound voice call until
// changed again.

import { NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import {
  addAccount,
  ensureDefaultAccount,
  setActiveAccount,
  viewAccounts,
} from "@/lib/claude-accounts";
import { restartTelegramVoice } from "@/lib/telegram-voice-sidecar";
import { stopAll as stopAllTerminals } from "@/lib/terminal-backend";
import { restartPtyServiceProcess } from "@/lib/pty-service-restart";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  // Materialise the default account on first GET so the UI always has at
  // least one row to show — keeps the list non-empty even before the
  // operator adds anything.
  ensureDefaultAccount();
  return NextResponse.json({ accounts: viewAccounts() });
}

export async function POST(req: Request) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  let body: {
    name?: string;
    captureFromDefault?: boolean;
    credentialsJson?: string;
    apiKey?: string | null;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  try {
    const { account } = addAccount({
      name: body.name ?? "",
      captureFromDefault: body.captureFromDefault === true,
      credentialsJson: body.credentialsJson,
      apiKey: body.apiKey ?? null,
    });
    return NextResponse.json({ account, accounts: viewAccounts() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "add_failed" },
      { status: 400 },
    );
  }
}

export async function PUT(req: Request) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;
  let body: { id?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body.id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  try {
    const account = setActiveAccount(body.id);
    // Kill all terminal sessions — they hold stale credentials from the
    // previous account. Awaits remote DELETEs so respawns don't race
    // stale sessions on the PTY service.
    const killed = await stopAllTerminals();
    if (killed > 0) {
      console.log(`[claude-accounts] killed ${killed} terminal(s) on account switch`);
    }
    // Restart the PTY service process itself. stopAllTerminals already
    // tore down individual sessions, but the service node may have
    // booted holding env / handles that captured the old account
    // context — bouncing it guarantees the next spawn lands on a
    // clean slate. The supervising scheduled task respawns it within
    // seconds (immediately on the schtasks kick, otherwise on the
    // watchdog's next health probe). Fire-and-forget shape so the UI
    // gets its response without waiting on the relaunch.
    try {
      const r = restartPtyServiceProcess();
      console.log(
        `[claude-accounts] pty-service restart: killed=${r.killed} pid=${r.pid ?? "<none>"} port=${r.port}`,
      );
    } catch (err) {
      console.warn("[claude-accounts] pty-service restart failed:", err);
    }
    // Telegram-voice reads ANTHROPIC_API_KEY at boot, so the active key
    // only takes effect after a respawn. Fire-and-forget — UI responds
    // immediately and the bounce happens in the background.
    void restartTelegramVoice().catch((err) => {
      console.warn("[claude-accounts] telegram-voice restart failed:", err);
    });
    return NextResponse.json({ account, accounts: viewAccounts() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "switch_failed" },
      { status: 400 },
    );
  }
}
