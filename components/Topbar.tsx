"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Sparkles,
  FolderKanban,
  Menu,
  X,
  Phone,
  Settings,
  Users,
} from "lucide-react";
import type { User } from "@/lib/db";
import { useSparOptional } from "./SparContext";

// Top-level nav: 2026-05 third pass — three destinations only. Sparring
// Partner is the chat/voice command center, Projects is the work
// overview, Team consolidates the team-wide views (activity, brain,
// remarks, heartbeat). Everything else lives in /settings or under
// /team. The AMASO wordmark stays as a branded home affordance.
const PRIMARY_NAV = [
  { href: "/spar", label: "Sparring Partner", icon: Sparkles },
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/team", label: "Team", icon: Users },
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
        <div className="flex items-center gap-2 sm:justify-self-start">
          <Link
            href="/"
            className="amaso-fx group relative flex min-h-[40px] items-center gap-2 font-semibold tracking-[0.02em] text-neutral-100 hover:text-white sm:min-h-0"
            aria-label={
              unreadTotal > 0
                ? `Amaso home — ${unreadTotal} unread`
                : "Amaso home"
            }
            title={
              unreadTotal > 0
                ? `Amaso home — ${unreadTotal} chat unread`
                : "Amaso home"
            }
          >
            <span>AMASO</span>
            {unreadTotal > 0 && (
              <span
                aria-hidden
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-orange-500 shadow-[0_0_6px_rgba(255,107,61,0.7)]"
              />
            )}
          </Link>
          {/* Voice-call indicator. Lives next to the wordmark — desktop
              and mobile both — so the operator notices a live call no
              matter which page they're on. Single warm tone (amber)
              for both Telegram and dashboard calls; the channel
              difference is in the label, not the color, so the eye
              reads "a call is up" without parsing two different reds /
              blues. The desktop active-page underline already owns
              orange-500, so amber gives the indicator its own lane. */}
          {(telegramActive || dashCallActive) && (
            <Link
              href="/spar"
              className="amaso-fx inline-flex h-6 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] text-amber-200 hover:border-amber-500/60 sm:h-7 sm:gap-1.5 sm:px-2 sm:text-[11px]"
              aria-label={
                telegramActive ? "telegram call active" : "spar call active"
              }
              title={
                telegramActive ? "Telegram call active" : "Spar call active"
              }
            >
              <Phone className="h-3 w-3 text-amber-400" />
              <span className="font-mono text-[10px] text-neutral-300">
                {telegramActive ? "telegram" : "live"}
              </span>
            </Link>
          )}
        </div>

        {/* Desktop: three primary nav icons — Sparring Partner / Projects
            / Team. Labels live in title/aria so the bar stays minimal;
            Settings sits on the right edge. */}
        <div className="hidden items-center justify-self-center gap-1 sm:flex">
          {PRIMARY_NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            const isSpar = href === "/spar";
            const sparIconClass =
              isSpar && (telegramActive || dashCallActive)
                ? "text-amber-400"
                : "";
            return (
              <Link
                key={href}
                href={href}
                title={label}
                aria-label={label}
                className={`amaso-fx relative flex h-9 w-9 items-center justify-center rounded-md ${
                  active
                    ? "bg-neutral-800/90 text-neutral-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
                    : "text-neutral-400 hover:bg-neutral-900/80 hover:text-neutral-100"
                }`}
                aria-current={active ? "page" : undefined}
              >
                <Icon
                  className={`h-4 w-4 transition-colors duration-200 ${sparIconClass}`}
                />
                {active && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-2 -bottom-[7px] h-[2px] rounded-full bg-orange-500 shadow-[0_0_6px_rgba(255,107,61,0.55)]"
                  />
                )}
              </Link>
            );
          })}
        </div>

        {/* Desktop: gear icon on the far right. All workspace controls
            (theme, push, install, admin, account, sign out) live under
            /settings. */}
        <div className="hidden min-w-0 items-center justify-self-end gap-3 text-neutral-400 sm:flex">
          <Link
            href="/settings"
            className={`amaso-fx relative flex h-9 w-9 items-center justify-center rounded-md ${
              isActive(pathname, "/settings")
                ? "bg-neutral-800/90 text-neutral-50 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
                : "hover:bg-neutral-900/80 hover:text-neutral-100"
            }`}
            title="Settings"
            aria-label="Settings"
          >
            <Settings className="h-4 w-4" />
            {isActive(pathname, "/settings") && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-x-2 -bottom-[7px] h-[2px] rounded-full bg-orange-500 shadow-[0_0_6px_rgba(255,107,61,0.55)]"
              />
            )}
          </Link>
        </div>

        {/* Mobile: hamburger only. The drawer mirrors the desktop
            hierarchy — same three primary items + the gear. */}
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
            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-orange-500 ring-2 ring-neutral-950" />
          )}
        </button>
      </nav>

      <MobileDrawer
        open={menuOpen}
        user={user}
        pathname={pathname}
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
  onClose,
  telegramActive,
  dashCallActive,
}: {
  open: boolean;
  user: User;
  pathname: string;
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

        {/* Same three primary destinations as the desktop bar, rendered
            as an icon row to mirror the icon-only header. The trailing
            gear keeps Settings reachable from the drawer. */}
        <nav className="flex items-center justify-around gap-2 px-4 py-4">
          {PRIMARY_NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            const iconClass =
              href === "/spar" && (telegramActive || dashCallActive)
                ? "text-amber-400"
                : "";
            return (
              <DrawerIcon
                key={href}
                href={href}
                label={label}
                icon={Icon}
                active={active}
                onClose={onClose}
                iconClass={iconClass}
              />
            );
          })}
          <DrawerIcon
            href="/settings"
            label="Settings"
            icon={Settings}
            active={isActive(pathname, "/settings")}
            onClose={onClose}
          />
        </nav>
      </div>
    </div>
  );
}

function DrawerIcon({
  href,
  label,
  icon: Icon,
  active,
  onClose,
  iconClass = "",
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  onClose: () => void;
  iconClass?: string;
}) {
  return (
    <Link
      href={href}
      onClick={onClose}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={`amaso-fx amaso-press relative flex h-12 w-12 flex-1 max-w-[64px] items-center justify-center rounded-md ${
        active
          ? "bg-neutral-800/90 text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.04)]"
          : "text-neutral-400 hover:bg-neutral-900/70 hover:text-neutral-100"
      }`}
    >
      <Icon className={`h-5 w-5 transition-colors duration-200 ${iconClass}`} />
      {active && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-3 -bottom-[6px] h-[2px] rounded-full bg-orange-500 shadow-[0_0_6px_rgba(255,107,61,0.55)]"
        />
      )}
    </Link>
  );
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Global unread chat count shown as a badge on the AMASO logo + the
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
