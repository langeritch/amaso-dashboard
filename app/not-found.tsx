import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center px-4 py-6 sm:px-6">
      <div className="w-full max-w-sm text-center">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-neutral-500">
          404
        </p>
        <h1 className="mb-2 text-2xl font-semibold">Page not found</h1>
        <p className="mb-6 text-sm text-neutral-400">
          The page you were looking for doesn&apos;t exist or has moved.
        </p>
        <Link
          href="/"
          className="inline-flex min-h-[44px] items-center justify-center rounded bg-white px-4 py-2 text-sm font-medium text-black transition hover:bg-neutral-200"
        >
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}
