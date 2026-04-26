// Read-only mirror of recent dispatches spar has fired for this user.
// The spar UI polls this to render the "just sent" banner after a real
// dispatch lands in a project terminal.

import { getCurrentUser } from "@/lib/auth";
import { recentDispatches } from "@/lib/spar-dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response("unauthorized", { status: 401 });
  const rows = recentDispatches(user.id, 20).map((d) => ({
    id: d.id,
    projectId: d.projectId,
    prompt: d.prompt,
    status: d.status,
    confirmedAt: d.confirmedAt,
    completedAt: d.completedAt ?? null,
    error: d.error ?? null,
  }));
  return Response.json({ dispatches: rows });
}
