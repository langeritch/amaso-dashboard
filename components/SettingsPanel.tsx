"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Activity, LogOut, Moon, MonitorDown, Shield, Sun } from "lucide-react";
import type { User } from "@/lib/db";
import PushToggle from "./PushToggle";

type Theme = "dark" | "light";
const THEME_KEY = "amaso:theme";

function readThemeCookie(): string | null {
  if (typeof document === "undefined") return null;
  for (const pair of document.cookie.split(/;\s*/)) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    if (pair.slice(0, idx) === THEME_KEY) return pair.slice(idx + 1);
  }
  return null;
}

function writeThemeCookie(value: Theme) {
  if (typeof document === "undefined") return;
  document.cookie = `${THEME_KEY}=${value}; path=/; max-age=31536000; samesite=lax`;
}

export default function SettingsPanel({ user }: { user: User }) {
  const router = useRouter();

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }, [router]);

  return (
    <div className="flex flex-col gap-6">
      <Section title="Account">
        <div className="flex items-center gap-3 px-4 py-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-neutral-800 text-base text-neutral-200">
            {user.name.slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-neutral-200">{user.name}</div>
            <div className="truncate text-xs text-neutral-500">{user.email}</div>
          </div>
          <span className="rounded-full border border-neutral-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
            {user.role}
          </span>
        </div>
        <button
          type="button"
          onClick={logout}
          className="flex min-h-[48px] w-full items-center gap-3 border-t border-neutral-800 px-4 text-base text-neutral-300 hover:bg-neutral-900"
        >
          <LogOut className="h-5 w-5" />
          <span>Sign out</span>
        </button>
      </Section>

      <Section title="Appearance">
        <ThemeRow />
      </Section>

      <Section title="Notifications">
        <PushToggle variant="row" />
      </Section>

      {user.role === "admin" && (
        <Section title="Admin">
          <Link
            href="/admin/install"
            className="flex min-h-[48px] items-center gap-3 px-4 text-base text-neutral-300 hover:bg-neutral-900"
          >
            <MonitorDown className="h-5 w-5" />
            <span>Install app</span>
          </Link>
          <Link
            href="/admin/users"
            className="flex min-h-[48px] items-center gap-3 border-t border-neutral-800 px-4 text-base text-neutral-300 hover:bg-neutral-900"
          >
            <Shield className="h-5 w-5" />
            <span>Users</span>
          </Link>
          {/* Super-user only — same email check the server-side gate
              uses. The page redirects non-super admins anyway, but
              hiding the link keeps the surface tidy. */}
          {user.email === "sander@vanderkraayswanjones.com" && (
            <Link
              href="/admin/activity"
              className="flex min-h-[48px] items-center gap-3 border-t border-neutral-800 px-4 text-base text-neutral-300 hover:bg-neutral-900"
            >
              <Activity className="h-5 w-5" />
              <span>Activity</span>
            </Link>
          )}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950/60">
      <h2 className="px-4 pb-2 pt-3 text-xs font-medium uppercase tracking-wider text-neutral-500">
        {title}
      </h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function ThemeRow() {
  const [theme, setTheme] = useState<Theme>("dark");
  useEffect(() => {
    const cookie = readThemeCookie();
    if (cookie === "light" || cookie === "dark") {
      setTheme(cookie);
      return;
    }
    try {
      const saved = localStorage.getItem(THEME_KEY);
      const initial: Theme = saved === "light" ? "light" : "dark";
      setTheme(initial);
      writeThemeCookie(initial);
    } catch {
      /* ignore */
    }
  }, []);
  function toggle() {
    setTheme((prev) => {
      const next: Theme = prev === "light" ? "dark" : "light";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        /* ignore */
      }
      writeThemeCookie(next);
      const el = document.documentElement;
      if (next === "light") el.classList.add("light");
      else el.classList.remove("light");
      return next;
    });
  }
  const isLight = theme === "light";
  return (
    <button
      type="button"
      onClick={toggle}
      className="flex min-h-[48px] w-full items-center gap-3 px-4 text-base text-neutral-300 hover:bg-neutral-900"
      aria-label="Toggle color theme"
    >
      {isLight ? <Moon className="h-5 w-5" /> : <Sun className="h-5 w-5" />}
      <span>{isLight ? "Switch to dark" : "Switch to light"}</span>
    </button>
  );
}
