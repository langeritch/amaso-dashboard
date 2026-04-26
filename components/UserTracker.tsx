"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Mounted once at the root of the authenticated layout. Heartbeats
 * presence to `/api/admin/presence` every 30 s, and re-pings
 * immediately on route change so the page-visit shows up in the
 * super-user activity log without waiting for the next interval.
 *
 * Each tab gets a stable `clientId` persisted in sessionStorage so a
 * page refresh re-attaches to the same presence row instead of
 * spawning a duplicate. The id is opaque random — no PII.
 *
 * Demo / unauthenticated paths skip mounting because the layout
 * gates this component on the same `sparBoot` predicate that gates
 * SparProvider — an anonymous request hits the auth wall and the
 * server-side handler 401s anyway.
 */

const CLIENT_ID_KEY = "amaso:tracker:clientId";
const HEARTBEAT_MS = 30_000;

function getOrCreateClientId(): string {
  if (typeof window === "undefined") return "";
  try {
    let id = window.sessionStorage.getItem(CLIENT_ID_KEY);
    if (id && id.length >= 8 && id.length <= 64) return id;
    id = generateId();
    window.sessionStorage.setItem(CLIENT_ID_KEY, id);
    return id;
  } catch {
    // Private mode or storage disabled — fall back to a per-mount
    // id. Worst case is one row per page load instead of one row
    // per tab. Acceptable for a tracker.
    return generateId();
  }
}

function generateId(): string {
  const bytes = new Uint8Array(12);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export default function UserTracker() {
  const pathname = usePathname();
  const clientIdRef = useRef<string>("");
  const lastPathRef = useRef<string | null>(null);

  // Lazy-create the client id on first mount.
  useEffect(() => {
    clientIdRef.current = getOrCreateClientId();
  }, []);

  // Heartbeat cadence. Independent of pathname change because we
  // want a steady "I'm alive" signal even on a single-page session.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const tick = () => {
      void ping(clientIdRef.current, lastPathRef.current);
    };
    const id = window.setInterval(tick, HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, []);

  // Route change: ping immediately so the page-visit lands in the
  // log without waiting for the next 30 s interval. lastPathRef
  // tracks what we sent last so the heartbeat can pass the latest
  // path on subsequent ticks.
  useEffect(() => {
    if (!pathname) return;
    lastPathRef.current = pathname;
    if (clientIdRef.current) {
      void ping(clientIdRef.current, pathname);
    }
  }, [pathname]);

  return null;
}

async function ping(clientId: string, path: string | null): Promise<void> {
  if (!clientId) return;
  try {
    await fetch("/api/admin/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, path }),
      cache: "no-store",
      keepalive: true,
    });
  } catch {
    /* offline / 401 / logged out — next tick will retry */
  }
}

/**
 * One-call helper for recording a feature-usage event from anywhere
 * in the app. Fire-and-forget; the server stores `{userId, label,
 * detail, at}` in user_activity. Don't put PII or large payloads in
 * `detail` — there's a 4 KB cap server-side.
 */
export function trackAction(label: string, detail?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  if (!label || label.length > 200) return;
  void fetch("/api/admin/activity", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, detail }),
    cache: "no-store",
    keepalive: true,
  }).catch(() => {
    /* swallow — feature usage is best-effort observability, never
       block a real action on a failed log */
  });
}
