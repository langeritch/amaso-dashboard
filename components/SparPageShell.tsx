"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Menu } from "lucide-react";
import SparSidebar from "./SparSidebar";

const PINNED_STORAGE_KEY = "spar:sidebarPinned:v1";
const SMALL_VIEWPORT_QUERY = "(max-width: 767px)";

/**
 * Page-level shell for the spar route. Owns the sidebar drawer's
 * open/close state, the user's pin preference, and the small-
 * viewport detection that auto-disables pinning where there isn't
 * room for both the column and the chat.
 *
 * Two layouts:
 *
 *   - **Pinned (desktop only):** flex-row with the sidebar in flow
 *     as a permanent ~280px column on the left. No hamburger, no
 *     backdrop — the user explicitly asked for the column to live
 *     there. The pin toggle inside the sidebar header switches back
 *     to drawer mode.
 *
 *   - **Unpinned (default, all viewports):** flex-col with a fixed-
 *     position drawer that slides in from the left. A hamburger at
 *     top-left opens it, ESC / X-button / backdrop click closes it.
 *     The hamburger hides while the drawer is open so the X button
 *     and backdrop are the canonical close affordances.
 */
export default function SparPageShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // The user's saved preference. May be true on a small viewport
  // (the user pinned earlier on a laptop and is now on their phone)
  // — we keep the preference but ignore it via `effectivePinned`.
  const [pinnedPref, setPinnedPref] = useState(false);
  const [pinnedLoaded, setPinnedLoaded] = useState(false);
  const [isSmall, setIsSmall] = useState(false);

  // Hydrate the pin preference once on mount. Done in an effect so
  // SSR matches the initial client paint (always unpinned), then we
  // sync to localStorage on the next tick.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PINNED_STORAGE_KEY);
      if (raw === "1") setPinnedPref(true);
    } catch {
      /* private mode — fall back to default unpinned */
    } finally {
      setPinnedLoaded(true);
    }
  }, []);
  useEffect(() => {
    if (!pinnedLoaded) return;
    try {
      if (pinnedPref) {
        window.localStorage.setItem(PINNED_STORAGE_KEY, "1");
      } else {
        window.localStorage.removeItem(PINNED_STORAGE_KEY);
      }
    } catch {
      /* quota / private mode — non-fatal */
    }
  }, [pinnedPref, pinnedLoaded]);

  // Track viewport size so we can auto-unpin on phones. Pinning a
  // 280px column on a 360px screen would leave the chat composer at
  // ~80px wide — unusable. matchMedia keeps this in sync with
  // orientation flips and split-screen multitasking.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(SMALL_VIEWPORT_QUERY);
    const update = () => setIsSmall(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  const canPin = !isSmall;
  const effectivePinned = pinnedPref && canPin;

  // ESC closes the drawer. Backdrop click handles pointer dismiss.
  // No-op while pinned — there's nothing to close, and ESC shouldn't
  // accidentally unpin (the pin toggle is the only path back).
  useEffect(() => {
    if (effectivePinned || !open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, effectivePinned]);

  // Listen for spar:remote-sidebar events so the spar voice assistant
  // can open / close the left sidebar via /api/spar/remote-control.
  // No-op when pinned (the column is permanent in that mode and
  // there's nothing to toggle).
  useEffect(() => {
    if (effectivePinned) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ side?: string; open?: boolean }>)
        .detail;
      if (!detail || detail.side !== "left") return;
      setOpen(Boolean(detail.open));
    };
    window.addEventListener("spar:remote-sidebar", handler);
    return () => window.removeEventListener("spar:remote-sidebar", handler);
  }, [effectivePinned]);

  const togglePin = () => {
    setPinnedPref((prev) => !prev);
    // Drawer state is irrelevant once pinned, but resetting here
    // means the next unpin doesn't suddenly reveal a stale "open"
    // state from before the pin.
    setOpen(false);
  };

  // Show the hamburger only when we're in drawer mode AND the
  // drawer itself is closed. Pinned: the column IS the visible
  // affordance, no toggle needed. Open drawer: the X / backdrop /
  // ESC handle close, and the hamburger overlapping the open
  // sidebar's left edge looked redundant.
  const showHamburger = !effectivePinned && !open;

  if (effectivePinned) {
    return (
      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        <SparSidebar
          open
          pinned
          canPin
          onClose={() => setOpen(false)}
          onTogglePin={togglePin}
        />
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <SparSidebar
        open={open}
        pinned={false}
        canPin={canPin}
        onClose={() => setOpen(false)}
        onTogglePin={togglePin}
      />
      {showHamburger && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="open sidebar"
          aria-expanded={false}
          className="amaso-fx amaso-press absolute left-2 top-2 z-20 flex h-11 w-11 items-center justify-center rounded-md border border-neutral-800/80 bg-neutral-900/85 text-neutral-300 shadow-lg backdrop-blur-md hover:border-neutral-700 hover:bg-neutral-800 sm:h-9 sm:w-9"
        >
          <Menu className="h-5 w-5 sm:h-4 sm:w-4" />
        </button>
      )}
      {children}
    </div>
  );
}
