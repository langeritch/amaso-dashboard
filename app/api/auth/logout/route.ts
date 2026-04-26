import { NextResponse } from "next/server";
import {
  clearSessionCookie,
  destroySession,
  getSessionIdFromCookies,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  const id = await getSessionIdFromCookies();
  if (id) destroySession(id);
  await clearSessionCookie();
  return NextResponse.json({ ok: true });
}
