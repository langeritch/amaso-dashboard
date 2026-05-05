"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GripHorizontal, PictureInPicture2, X } from "lucide-react";
import { getYoutubeMount } from "@/lib/youtube-player-handle";
import { useSpar } from "./SparContext";

/**
 * Picture-in-Picture toggle for the spar media row.
 *
 * Only renders when filler mode is "youtube" AND a video is currently
 * playing — otherwise the button is hidden so it never takes layout
 * space when there's nothing to pop out.
 *
 * Toggling ON repositions the existing audio iframe wrapper as a
 * fixed-position floating overlay (bottom-right corner). The wrapper
 * stays inside the same document — moving it across documents (e.g.
 * via the Document Picture-in-Picture API) makes YouTube kill the
 * embed with error 153, so we deliberately avoid that path.
 *
 * Implementation note on iframe re-use: useYoutubeFiller already runs
 * a hidden YouTube iframe for audio. Spinning up a SECOND visible
 * iframe would race that one and produce double audio, so we re-home
 * the existing iframe by repositioning its wrapper element via CSS.
 * No remount, no playhead reset.
 */

type ActiveMode = "off" | "overlay";

const DESKTOP_W = 320;
const DESKTOP_H = 180;
const MOBILE_W = 240;
const MOBILE_H = 135;
const MARGIN = 16;
// Height of the controls bar (h-7 = 1.75rem = 28px). The iframe is
// shrunk by this many pixels at the top so the bar always has a clean,
// iframe-free hit area — without this, YouTube's iframe swallows clicks
// regardless of z-index stacking and the close X is unreachable.
const CONTROLS_BAR_H = 28;

const isDesktopViewport = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(min-width: 768px)").matches;

