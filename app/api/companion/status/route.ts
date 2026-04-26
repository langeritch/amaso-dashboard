import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { isCompanionConnected } from "@/lib/companion-ws";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  return NextResponse.json({ connected: isCompanionConnected(auth.user.id) });
}
