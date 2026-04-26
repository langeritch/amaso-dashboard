"use client";

// Thin client bootstrap that decides whether demo mode is active by
// reading the `amaso_demo` cookie on mount, then mounts the heavy tour
// machinery. Kept in a separate file so the root layout doesn't have to
// pull in the cursor/audio/interceptor code for every normal visitor.

import { useEffect, useState } from "react";
import { DEMO_COOKIE, DEMO_ENABLED } from "@/lib/demo/session";
import DemoTour from "./demo/DemoTour";

function demoActive(): boolean {
  if (typeof document === "undefined") return false;
  const cookieSet = document.cookie
    .split(/;\s*/)
    .some((c) => c.startsWith(`${DEMO_COOKIE}=1`));
  if (cookieSet) return true;
  // URL fallback: when the dashboard is embedded in a cross-site iframe
  // (amaso.nl → dashboard.amaso.nl), the SameSite=Lax cookie set by the
  // /demo route may be dropped by the browser. Reading `demo=1` off the
  // query string gives us a second, cookie-independent signal.
  const q = new URLSearchParams(window.location.search).get("demo");
  return q === "1" || q === "true";
}

/** Drop the demo cookie on the current host at path=/ so a stale demo
 *  session stops hijacking the real app on subsequent page-loads. */
function clearDemoCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${DEMO_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

export default function DemoOverlay() {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!DEMO_ENABLED) {
      // Kill switch is off. Flush any stale cookie (left over from an
      // earlier session where demo was live) so future requests aren't
      // flagged server-side as demo either. URL-based activation is
      // simply ignored — no redirect/rewrite, just don't mount.
      if (
        document.cookie
          .split(/;\s*/)
          .some((c) => c.startsWith(`${DEMO_COOKIE}=`))
      ) {
        clearDemoCookie();
      }
      return;
    }
    setActive(demoActive());
  }, []);

  if (!DEMO_ENABLED) return null;
  if (!active) return null;
  return <DemoTour />;
}
