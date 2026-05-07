"use client";

import { useEffect, useMemo, useState } from "react";
import { Apple, Laptop, Monitor, RefreshCcw } from "lucide-react";

interface DeviceWire {
  deviceId: string;
  deviceName: string;
  platform: string;
  arch: string;
  connected: boolean;
  connectedAt: number;
  lastSeenAt: number;
  disconnectedAt: number | null;
}

const POLL_INTERVAL_MS = 10_000;

/**
 * Connected-devices block for the settings page. Polls
 * /api/companion/devices every 10s and renders each paired companion
 * with a green dot when online, gray when offline. Mirrors the
 * Section / row chrome the rest of SettingsPanel uses so it slots in
 * without restyling.
 */
export default function CompanionDevicesSection() {
  const [devices, setDevices] = useState<DeviceWire[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDevices = useMemo(
    () =>
      async function () {
        setLoading(true);
        try {
          const res = await fetch("/api/companion/devices", {
            cache: "no-store",
          });
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
      },
    [],
  );

  useEffect(() => {
    void fetchDevices();
    const id = window.setInterval(fetchDevices, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [fetchDevices]);

  if (devices === null && !error) {
    return (
      <section className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-950/60 shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
        <h2 className="px-4 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
          Connected devices
        </h2>
        <div className="px-4 pb-3 text-xs italic text-neutral-500">
          Loading...
        </div>
      </section>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800/80 bg-neutral-950/60 shadow-[0_1px_2px_rgba(0,0,0,0.2)]">
      <header className="flex items-center justify-between px-4 pb-2 pt-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
          Connected devices
        </h2>
        <button
          type="button"
          onClick={() => void fetchDevices()}
          disabled={loading}
          className="amaso-fx inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200 disabled:opacity-50"
          aria-label="Refresh devices"
        >
          <RefreshCcw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
          <span>Refresh</span>
        </button>
      </header>
      {error && (
        <div className="px-4 pb-2 text-xs text-red-300">{error}</div>
      )}
      {devices && devices.length === 0 && (
        <div className="px-4 pb-3 text-xs italic text-neutral-500">
          No companion devices paired yet. Open the Amaso menu-bar app to
          register one.
        </div>
      )}
      {devices && devices.length > 0 && (
        <ul className="flex flex-col">
          {devices.map((d, idx) => (
            <DeviceRow key={d.deviceId} device={d} divider={idx > 0} />
          ))}
        </ul>
      )}
    </section>
  );
}

function DeviceRow({
  device,
  divider,
}: {
  device: DeviceWire;
  divider: boolean;
}) {
  const Icon = pickIcon(device.platform);
  const platformLabel = formatPlatform(device.platform, device.arch);
  const statusText = device.connected
    ? "Online"
    : `Offline · last seen ${formatRelative(device.lastSeenAt)}`;
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
        <div className="truncate text-sm font-medium text-neutral-100">
          {device.deviceName}
        </div>
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
