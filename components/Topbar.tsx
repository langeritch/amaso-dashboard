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
  Settings,
  Activity,
  Users,
} from "lucide-react";
import type { User } from "@/lib/db";
import { useSparOptional } from "./SparContext";

// Top-level nav: 2026-05 second pass — /spar is now home (the AMASO
// wordmark lands you there, login redirects there, sparring chat is
// the post-login command center). The header keeps a single
// "Projects" link + the gear; everything else folds into the mobile
// drawer's "More" group and the Settings page's "Workspace" section.
const PRIMARY_NAV = [
  { href: "/projects", label: "Projects", icon: FolderKanban },
] as const;

// Secondary destinations exposed via the mobile drawer. Desktop users
// reach these from the Settings page or by typing the URL — the goal
// is a quiet header, not a hidden app. Spar is omitted: the AMASO
// wordmark already lives there, so a separate row would be redundant.
const SECONDARY_NAV = [
  { href: "/", label: "Chat", icon: MessageSquare },
  { href: "/remarks", label: "Remarks", icon: StickyNote },
  { href: "/brain", label: "Brain", icon: Brain },
  { href: "/heartbeat", label: "Heartbeat", icon: Activity },
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
          href="/spar"
          className="amaso-fx group relative flex min-h-[40px] items-center gap-2 font-semibold tracking-[0.02em] text-neutral-100 hover:text-white sm:min-h-0 sm:justify-self-start"
          aria-label={
            unreadTotal > 0
              ? `Amaso home — ${unreadTotal} unread`
              : "Amaso home"
          }
          title={
            unreadTotal > 0
              ? `Spar / home — ${unreadTotal} chat unread`
              : "Spar / home"
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

        {/* Desktop: two primary nav items only. Everything else moves
            into the Settings page (Workspace section) and the mobile
            drawer's "More" group. The header used to host seven
            destinations — now Spar + Projects are the spine. */}
        <div className="hidden items-center justify-self-center gap-1 sm:flex">
          {PRIMARY_NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
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
              >
                <Icon className="h-3.5 w-3.5 transition-colors duration-200" />
                <span>{label}</span>
                {active && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-x-3 -bottom-[7px] h-[2px] rounded-full bg-orange-500 shadow-[0_0_6px_rgba(255,107,61,0.55)]"
                  />
                )}
              </Link>
            );
          })}
          {/* Voice-call indicator next to the Projects link — inherits
              the spar status colours that used to live on the Spar nav
              item before the wordmark took over as the Spar affordance.
              Hidden when no call is active so the bar stays calm. */}
          {(telegramActive || dashCallActive) && (
            <Link
              href="/spar"
              className="amaso-fx ml-1 inline-flex h-7 items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-900/70 px-2 text-[11px] hover:border-neutral-700"
              aria-label={
                telegramActive ? "telegram call active" : "spar call active"
              }
              title={
                telegramActive ? "Telegram call active" : "Spar call active"
              }
            >
              <Phone
                className={`h-3 w-3 ${
                  telegramActive ? "text-sky-400" : "text-red-400"
                }`}
              />
              <span className="font-mono text-[10px] text-neutral-300">
                {telegramActive ? "telegram" : "live"}
              </span>
            </Link>
          )}
        </div>

        {/* Desktop: single Settings entry point on the right. Theme, push,
            install, admin, account, and sign out all live under /settings
            now so the header stays quiet. */}
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
            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-orange-500 ring-2 ring-neutral-950" />
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
          {/* Primary destinations on mobile. Desktop dropped Spar from
              the bar (the AMASO wordmark is the home affordance), but
              the drawer keeps it prominent so phone users have an
              obvious tap target. */}
          <DrawerLink
            href="/spar"
            label="Spar"
            icon={Phone}
            active={isActive(pathname, "/spar")}
            onClose={onClose}
            iconClass={
              telegramActive
                ? "text-sky-400"
                : dashCallActive
                  ? "text-red-400"
                  : ""
            }
          />
          {PRIMARY_NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(pathname, href);
            return (
              <DrawerLink
                key={href}
                href={href}
                label={label}
                icon={Icon}
                active={active}
                onClose={onClose}
              />
            );
          })}
          <DrawerLink
            href="/settings"
            label="Settings"
            icon={Settings}
            active={isActive(pathname, "/settings")}
            onClose={onClose}
          />

          {/* Secondary destinations — Chat, Remarks, Brain, Heartbeat,
              Activity. Visually de-emphasised so the drawer reads as
              "Spar / Projects / Settings + a more menu". */}
          <div className="mt-3 border-t border-neutral-800/70 pt-2">
            <div className="px-4 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-500">
              More
            </div>
            {SECONDARY_NAV
              // /activity is admin-gated server-side (requireAdmin
              // bounces non-admins back to /), so showing the row to
              // team users would just dead-end them. Filter here.
              .filter(
                ({ href }) => href !== "/activity" || user.role === "admin",
              )
              .map(({ href, label, icon: Icon }) => {
                const active = isActive(pathname, href);
                const badge = href === "/" ? unreadTotal : 0;
                return (
                  <DrawerLink
                    key={href}
                    href={href}
                    label={label}
                    icon={Icon}
                    active={active}
                    onClose={onClose}
                    badge={badge}
                    compact
                  />
                );
              })}
          </div>
        </nav>
      </div>
    </div>
  );
}

function DrawerLink({
  href,
  label,
  icon: Icon,
  active,
  onClose,
  badge = 0,
  iconClass = "",
  compact = false,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  onClose: () => void;
  badge?: number;
  iconClass?: string;
  compact?: boolean;
}) {
  // Two visual densities so the drawer reads as a primary group + a
  // quieter "More" group. Compact rows are still 44px tall to stay
  // touch-friendly; only padding + icon size shrink.
  const sizing = compact
    ? "min-h-[44px] gap-3 px-4 text-sm"
    : "min-h-[48px] gap-3 px-4 text-base";
  const iconSize = compact ? "h-4 w-4" : "h-5 w-5";
  return (
    <Link
      href={href}
      onClick={onClose}
      className={`amaso-fx relative flex items-center ${sizing} ${
        active
          ? "bg-neutral-800/80 text-white"
          : compact
            ? "text-neutral-400 hover:bg-neutral-900/70 hover:text-neutral-100"
            : "text-neutral-300 hover:bg-neutral-900/70 hover:text-neutral-100"
      }`}
      aria-current={active ? "page" : undefined}
    >
      {active && (
        <span
          aria-hidden
          className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-orange-500"
        />
      )}
      <Icon className={`${iconSize} transition-colors duration-200 ${iconClass}`} />
      <span className="flex-1">{label}</span>
      <UnreadDot count={badge} />
    </Link>
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
      className={`inline-flex min-w-[18px] items-center justify-center rounded-full bg-orange-500 px-1.5 text-[10px] font-semibold text-black shadow-[0_0_0_1px_rgba(255, 107, 61,0.25),0_0_8px_rgba(255, 107, 61,0.4)] ${className}`}
      aria-label={`${count} unread`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}
