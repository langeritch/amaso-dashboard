"use client";

import { useCallback, useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

type Theme = "dark" | "light";

const STORAGE_KEY = "amaso:theme";
// Same key as the server reads in app/layout.tsx (THEME_COOKIE).
// Duplicated as a string here because importing a server-only module
// from a client component pulls in `next/headers`.
const COOKIE_KEY = "amaso:theme";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const pair of document.cookie.split(/;\s*/)) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    if (pair.slice(0, idx) === name) return pair.slice(idx + 1);
  }
  return null;
}

function writeCookie(name: string, value: string) {
  if (typeof document === "undefined") return;
  // 1 year, path=/, Lax. No httpOnly because the client needs to keep
  // it in sync; the cookie carries no secret.
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}

function readStoredTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  const cookie = readCookie(COOKIE_KEY);
  if (cookie === "light" || cookie === "dark") return cookie;
  const ls = window.localStorage.getItem(STORAGE_KEY);
  return ls === "light" ? "light" : "dark";
}

function applyTheme(theme: Theme) {
  const el = document.documentElement;
  if (theme === "light") el.classList.add("light");
  else el.classList.remove("light");
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("dark");

  // Hydrate from cookie/localStorage so the icon matches the className
  // the server already applied to <html>. If only localStorage is set
  // (legacy users), backfill the cookie so future SSR matches.
  useEffect(() => {
    const current = readStoredTheme();
    setTheme(current);
    if (!readCookie(COOKIE_KEY)) writeCookie(COOKIE_KEY, current);
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "light" ? "dark" : "light";
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* private mode / quota — fine to drop */
      }
      writeCookie(COOKIE_KEY, next);
      applyTheme(next);
      return next;
    });
  }, []);

  const isLight = theme === "light";
  return (
    <button
      type="button"
      onClick={toggle}
      className="flex min-h-[40px] min-w-[40px] flex-shrink-0 items-center justify-center gap-1.5 rounded-md text-neutral-400 transition hover:bg-neutral-900 hover:text-neutral-200 sm:min-h-0 sm:min-w-0 sm:px-2 sm:py-1"
      title={isLight ? "Switch to dark mode" : "Switch to light mode"}
      aria-label="Toggle color theme"
    >
      {isLight ? <Moon className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> : <Sun className="h-4 w-4 sm:h-3.5 sm:w-3.5" />}
    </button>
  );
}
