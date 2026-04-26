import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { claimShareToken } from "@/lib/terminal-uploads";

export const dynamic = "force-dynamic";

// ShareIngress POSTs the one-shot token from the URL here to resolve
// it to the on-disk path of the screenshot the user just shared.
export async function POST(req: Request) {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  const body = (await req.json().catch(() => null)) as { token?: string } | null;
  const token = body?.token;
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "no_token" }, { status: 400 });
  }
  const abs = claimShareToken(token);
  if (!abs) {
    return NextResponse.json({ error: "invalid_or_expired" }, { status: 404 });
  }
  return NextResponse.json({ path: abs });
}
