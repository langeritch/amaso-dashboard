import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { getUnreadForUser } from "@/lib/chat";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const unread = getUnreadForUser(auth.user);
  return NextResponse.json(unread);
}
