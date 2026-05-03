"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  MessageSquare,
  FolderKanban,
  StickyNote,
  Menu,
  X,
  Phone,
  Brain,
  Play,
  Settings,
  Activity,
  Users,
} from "lucide-react";
import type { User } from "@/lib/db";
import { useSparOptional } from "./SparContext";

const NAV_ITEMS = [
  { href: "/", label: "Chat", icon: MessageSquare },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/remarks", label: "Remarks", icon: StickyNote },
  { href: "/spar", label: "Spar", icon: Phone },
  // /brain hosts the project-entity graph plus tabs for the
  // assistant's accumulated user-memory and the live Sparring Partner
  // status. The standalone /memory route now redirects into the tab.
  { href: "/brain", label: "Brain", icon: Brain },
  { href: "/heartbeat", label: "Heartbeat", icon: Activity },
  // /activity is the cross-team feed (dispatches + remarks + file
  // changes + presence). Distinct from /heartbeat — heartbeat is one
  // user's signal, activity is the team's. Users icon emphasises the
  // people-focused framing.
  { href: "/activity", label: "Activity", icon: Users },
] as const;

export default function Topbar({ user }: { user: User }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const unreadTotal = useUnreadTotal();
  const spar = useSparOptional();
  // voiceChannel is the authoritative "who owns the audio leg" signal.
  // fillerNow.kind === "telegram" only surfaces when nothing higher-
  // priority (speaking/thinking/listening) is masking it, so it would
  // flicker mid-call — voiceChannel stays stable for the whole hold.
  const telegramActive = spar?.voiceChannel === "telegram";
  const dashCallActive = spar?.inCall === true && !telegramActive;

  // Close the drawer whenever the route changes — tapping a nav item in the
  // drawer navigates, then the drawer should disappear automatically.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // ESC closes the drawer (and locks body scroll while open so the page
  // behind doesn't jitter under the overlay).
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  return (
    <>
      <nav className="pt-safe pl-safe pr-safe sticky top-0 z-30 flex flex-shrink-0 items-center justify-between gap-2 border-b border-neutral-800/80 bg-neutral-950/75 px-3 py-1.5 text-sm backdrop-blur-md backdrop-saturate-150 sm:grid sm:grid-cols-3 sm:px-4 sm:py-2.5">
        <Link
          href="/"
          className="amaso-fx flex min-h-[40px] items-center font-semibold tracking-[0.02em] text-neutral-100 hover:text-white sm:min-h-0 sm:justify-self-start"
          aria-label="Amaso home"
        >
          AMASO
        </Link>

        {/* Desktop: inline nav in the centered grid column. Hidden on mobile
            — the hamburger drawer replaces it. */}
        <div className="hidden items-center justify-self-center gap-2 sm:flex">
          <a
            href="/login?demo=1"
            target="_blank"
            rel="noopener noreferrer"
            className="amaso-fx flex items-center gap-1.5 rounded-md px-3 py-1.5 text-neutral-400 hover:bg-neutral-900/80 hover:text-neutral-100"
            title="Open demo tour (new tab)"
          >
            <Play className="h-3.5 w-3.5" />
            <span>Demo</span>
          </a>
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            // Chat gets the global unread badge; Projects/Remarks don't.
            const badge = href === "/" ? unreadTotal : 0;
            // Spar is icon-only in the header — the phone glyph is
            // unambiguous and skipping the label keeps the bar tighter.
            const iconOnly = href === "/spar";
            return (
              <Link
                key={href}
                href={href}
                className={`amaso-fx relative flex items-center gap-1.5 rounded-md px-3 py-1.5 ${
                  active
                    ? "bg-neutral-800/90 text-neutral-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
                    : "text-neutral-400 hover:bg-neutral-900/80 hover:text-neutral-100"
                }`}
                aria-current={active ? "page" : undefined}
                aria-label={iconOnly ? label : undefined}
                title={iconOnly ? label : undefined}
              >
                <Icon
                  className={`h-3.5 w-3.5 transition-colors duration-200 ${
                    iconOnly
                      ? telegramActive
                        ? "text-sky-400"
                        : dashCallActive
                          ? "text-red-400"
                          : ""
                      : ""
                  }`}
                />
                {!iconOnly && <span>{label}</span>}
                <UnreadDot count={badge} />
              </Link>
            );
          })}
        </div>

        {/* Desktop: single Settings entry point on the right. Theme, push,
            install, admin, account, and sign out all live under /settings
            now so the header stays quiet. */}
        <div className="hidden min-w-0 items-center justify-self-end gap-3 text-neutral-400 sm:flex">
          <Link
            href="/settings"
            className={`amaso-fx flex items-center gap-1.5 rounded-md px-3 py-1.5 ${
              isActive(pathname, "/settings")
                ? "bg-neutral-800/90 text-neutral-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
                : "hover:bg-neutral-900/80 hover:text-neutral-100"
            }`}
            title="Settings"
            aria-label="Settings"
          >
            <Settings className="h-3.5 w-3.5" />
            <span>Settings</span>
          </Link>
        </div>

        {/* Mobile: hamburger only. Everything else moves into the drawer.
            The unread dot overlaps the top-right of the icon so you see
            activity even without opening the menu. */}
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          className="amaso-fx amaso-press relative flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-900/80 hover:text-neutral-100 sm:hidden"
          aria-label={
            menuOpen
              ? "Close menu"
              : unreadTotal > 0
                ? `Open menu — ${unreadTotal} unread`
                : "Open menu"
          }
          aria-expanded={menuOpen}
          aria-controls="amaso-mobile-menu"
        >
          {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          {!menuOpen && unreadTotal > 0 && (
            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-neutral-950" />
          )}
        </button>
      </nav>

      <MobileDrawer
        open={menuOpen}
        user={user}
        pathname={pathname}
        unreadTotal={unreadTotal}
        onClose={() => setMenuOpen(false)}
        telegramActive={telegramActive}
        dashCallActive={dashCallActive}
      />
    </>
  );
}

