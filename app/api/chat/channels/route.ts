import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { listChannelsForUser } from "@/lib/chat";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  return NextResponse.json({ channels: listChannelsForUser(auth.user) });
}
