"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface SparFooterCtx {
  /**
   * True when some component in the tree wants the SparMiniPlayer to
   * render as the unified full-width footer strip. While false, the
   * mini-player keeps its original bottom-left pill layout.
   */
  footerActive: boolean;
  setFooterActive: (active: boolean) => void;
  /**
   * The DOM node SparMiniPlayer attaches on its right side while in
   * footer mode. Consumers `createPortal` their own controls into it.
   */
  slotEl: HTMLDivElement | null;
  setSlotEl: (el: HTMLDivElement | null) => void;
  /**
   * Live height of the rendered footer strip in CSS pixels. Published
   * by SparMiniPlayer via ResizeObserver so consumers can size their
   * own bottom paddings dynamically — the footer's height grows with
   * portaled controls + safe-area insets and a hardcoded reserve was
   * letting the bar overlap chat inputs on mobile.
   */
  footerHeight: number;
  setFooterHeight: (h: number) => void;
}

const Ctx = createContext<SparFooterCtx | null>(null);

export function SparFooterProvider({ children }: { children: ReactNode }) {
  const [footerActive, setFooterActive] = useState(false);
  const [slotEl, setSlotEl] = useState<HTMLDivElement | null>(null);
  const [footerHeight, setFooterHeight] = useState(0);
  const value = useMemo(
    () => ({
      footerActive,
      setFooterActive,
      slotEl,
      setSlotEl,
      footerHeight,
      setFooterHeight,
    }),
    [footerActive, slotEl, footerHeight],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSparFooter() {
  return useContext(Ctx);
}

/**
 * Claim the unified-footer layout for the lifetime of the calling
 * component. SparMiniPlayer flips to its full-width footer rendering
 * while any caller is mounted, then snaps back to the pill on unmount.
 */
export function useClaimSparFooter() {
  const setFooterActive = useContext(Ctx)?.setFooterActive;
  useEffect(() => {
    if (!setFooterActive) return;
    setFooterActive(true);
    return () => setFooterActive(false);
  }, [setFooterActive]);
}
