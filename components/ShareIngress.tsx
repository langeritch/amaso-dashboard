"use client";

import { useEffect } from "react";

// Mounted once at the root layout. Picks up `?share=<token>` left on
// the URL by the PWA share-target redirect, resolves it to an absolute
// on-disk path, stashes that path in sessionStorage for the next
// TerminalPane to consume, and — best-effort — lands the user on the
// last project they opened so the screenshot is in front of Claude
// within one tap.
export default function ShareIngress() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const token = url.searchParams.get("share");
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/terminal/share/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (cancelled || !res.ok) return;
        const { path } = (await res.json()) as { path?: string };
        if (path) sessionStorage.setItem("amaso:terminal-share", path);
      } catch {
        /* ignore — user can retry the share */
      } finally {
        if (cancelled) return;
        url.searchParams.delete("share");
        window.history.replaceState({}, "", url.toString());
        const last = localStorage.getItem("amaso:lastProject");
        // Only redirect when we're actually at the ingress URL — if the
        // user has already navigated elsewhere (rare on mobile, common
        // in testing), don't yank them away.
        if (last && window.location.pathname === "/") {
          window.location.replace(`/projects/${encodeURIComponent(last)}`);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
