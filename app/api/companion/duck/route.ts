import { NextRequest, NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { sendCompanionCommand } from "@/lib/companion-ws";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  action?: "duck" | "restore";
  level?: number;
}

export async function POST(req: NextRequest) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* empty body → default to duck */
  }

  const action = body.action === "restore" ? "restore" : "duck";
  const command =
    action === "restore"
      ? ({ type: "audio.restore" } as const)
      : ({ type: "audio.duck", level: body.level ?? 0.25 } as const);

  const acks = await sendCompanionCommand(auth.user.id, command);
  if (acks.length === 0) {
    return NextResponse.json(
      { ok: false, error: "no companion connected" },
      { status: 503 },
    );
  }
  const allOk = acks.every((a) => a.ok);
  return NextResponse.json(
    { ok: allOk, acks },
    { status: allOk ? 200 : 502 },
  );
}
