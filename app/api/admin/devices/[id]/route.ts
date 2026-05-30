// PATCH /api/admin/devices/[id]: rename a companion device (admin-only).
// [id] is the device's stable UUID. The new name is persisted as an
// override in companion_device_names and re-applied on every read, so it
// survives the device reconnecting (which re-sends the app's own name)
// and dashboard restarts. The per-user view at /api/companion/devices is
// unchanged. See lib/companion-devices.ts:renameDevice.

import { NextResponse } from "next/server";
import { apiRequireAdmin } from "@/lib/guard";
import {
  renameDevice,
  getAllDevicesAcrossUsers,
} from "@/lib/companion-devices";
import { recordAudit } from "@/lib/audit";
import { ipFromRequest } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NAME_LEN = 120;

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await apiRequireAdmin();
  if (!auth.ok) return auth.res;

  const { id: deviceId } = await ctx.params;
  if (!deviceId) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as
    | { displayName?: string }
    | null;
  const displayName =
    typeof body?.displayName === "string" ? body.displayName.trim() : "";
  if (!displayName) {
    return NextResponse.json({ error: "empty_name" }, { status: 400 });
  }
  if (displayName.length > MAX_NAME_LEN) {
    return NextResponse.json({ error: "name_too_long" }, { status: 400 });
  }

  // Snapshot the current (possibly already-overridden) name for the audit
  // trail before we overwrite it.
  const before = getAllDevicesAcrossUsers().find(
    (d) => d.deviceId === deviceId,
  );

  const updated = renameDevice(deviceId, displayName);

  recordAudit({
    action: "companion.renamed",
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    actorIp: ipFromRequest(req),
    targetKind: "companion_device",
    targetId: deviceId,
    meta: {
      from: before?.deviceName ?? null,
      to: displayName,
      // Whether the device was in the live registry at rename time. The
      // override is persisted either way; an offline device past its TTL
      // just isn't in memory to mutate.
      live: updated != null,
    },
  });

  return NextResponse.json({
    ok: true,
    device: updated
      ? { deviceId: updated.deviceId, deviceName: updated.deviceName }
      : { deviceId, deviceName: displayName },
  });
}
