"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Circle } from "lucide-react";
import type { RecordingSession } from "@/types/recording";

/**
 * Header button for the remote browser + recorder. Idle state is a
 * hollow Circle; active state fills it red and pulses to mirror the
 * call icon's "live" affordance.
 *
 * Click semantics:
 *   idle   → POST starts a recording session, then navigate to
 *            /browser?recording=<id> (which spins up the headless
 *            Chromium and streams it back).
 *   active → just navigate to /browser?recording=<id>; we don't stop
 *            the session from here so a quick peek at another page
 *            can't accidentally end an in-progress recording. The
 *            /browser page has its own stop control.
 */
export default function RecordingToggle() {
  const router = useRouter();
  const [active, setActive] = useState<RecordingSession | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/api/recording/sessions", { cache: "no-store" });
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { active: RecordingSession | null };
        if (!cancelled) setActive(j.active);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onClick() {
    if (active) {
      router.push(`/browser?recording=${active.id}`);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch("/api/recording/sessions", { method: "POST" });
      if (!r.ok) return;
      const j = (await r.json()) as { session: RecordingSession };
      setActive(j.session);
      router.push(`/browser?recording=${j.session.id}`);
    } finally {
      setBusy(false);
    }
  }

  const isOn = active != null;
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={busy}
      aria-label={isOn ? "Open remote browser" : "Start remote browser"}
      aria-pressed={isOn}
      title={isOn ? "Open remote browser" : "Start remote browser"}
      className={`flex items-center gap-1.5 rounded-md px-3 py-1 transition disabled:opacity-50 ${
        isOn
          ? "text-red-400 hover:bg-neutral-900"
          : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
      }`}
    >
      <Circle
        className={`h-3.5 w-3.5 ${isOn ? "animate-pulse fill-current" : ""}`}
      />
    </button>
  );
}
