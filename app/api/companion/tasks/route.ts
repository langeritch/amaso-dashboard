// GET /api/companion/tasks: every companion command currently in
// flight or recently completed for the current user. Drives the
// Companion Tasks subsection of the workers panel.

import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { getActiveTasks, type CompanionTask } from "@/lib/companion-tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function taskToWire(t: CompanionTask) {
  return {
    id: t.id,
    deviceId: t.deviceId,
    deviceName: t.deviceName,
    commandType: t.commandType,
    description: t.description,
    status: t.status,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    resultSummary: t.resultSummary,
  };
}

export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  return NextResponse.json({
    tasks: getActiveTasks(auth.user.id).map(taskToWire),
  });
}
