import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center px-4 py-6 sm:px-6">
      <div className="w-full max-w-sm text-center">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-orange-500/80">
          404
        </p>
        <h1 className="mb-2 text-2xl font-semibold tracking-tight">
          Page not found
        </h1>
        <p className="mb-6 text-sm leading-relaxed text-neutral-400">
          The page you were looking for doesn&apos;t exist or has moved.
        </p>
        <Link
          href="/"
          className="amaso-fx amaso-press inline-flex min-h-[44px] items-center justify-center rounded-md bg-orange-500 px-5 py-2 text-sm font-semibold text-neutral-950 shadow-[0_2px_12px_rgba(255,107,61,0.3)] hover:bg-orange-400 hover:shadow-[0_2px_16px_rgba(255,107,61,0.4)]"
        >
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
