import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { getPublicVapidKey, pushEnabled } from "@/lib/push";

export const dynamic = "force-dynamic";

/** Public VAPID key + availability flag for the client to decide whether to
 *  show the "Enable notifications" affordance at all. */
export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  return NextResponse.json({
    enabled: pushEnabled(),
    publicKey: pushEnabled() ? getPublicVapidKey() : null,
  });
}
