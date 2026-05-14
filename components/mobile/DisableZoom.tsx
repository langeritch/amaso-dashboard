"use client";

import { useEffect } from "react";

/**
 * Hard-kill pinch / double-tap / gesture zoom on the mobile PWA.
 *
 * iOS Safari ignores `user-scalable=no` in standalone PWAs on
 * versions <16, and honours it inconsistently in newer ones —
 * pinch-zoom keeps slipping through under load, on rotation, and
 * when a Bluetooth keyboard joins mid-session. Sufficient fix is a
 * native-event listener layer that pre-empts every gesture the
 * browser would otherwise interpret as zoom.
 *
 * Only mounts inside MobileShell, which already gates on
 * matchMedia("(max-width: 767px)") — so the listeners never attach
 * on the desktop dashboard. No-op on render (no DOM); does its work
 * in useEffect.
 *
 * Listeners (all four):
 *   - gesturestart / gesturechange / gestureend → preventDefault().
 *     iOS-only events fired during pinch on Safari. Catching here is
 *     the single most effective lever on iOS.
 *   - touchmove with ≥2 fingers → preventDefault({ passive: false }).
 *     Belt to the gesture-event suspenders: any UA that doesn't fire
 *     gesturestart still goes through touchmove.
 *   - dblclick → preventDefault(). Synthetic event for the
 *     desktop-style double-click; cheap to catch.
 *   - Two touchend events within 300ms → preventDefault on the
 *     second. The double-tap-zoom path on iOS isn't always a real
 *     `dblclick`, especially in standalone mode; the timing guard
 *     is what actually stops it.
 *
 * Side effects: NONE on regular taps, pans, swipes, scrolls, or
 * input focus. The preventDefault calls are strictly scoped to
 * multi-finger gestures + the double-tap window.
 */
export default function DisableZoom() {
  useEffect(() => {
    // Single-touch double-tap timing. The window between two
    // touchends has to be tight enough that legitimate "two
    // separate taps near each other" don't get the second one
    // swallowed, but loose enough to catch slow double-taps.
    let lastTouchEndAt = 0;
    const DOUBLE_TAP_MS = 300;

    const onGesture = (e: Event) => {
      e.preventDefault();
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 1) e.preventDefault();
    };
    const onDoubleClick = (e: MouseEvent) => {
      e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => {
      const now = Date.now();
      if (now - lastTouchEndAt < DOUBLE_TAP_MS) {
        // Second tap inside the double-tap window — the browser
        // would synthesize a zoom event here on iOS. Kill it.
        e.preventDefault();
      }
      lastTouchEndAt = now;
    };

    // Document-level so we catch gestures over any descendant —
    // chat surface, history panel, modal sheets, settings, etc.
    // `passive: false` is mandatory for preventDefault on touchmove
    // since modern browsers default touch listeners to passive.
    document.addEventListener("gesturestart", onGesture as EventListener, { passive: false });
    document.addEventListener("gesturechange", onGesture as EventListener, { passive: false });
    document.addEventListener("gestureend", onGesture as EventListener, { passive: false });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("dblclick", onDoubleClick);
    document.addEventListener("touchend", onTouchEnd, { passive: false });

    return () => {
      document.removeEventListener("gesturestart", onGesture as EventListener);
      document.removeEventListener("gesturechange", onGesture as EventListener);
      document.removeEventListener("gestureend", onGesture as EventListener);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("dblclick", onDoubleClick);
      document.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  return null;
}
