"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Apple, Laptop, Monitor, Pencil, RefreshCcw } from "lucide-react";

type Role = "admin" | "team" | "client" | null;

interface OwnerWire {
  id: number;
  email: string;
  name: string;
  role: Role;
  isAdmin: boolean;
}

interface DeviceWire {
  deviceId: string;
  deviceName: string;
  platform: string;
  arch: string;
  connected: boolean;
  connectedAt: number;
  lastSeenAt: number;
  disconnectedAt: number | null;
  owner: OwnerWire;
}

// Same 10s cadence as the per-user CompanionDevicesSection so the
// connected dot updates at the same rate any operator already expects.
// The companion-ws layer is server-only (no client subscribe), so we
// match the existing polling pattern rather than open a parallel
// browser WS just for this view.
const POLL_INTERVAL_MS = 10_000;
type StatusFilter = "all" | "online" | "offline";

/**
 * Admin-only global devices view. Polls /api/admin/devices every 10s,
 * groups rows by owner so admin A can see which devices belong to
 * admin B, and offers a free-text filter (owner name / email / device
 * name) plus an online/offline filter on top. Admin-owned blocks
 * float to the top of the list. The per-user Settings → Connected
 * devices section stays scoped to one user.
 */
export default function AdminDevices() {
  const [devices, setDevices] = useState<DeviceWire[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/devices", { cache: "no-store" });
      if (!res.ok) {
        setError(`Failed to load devices (${res.status})`);
        return;
      }
      const body = (await res.json()) as { devices?: DeviceWire[] };
      setDevices(Array.isArray(body.devices) ? body.devices : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchDevices();
    const id = window.setInterval(fetchDevices, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [fetchDevices]);

  const filtered = useMemo(() => {
    if (!devices) return [];
    const q = query.trim().toLowerCase();
    return devices.filter((d) => {
      if (status === "online" && !d.connected) return false;
      if (status === "offline" && d.connected) return false;
      if (q) {
        const hay = [
          d.owner.name,
          d.owner.email,
          d.deviceName,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [devices, status, query]);

  // Group rows by owner so admin A's MacBook + Mac mini sit together,
  // then admin B's row, etc. Within an owner block we keep the
  // newest-activity-first ordering the API already returns.
  const grouped = useMemo(() => {
    const byOwner = new Map<number, { owner: OwnerWire; devices: DeviceWire[] }>();
    for (const d of filtered) {
      const existing = byOwner.get(d.owner.id);
      if (existing) existing.devices.push(d);
      else byOwner.set(d.owner.id, { owner: d.owner, devices: [d] });
    }
    return Array.from(byOwner.values()).sort((a, b) => {
      // Admins float to the top so a fellow admin's devices are the
      // first thing you see on this page.
      if (a.owner.isAdmin !== b.owner.isAdmin) {
        return a.owner.isAdmin ? -1 : 1;
      }
      return (a.owner.name || a.owner.email).localeCompare(
        b.owner.name || b.owner.email,
      );
    });
  }, [filtered]);

  if (devices === null && !error) {
    return (
      <section className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-950/60 shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
        <div className="px-4 py-6 text-xs italic text-neutral-500">
          Loading...
        </div>
      </section>
    );
  }

  const onlineCount = devices?.filter((d) => d.connected).length ?? 0;
  const totalCount = devices?.length ?? 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center gap-2">
        <div className="text-[11px] uppercase tracking-[0.16em] text-neutral-500">
          {onlineCount} online · {totalCount} total
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter owner or device…"
            aria-label="Filter by owner name, email, or device name"
            className="amaso-fx min-w-[200px] rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 hover:border-neutral-700 focus:border-neutral-600 focus:outline-none"
          />
          <FilterSelect
            value={status}
            onChange={(v) => setStatus(v as StatusFilter)}
            options={[
              { value: "all", label: "All status" },
              { value: "online", label: "Online" },
              { value: "offline", label: "Offline" },
            ]}
            aria="Filter by status"
          />
          <button
            type="button"
            onClick={() => void fetchDevices()}
            disabled={loading}
            className="amaso-fx inline-flex items-center gap-1 rounded-md border border-neutral-800 px-2 py-1 text-[11px] uppercase tracking-wider text-neutral-400 hover:border-neutral-700 hover:bg-neutral-900 hover:text-neutral-200 disabled:opacity-50"
            aria-label="Refresh devices"
          >
            <RefreshCcw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-md border border-red-900/40 bg-red-950/30 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {filtered.length === 0 ? (
        <section className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-950/60 shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
          <div className="px-4 py-8 text-center text-xs italic text-neutral-500">
            {totalCount === 0
              ? "No companion devices paired yet."
              : "No devices match the current filters."}
          </div>
        </section>
      ) : (
        <div className="space-y-3">
          {grouped.map((group) => (
            <section
              key={group.owner.id}
              className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-950/60 shadow-[0_1px_2px_rgba(0,0,0,0.2)]"
            >
              <header className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="truncate text-sm font-medium text-neutral-100">
                      {group.owner.name || group.owner.email}
                    </span>
                    {group.owner.isAdmin && (
                      <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-amber-300">
                        Admin
                      </span>
                    )}
                    {!group.owner.isAdmin && group.owner.role && (
                      <span className="inline-flex items-center rounded-full border border-neutral-700/60 bg-neutral-900/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-neutral-400">
                        {group.owner.role}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-neutral-500">
                    {group.owner.email}
                  </div>
                </div>
                <div className="text-[10px] uppercase tracking-[0.16em] text-neutral-500">
                  {group.devices.filter((d) => d.connected).length}/
                  {group.devices.length} online
                </div>
              </header>
              <ul className="flex flex-col border-t border-neutral-800/70">
                {group.devices.map((d, idx) => (
                  <DeviceRow
                    key={d.deviceId}
                    device={d}
                    divider={idx > 0}
                    onRenamed={fetchDevices}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
  aria,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  aria: string;
}) {
  return (
    <select
      aria-label={aria}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="amaso-fx rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs text-neutral-200 hover:border-neutral-700 focus:border-neutral-600 focus:outline-none"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function DeviceRow({
  device,
  divider,
  onRenamed,
}: {
  device: DeviceWire;
  divider: boolean;
  onRenamed: () => void | Promise<void>;
}) {
  const Icon = pickIcon(device.platform);
  const platformLabel = formatPlatform(device.platform, device.arch);
  const statusText = device.connected
    ? "Online"
    : `Offline · last seen ${formatRelative(device.lastSeenAt)}`;

  // Inline rename — offline devices can be renamed too (we only persist a
  // display-name override; nothing about the device's connection state
  // changes). Click the pencil → input; Enter saves, Escape cancels.
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(device.deviceName);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const startEdit = () => {
    setValue(device.deviceName);
    setErr(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setValue(device.deviceName);
    setErr(null);
  };
  const save = async () => {
    const name = value.trim();
    if (!name) {
      setErr("Name can't be empty");
      return;
    }
    if (name === device.deviceName) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/admin/devices/${encodeURIComponent(device.deviceId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName: name }),
        },
      );
      if (!res.ok) {
        setErr(`Rename failed (${res.status})`);
        return;
      }
      setEditing(false);
      await onRenamed();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <li
      className={`flex items-center gap-3 px-4 py-3 ${
        divider ? "border-t border-neutral-800/70" : ""
      }`}
    >
      <span
        aria-hidden
        className={`h-2 w-2 flex-shrink-0 rounded-full ${
          device.connected
            ? "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.85)]"
            : "bg-neutral-600"
        }`}
      />
      <Icon className="h-5 w-5 flex-shrink-0 text-neutral-500" />
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void save();
                } else if (e.key === "Escape") {
                  cancel();
                }
              }}
              maxLength={120}
              placeholder="Device name…"
              className="min-w-[160px] rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !value.trim()}
              className="amaso-fx amaso-press rounded-md bg-orange-500 px-2.5 py-1 text-xs font-semibold text-neutral-950 hover:bg-orange-400 disabled:bg-neutral-700 disabled:text-neutral-400"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:border-neutral-700"
            >
              Cancel
            </button>
            {err && <span className="text-xs text-rose-300">{err}</span>}
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="truncate text-sm font-medium text-neutral-100">
              {device.deviceName}
            </span>
            <span className="font-mono text-[10px] text-neutral-600">
              {device.deviceId.slice(0, 8)}
            </span>
            <button
              type="button"
              onClick={startEdit}
              title="Rename device"
              aria-label="Rename device"
              className="text-neutral-600 transition-colors hover:text-neutral-300"
            >
              <Pencil className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className="mt-0.5 truncate text-[11px] text-neutral-500">
          {platformLabel} <span className="text-neutral-700">·</span>{" "}
          {statusText}
        </div>
      </div>
    </li>
  );
}

function pickIcon(platform: string) {
  const p = platform.toLowerCase();
  if (p === "darwin") return Apple;
  if (p === "win32" || p === "windows") return Monitor;
  return Laptop;
}

function formatPlatform(platform: string, arch: string): string {
  const p = platform.toLowerCase();
  let label = platform;
  if (p === "darwin") label = "macOS";
  else if (p === "win32" || p === "windows") label = "Windows";
  else if (p === "linux") label = "Linux";
  if (arch && arch !== "unknown") label += ` · ${arch}`;
  return label;
}

function formatRelative(ms: number): string {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
