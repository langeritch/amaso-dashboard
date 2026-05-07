/**
 * Companion device registry.
 *
 * Per-user metadata about every macOS / Windows / Linux companion the
 * user has paired with the dashboard. The companion-ws WebSocket
 * handler is the sole writer: it calls registerDevice when a fresh
 * device.register message lands, touchDevice on every subsequent
 * message (so lastSeenAt stays fresh), and markDisconnected on
 * socket close. The registry keeps disconnected devices around for
 * 24 hours so the settings panel still shows "MacBook (offline)"
 * when the laptop is closed.
 *
 * In-memory only. The companion's deviceId is a stable UUID it
 * persists locally, so a device that comes back online after a
 * dashboard restart re-registers the same row instead of creating a
 * duplicate.
 */

export interface DeviceRecord {
  deviceId: string;
  /** User-set label (or a derived default like "user@host"). */
  deviceName: string;
  /** Node `process.platform`: darwin, win32, linux, ... */
  platform: string;
  /** Node `process.arch`: arm64, x64, ... */
  arch: string;
  userId: number;
  connectedAt: number;
  lastSeenAt: number;
  /** Null while the device's socket is open. Set on socket close so
   *  the panel can render an "offline" badge with a "last seen" time. */
  disconnectedAt: number | null;
}

const DISCONNECTED_TTL_MS = 24 * 60 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __amasoCompanionDevices: Map<string, DeviceRecord> | undefined;
}

function store(): Map<string, DeviceRecord> {
  if (!globalThis.__amasoCompanionDevices) {
    globalThis.__amasoCompanionDevices = new Map();
  }
  return globalThis.__amasoCompanionDevices;
}

/**
 * Sweep records for a given user. Drops disconnected devices older
 * than the TTL. Cheap (we only ever have a handful of paired devices
 * per user), and runs from every read so the registry stays clean
 * without a background timer.
 */
function sweep(userId: number): void {
  const now = Date.now();
  const all = store();
  for (const [deviceId, record] of all) {
    if (record.userId !== userId) continue;
    if (
      record.disconnectedAt != null &&
      now - record.disconnectedAt > DISCONNECTED_TTL_MS
    ) {
      all.delete(deviceId);
    }
  }
}

export interface RegisterDeviceInput {
  userId: number;
  deviceId: string;
  deviceName: string;
  platform: string;
  arch: string;
}

/**
 * Upsert a device record on the back of a fresh `device.register`
 * message. If the deviceId is already in the table (e.g. the laptop
 * went to sleep, woke up, and reconnected), we reuse the existing
 * connectedAt so the settings panel can show the original session
 * start time. lastSeenAt always bumps to now and disconnectedAt
 * clears so the row renders as online.
 */
export function registerDevice(input: RegisterDeviceInput): DeviceRecord {
  const all = store();
  const now = Date.now();
  const existing = all.get(input.deviceId);
  if (existing && existing.userId === input.userId) {
    existing.deviceName = input.deviceName;
    existing.platform = input.platform;
    existing.arch = input.arch;
    existing.lastSeenAt = now;
    existing.disconnectedAt = null;
    return existing;
  }
  const record: DeviceRecord = {
    deviceId: input.deviceId,
    deviceName: input.deviceName,
    platform: input.platform,
    arch: input.arch,
    userId: input.userId,
    connectedAt: now,
    lastSeenAt: now,
    disconnectedAt: null,
  };
  all.set(input.deviceId, record);
  return record;
}

/** Bump lastSeenAt without changing identity / status. Called on every
 *  inbound message so a quiet but live socket doesn't look stale. */
export function touchDevice(deviceId: string): DeviceRecord | null {
  const record = store().get(deviceId);
  if (!record) return null;
  record.lastSeenAt = Date.now();
  return record;
}

/** Called from the socket close handler. The record stays in the
 *  registry for DISCONNECTED_TTL_MS so the settings panel can keep
 *  showing the device with an "offline" badge. */
export function markDisconnected(deviceId: string): DeviceRecord | null {
  const record = store().get(deviceId);
  if (!record) return null;
  record.disconnectedAt = Date.now();
  record.lastSeenAt = record.disconnectedAt;
  return record;
}

export function getDevice(userId: number, deviceId: string): DeviceRecord | null {
  sweep(userId);
  const record = store().get(deviceId);
  if (!record || record.userId !== userId) return null;
  return record;
}

/** Currently-online devices for this user, newest connection first. */
export function getConnectedDevices(userId: number): DeviceRecord[] {
  sweep(userId);
  const out: DeviceRecord[] = [];
  for (const record of store().values()) {
    if (record.userId !== userId) continue;
    if (record.disconnectedAt != null) continue;
    out.push(record);
  }
  out.sort((a, b) => b.connectedAt - a.connectedAt);
  return out;
}

/** Connected plus disconnected-within-TTL, newest activity first. */
export function getAllDevices(userId: number): DeviceRecord[] {
  sweep(userId);
  const out: DeviceRecord[] = [];
  for (const record of store().values()) {
    if (record.userId !== userId) continue;
    out.push(record);
  }
  out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return out;
}
