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

import fs from "node:fs";
import path from "node:path";

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

/** Same TTL sweep as `sweep(userId)` but unscoped — drops every stale
 *  record across all users. Runs from the global admin view so a
 *  long-disconnected device doesn't keep showing up. */
function sweepAll(): void {
  const now = Date.now();
  const all = store();
  for (const [deviceId, record] of all) {
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
  return applyNameOverrides(out);
}

/** Every device across every user, newest activity first. Admin-only
 *  surface — feeds /admin/devices so admin A can see admin B's
 *  paired companions. Per-user reads stay scoped via `getAllDevices`. */
export function getAllDevicesAcrossUsers(): DeviceRecord[] {
  sweepAll();
  const out: DeviceRecord[] = [];
  for (const record of store().values()) out.push(record);
  out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return applyNameOverrides(out);
}

// ── Admin rename overrides ────────────────────────────────────────────
// The companion app sends its own deviceName on every `device.register`,
// and registerDevice() overwrites the in-memory name with it on each
// reconnect. So an admin rename can't just mutate the record — it would
// be clobbered the next time the laptop wakes up (or lost entirely on a
// dashboard restart, since the registry is in-memory). We persist the
// admin-set name in a small JSON file (data/companion-names.json) keyed
// by deviceId and re-apply it on every read, so the override always wins
// regardless of reconnects or restarts. No DB schema/migration needed;
// read/write failures degrade gracefully to the app-provided name.

const NAMES_FILE = path.resolve(process.cwd(), "data", "companion-names.json");

function readOverrideFile(): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(NAMES_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    // Missing file / parse error → no overrides yet.
    return {};
  }
}

function writeOverrideFile(map: Record<string, string>): void {
  try {
    fs.mkdirSync(path.dirname(NAMES_FILE), { recursive: true });
    fs.writeFileSync(NAMES_FILE, JSON.stringify(map, null, 2), "utf8");
  } catch (err) {
    console.warn(
      "[companion-devices] failed to persist device name override:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

function loadNameOverrides(deviceIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  if (deviceIds.length === 0) return map;
  const all = readOverrideFile();
  for (const id of deviceIds) {
    const name = all[id];
    if (typeof name === "string" && name) map.set(id, name);
  }
  return map;
}

/** Overwrite each record's deviceName with the admin override when one
 *  exists. Mutates in place (the override is authoritative) and returns
 *  the same array for call-site convenience. */
function applyNameOverrides(records: DeviceRecord[]): DeviceRecord[] {
  if (records.length === 0) return records;
  const overrides = loadNameOverrides(records.map((r) => r.deviceId));
  if (overrides.size === 0) return records;
  for (const r of records) {
    const o = overrides.get(r.deviceId);
    if (o) r.deviceName = o;
  }
  return records;
}

/**
 * Admin-set display name for a companion device. Persists the override
 * (survives reconnects + dashboard restarts) and reflects it on the live
 * in-memory record immediately. Returns the updated record, or null when
 * the name is empty or the device isn't in the live registry (the
 * override is still persisted in that case). Caller validates admin role.
 */
export function renameDevice(
  deviceId: string,
  displayName: string,
): DeviceRecord | null {
  const name = displayName.trim();
  if (!name) return null;
  const all = readOverrideFile();
  all[deviceId] = name;
  writeOverrideFile(all);
  const record = store().get(deviceId);
  if (record) {
    record.deviceName = name;
    return record;
  }
  return null;
}
