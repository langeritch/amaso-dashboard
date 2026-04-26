"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff } from "lucide-react";

type Status =
  | "unsupported"   // browser / PWA context can't do push
  | "unavailable"   // server has no VAPID keys configured
  | "loading"       // initial check in flight
  | "prompt"        // permission not asked yet OR asked but not subscribed
  | "denied"        // user blocked notifications
  | "on"            // subscribed + active
  | "error";

/** Base64 URL → Uint8Array backed by a plain ArrayBuffer (required by
 *  PushManager.subscribe, which rejects Shared-backed typed arrays). */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const s = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(s);
  const buf = new ArrayBuffer(raw.length);
  const arr = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr as Uint8Array<ArrayBuffer>;
}

/** Drawer-styled opt-in for browser push notifications. Shows as a single
 *  row so it fits next to Sign out / Theme in the mobile hamburger and
 *  just as a button on desktop. */
export default function PushToggle({
  variant = "row",
}: {
  /** "row" = full-width drawer row; "inline" = compact icon-only button. */
  variant?: "row" | "inline";
}) {
  const [status, setStatus] = useState<Status>("loading");
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      setStatus("unsupported");
      return;
    }
    try {
      const cfg = await fetch("/api/push/config", { cache: "no-store" });
      if (!cfg.ok) {
        setStatus("unavailable");
        return;
      }
      const data = (await cfg.json()) as {
        enabled: boolean;
        publicKey: string | null;
      };
      if (!data.enabled || !data.publicKey) {
        setStatus("unavailable");
        return;
      }
      setPublicKey(data.publicKey);

      const perm = Notification.permission;
      if (perm === "denied") {
        setStatus("denied");
        return;
      }

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub && perm === "granted") {
        setStatus("on");
      } else {
        setStatus("prompt");
      }
    } catch {
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const enable = useCallback(async () => {
    if (!publicKey) return;
    setBusy(true);
    try {
      // Requesting permission from inside a user click is required on
      // Safari/iOS — make sure this is called from the onClick stack.
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setStatus(perm === "denied" ? "denied" : "prompt");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error("subscribe_failed");
      setStatus("on");
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }, [publicKey]);

  const disable = useCallback(async () => {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        try {
          await fetch("/api/push/subscribe", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
        } catch {
          /* still unsubscribe the browser even if server call fails */
        }
        await sub.unsubscribe();
      }
      setStatus("prompt");
    } catch {
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }, []);

  // Hide entirely when the platform or server can't do push — we don't want
  // to tease a feature that won't work.
  if (status === "unsupported" || status === "unavailable") return null;

  if (variant === "inline") {
    return (
      <button
        type="button"
        onClick={status === "on" ? disable : enable}
        disabled={busy || status === "denied"}
        title={labelFor(status)}
        aria-label={labelFor(status)}
        className="flex min-h-[40px] min-w-[40px] items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 disabled:opacity-50 sm:min-h-0 sm:min-w-0 sm:px-2 sm:py-1"
      >
        {status === "on" ? (
          <Bell className="h-4 w-4 text-emerald-400 sm:h-3.5 sm:w-3.5" />
        ) : (
          <BellOff className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
        )}
      </button>
    );
  }

  // Drawer row
  const on = status === "on";
  const denied = status === "denied";
  return (
    <button
      type="button"
      onClick={on ? disable : enable}
      disabled={busy || denied}
      className="flex min-h-[48px] w-full items-center gap-3 px-4 text-base text-neutral-300 hover:bg-neutral-900 disabled:opacity-60"
    >
      {on ? (
        <Bell className="h-5 w-5 text-emerald-400" />
      ) : (
        <BellOff className="h-5 w-5" />
      )}
      <span className="flex-1 text-left">
        {labelFor(status)}
        {denied && (
          <span className="ml-2 text-[11px] text-neutral-500">
            — unblock in browser settings
          </span>
        )}
      </span>
      {busy && <span className="text-xs text-neutral-500">…</span>}
    </button>
  );
}

function labelFor(status: Status): string {
  switch (status) {
    case "on":
      return "Notifications on";
    case "prompt":
      return "Enable notifications";
    case "denied":
      return "Notifications blocked";
    case "loading":
      return "Checking notifications…";
    case "error":
      return "Notifications unavailable";
    default:
      return "Notifications";
  }
}
