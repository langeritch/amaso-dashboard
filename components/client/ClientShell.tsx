"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback } from "react";
import { LogOut } from "lucide-react";
import type { User } from "@/lib/db";

export default function ClientShell({
  user,
  children,
}: {
  user: User;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }, [router]);

  const onProjectDetail = pathname.startsWith("/client/projects/");

  return (
    <div className="flex min-h-[100dvh] flex-col bg-neutral-950">
      <header className="pt-safe pl-safe pr-safe sticky top-0 z-30 border-b border-neutral-800/80 bg-neutral-950/75 backdrop-blur-md backdrop-saturate-150">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <Link
            href="/client"
            className="amaso-fx flex items-center gap-2 font-semibold tracking-[0.02em] text-neutral-100 hover:text-white"
          >
            <span className="inline-block h-2 w-2 rounded-full bg-orange-500 shadow-[0_0_6px_rgba(255,107,61,0.6)]" />
            <span>AMASO</span>
            <span className="text-xs font-normal text-neutral-500">
              · Client Portal
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <div className="text-sm font-medium text-neutral-100">
                {user.name}
              </div>
              <div className="text-[11px] text-neutral-500">{user.email}</div>
            </div>
            <button
              type="button"
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
              className="amaso-fx amaso-press flex h-10 w-10 items-center justify-center rounded-full border border-neutral-800/80 bg-neutral-900/60 text-neutral-400 hover:border-neutral-700 hover:text-neutral-100"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
        {onProjectDetail && (
          <div className="mx-auto max-w-5xl px-4 pb-2 sm:px-6">
            <Link
              href="/client"
              className="amaso-fx text-xs text-neutral-500 hover:text-neutral-200"
            >
              ← All projects
            </Link>
          </div>
        )}
      </header>
      <main className="flex-1">{children}</main>
      <footer className="pb-safe pl-safe pr-safe border-t border-neutral-800/60 bg-neutral-950/40">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4 text-[11px] text-neutral-600 sm:px-6">
          <span>© Amaso — your project workspace.</span>
          <span className="font-mono">{user.role}</span>
        </div>
      </footer>
    </div>
  );
}
