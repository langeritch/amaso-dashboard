// GET /api/companion/devices: every paired companion device for the
// current user, including ones that disconnected within the last 24
// hours. Drives the Connected Devices section of the settings panel.

import { NextResponse } from "next/server";
import { apiRequireUser } from "@/lib/guard";
import { getAllDevices, type DeviceRecord } from "@/lib/companion-devices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function deviceToWire(d: DeviceRecord) {
  return {
    deviceId: d.deviceId,
    deviceName: d.deviceName,
    platform: d.platform,
    arch: d.arch,
    connected: d.disconnectedAt == null,
    connectedAt: d.connectedAt,
    lastSeenAt: d.lastSeenAt,
    disconnectedAt: d.disconnectedAt,
  };
}

export async function GET() {
  const auth = await apiRequireUser();
  if (!auth.ok) return auth.res;
  return NextResponse.json({
    devices: getAllDevices(auth.user.id).map(deviceToWire),
  });
}