export default function YoutubePiPButton() {
  const { fillerNow } = useSpar();
  const [active, setActive] = useState<ActiveMode>("off");
  // The mount element, exposed via React state so the portal re-renders
  // when it becomes available. We read getYoutubeMount() imperatively
  // elsewhere; this state exists purely to drive the createPortal call.
  const [mountEl, setMountEl] = useState<HTMLElement | null>(null);

  // Saved location + styles before the overlay applied its own. We
  // restore these verbatim on close so the off-screen positioning
  // (left:-10000px etc) returns intact.
  const originalParentRef = useRef<Node | null>(null);
  const savedStylesRef = useRef<{ cssText: string } | null>(null);
  // The YT iframe inside the wrapper. We push it down by CONTROLS_BAR_H
  // so it doesn't underlap (and steal clicks from) the controls bar.
  // Tracked separately so teardown can restore exactly what was there
  // — including an empty cssText, which is the common case since YT
  // sets attributes, not inline styles, on the iframe.
  const savedIframeRef = useRef<{ el: HTMLIFrameElement; cssText: string } | null>(
    null,
  );

  const isYoutubePlaying =
    fillerNow.kind === "youtube" && fillerNow.status === "playing";

  const teardown = useCallback(() => {
    const mount = getYoutubeMount();
    const saved = savedStylesRef.current;
    const origParent = originalParentRef.current;

    if (mount && origParent && mount.parentNode !== origParent) {
      try {
        origParent.appendChild(mount);
      } catch {
        /* ignore — parent may have been removed mid-session */
      }
    }
    if (mount && saved) {
      mount.style.cssText = saved.cssText;
    }
    const savedIframe = savedIframeRef.current;
    if (savedIframe) {
      try {
        savedIframe.el.style.cssText = savedIframe.cssText;
      } catch {
        /* iframe may already be gone — fine, nothing to restore */
      }
    }
    savedIframeRef.current = null;
    savedStylesRef.current = null;
    originalParentRef.current = null;
    setMountEl(null);
    setActive("off");
  }, []);

  // If the video stops while the overlay is up (queue empties, user
  // hits stop, server-side advance), tear down so we don't leave a
  // floating panel pointing at a paused/idle player.
  useEffect(() => {
    if (!isYoutubePlaying && active !== "off") {
      teardown();
    }
  }, [isYoutubePlaying, active, teardown]);

  // Final cleanup if the component unmounts while the overlay is up —
  // leaving the wrapper stuck on-screen would strand the audio.
  useEffect(() => {
    return () => {
      if (active !== "off") teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enable = useCallback(() => {
    const mount = getYoutubeMount();
    if (!mount) return;

    originalParentRef.current = mount.parentNode;
    savedStylesRef.current = { cssText: mount.style.cssText };

    const desktop = isDesktopViewport();
    const w = desktop ? DESKTOP_W : MOBILE_W;
    const h = desktop ? DESKTOP_H : MOBILE_H;
    const left = Math.max(MARGIN, window.innerWidth - w - MARGIN);
    const top = Math.max(MARGIN, window.innerHeight - h - MARGIN);

    // position:fixed establishes the positioning context for the
    // controls overlay we portal in below (absolute children resolve
    // against the nearest positioned ancestor).
    mount.style.cssText =
      `position:fixed;left:${left}px;top:${top}px;width:${w}px;height:${h}px;` +
      `pointer-events:auto;opacity:1;z-index:9999;border-radius:12px;` +
      `overflow:hidden;box-shadow:0 12px 32px rgba(0,0,0,0.55);` +
      `background:#000;`;

    // Push the iframe down so it doesn't underlap the controls bar.
    // Iframes capture pointer events regardless of z-index, so the only
    // way to make the close X reliably clickable is to give it real
    // iframe-free pixels to live in.
    const iframe = mount.querySelector("iframe");
    if (iframe instanceof HTMLIFrameElement) {
      savedIframeRef.current = { el: iframe, cssText: iframe.style.cssText };
      iframe.style.cssText =
        `position:absolute;left:0;right:0;top:${CONTROLS_BAR_H}px;bottom:0;` +
        `width:100%;height:calc(100% - ${CONTROLS_BAR_H}px);border:0;`;
    }

    setMountEl(mount);
    setActive("overlay");
  }, []);

  const onToggle = useCallback(() => {
    if (active === "off") enable();
    else teardown();
  }, [active, enable, teardown]);

  // Drag-to-reposition. Pointer events cover mouse + touch + pen with
  // a single handler. We mutate mount.style.left/top directly so the
  // original cssText snapshot in savedStylesRef stays intact for the
  // teardown restore.
  const onDragStart = useCallback((e: React.PointerEvent) => {
    const mount = getYoutubeMount();
    if (!mount) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = mount.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    const width = rect.width;
    const height = rect.height;

    const onMove = (ev: PointerEvent) => {
      const nx = startLeft + (ev.clientX - startX);
      const ny = startTop + (ev.clientY - startY);
      const maxL = Math.max(0, window.innerWidth - width);
      const maxT = Math.max(0, window.innerHeight - height);
      mount.style.left = `${Math.max(0, Math.min(maxL, nx))}px`;
      mount.style.top = `${Math.max(0, Math.min(maxT, ny))}px`;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, []);

  const button = !isYoutubePlaying ? null : (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active !== "off"}
      aria-label={active !== "off" ? "close mini player" : "open mini player"}
      title={active !== "off" ? "Close mini player" : "Pop out video"}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition ${
        active !== "off"
          ? "bg-amber-400/15 text-amber-300 hover:bg-amber-400/25"
          : "text-neutral-400 hover:bg-neutral-800/60 hover:text-neutral-100"
      }`}
    >
      <PictureInPicture2 className="h-4 w-4" />
    </button>
  );

  const overlayControls =
    mountEl && active === "overlay"
      ? createPortal(
          <div
            className="absolute inset-x-0 top-0 z-10 flex h-7 items-center justify-between gap-1 bg-gradient-to-b from-black/75 via-black/40 to-transparent px-1.5"
            // The drag handle eats pointer events on the title bar; the
            // close button is a sibling so its clicks aren't swallowed.
          >
            <div
              onPointerDown={onDragStart}
              role="button"
              aria-label="drag mini player"
              className="flex h-full flex-1 cursor-grab items-center justify-center text-white/55 hover:text-white/80 active:cursor-grabbing"
            >
              <GripHorizontal className="h-3.5 w-3.5" />
            </div>
            <button
              type="button"
              onClick={teardown}
              aria-label="close mini player"
              className="flex h-5 w-5 items-center justify-center rounded text-white/80 transition hover:bg-white/15 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>,
          mountEl,
        )
      : null;

  return (
    <>
      {button}
      {overlayControls}
    </>
  );
}
