import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center px-4 py-6 sm:px-6">
      <div className="amaso-fade-in-slow w-full max-w-sm text-center">
        <div className="mb-7 flex items-center justify-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-orange-500 shadow-[0_0_8px_rgba(255,107,61,0.6)]"
          />
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-neutral-500">
            Amaso
          </span>
        </div>
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-500/80">
          404
        </p>
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">
          Page not found
        </h1>
        <p className="mb-7 text-sm leading-relaxed text-neutral-400">
          The page you were looking for doesn&apos;t exist or has moved.
        </p>
        <Link
          href="/spar"
          className="amaso-fx amaso-press inline-flex min-h-[44px] items-center justify-center rounded-md bg-orange-500 px-5 py-2 text-sm font-semibold text-neutral-950 shadow-[0_2px_12px_rgba(255,107,61,0.3)] hover:bg-orange-400 hover:shadow-[0_2px_16px_rgba(255,107,61,0.4)]"
        >
          Back to home
        </Link>
      </div>
    </main>
  );
}
