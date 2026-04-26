"use client";

// PLACEHOLDER STUB.
//
// The real TelegramCallView was removed / not yet reintroduced, but
// `app/telegram/page.tsx` still imports it. Next dev-mode tolerates the
// dangling import (lazy module resolution per request) but `next build`
// hard-fails at compile time, which was blocking the switch from the
// crash-prone dev server to a stable production build.
//
// This stub keeps the route buildable. Replace the body with the real
// call UI when it's ready — the contract (`{ isAdmin: boolean }`) is
// preserved so `app/telegram/page.tsx` doesn't need to change.

export default function TelegramCallView({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-sm opacity-60">
      <div className="text-center">
        <div className="mb-2 font-medium">Telegram call view — under construction</div>
        <div className="text-xs">
          (stub component; admin={String(isAdmin)})
        </div>
      </div>
    </div>
  );
}