function MobileDrawer({
  open,
  user,
  pathname,
  unreadTotal,
  onClose,
  telegramActive,
  dashCallActive,
}: {
  open: boolean;
  user: User;
  pathname: string;
  unreadTotal: number;
  onClose: () => void;
  telegramActive: boolean;
  dashCallActive: boolean;
}) {
  return (
    <div
      id="amaso-mobile-menu"
      className={`fixed inset-0 z-40 sm:hidden ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      {/* Backdrop */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close menu"
        onClick={onClose}
        className={`absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-300 ease-out ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      {/* Panel — slides down from the top so it visually connects to the
          Topbar trigger that spawned it. */}
      <div
        className={`pt-safe pl-safe pr-safe pb-safe absolute inset-x-0 top-0 flex flex-col border-b border-neutral-800/80 bg-neutral-950/95 shadow-2xl backdrop-blur-md transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] ${
          open ? "translate-y-0" : "-translate-y-full"
        }`}
      >
        <div className="flex items-center justify-between border-b border-neutral-800/70 px-4 py-3">
          <span className="flex items-center gap-2">
            <span className="font-semibold tracking-[0.02em]">AMASO</span>
            <span className="rounded-full border border-neutral-700/80 px-2 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
              {user.role}
            </span>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="amaso-fx amaso-press flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex items-center gap-3 border-b border-neutral-800/70 px-4 py-3 text-xs text-neutral-400">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-neutral-700 to-neutral-800 text-sm font-medium text-neutral-100 ring-1 ring-white/5">
            {user.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-neutral-100">{user.name}</div>
            <div className="truncate text-[11px] text-neutral-500">
              {user.email}
            </div>
          </div>
        </div>

        <nav className="flex flex-col py-2">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            const badge = href === "/" ? unreadTotal : 0;
            return (
              <Link
                key={href}
                href={href}
                onClick={onClose}
                className={`amaso-fx relative flex min-h-[48px] items-center gap-3 px-4 text-base ${
                  active
                    ? "bg-neutral-800/80 text-white"
                    : "text-neutral-300 hover:bg-neutral-900/70 hover:text-neutral-100"
                }`}
                aria-current={active ? "page" : undefined}
              >
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-emerald-500"
                  />
                )}
                <Icon
                  className={`h-5 w-5 transition-colors duration-200 ${
                    href === "/spar"
                      ? telegramActive
                        ? "text-sky-400"
                        : dashCallActive
                          ? "text-red-400"
                          : ""
                      : ""
                  }`}
                />
                <span className="flex-1">{label}</span>
                <UnreadDot count={badge} />
              </Link>
            );
          })}
          <Link
            href="/settings"
            onClick={onClose}
            className={`amaso-fx relative flex min-h-[48px] items-center gap-3 px-4 text-base ${
              isActive(pathname, "/settings")
                ? "bg-neutral-800/80 text-white"
                : "text-neutral-300 hover:bg-neutral-900/70 hover:text-neutral-100"
            }`}
            aria-current={isActive(pathname, "/settings") ? "page" : undefined}
          >
            {isActive(pathname, "/settings") && (
              <span
                aria-hidden
                className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-emerald-500"
              />
            )}
            <Settings className="h-5 w-5" />
            <span>Settings</span>
          </Link>
        </nav>
      </div>
    </div>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Global unread chat count shown as a badge on the Chat nav item + the
 *  mobile hamburger + in the document title. Polls every 15s while the tab
 *  is visible, re-fetches on tab-visible and on the custom
 *  `amaso:unread-changed` event that ChatClient dispatches after
 *  optimistic local updates. */
function useUnreadTotal(): number {
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const res = await fetch("/api/chat/unread", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { total: number };
        if (!cancelled) setTotal(data.total ?? 0);
      } catch {
        /* ignore network blips */
      }
    }
    void refresh();
    const iv = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onChange = () => void refresh();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("amaso:unread-changed", onChange);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("amaso:unread-changed", onChange);
    };
  }, []);

  // Reflect the count in the tab title so you notice pings from other tabs.
  useEffect(() => {
    const base = "Amaso Dashboard";
    document.title = total > 0 ? `(${total > 99 ? "99+" : total}) ${base}` : base;
  }, [total]);

  return total;
}

function UnreadDot({ count, className = "" }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={`inline-flex min-w-[18px] items-center justify-center rounded-full bg-emerald-500 px-1.5 text-[10px] font-semibold text-black shadow-[0_0_0_1px_rgba(16,185,129,0.25),0_0_8px_rgba(16,185,129,0.4)] ${className}`}
      aria-label={`${count} unread`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
