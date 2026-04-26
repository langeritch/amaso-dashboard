import { redirect } from "next/navigation";
import { getCurrentUser, userCount } from "@/lib/auth";
import { isDemoUser } from "@/lib/demo/session";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Intentionally do NOT redirect `?demo=1` to `/demo` here — that round-trip
  // drops the query string and leaves the DemoOverlay with nothing to latch
  // onto when third-party cookies are blocked. Instead, the URL parameter is
  // itself an activation signal the overlay reads on mount (see DemoOverlay).
  // Visitors who want the cookie-based session can still hit `/demo` directly.
  if (userCount() === 0) redirect("/setup");
  const user = await getCurrentUser();
  const demoRequested = sp.demo === "1" || sp.demo === "true";
  // Demo users linger on the login screen so the cursor-tour can type in
  // the fake credentials before transitioning into the dashboard. Real
  // visitors who arrive here with `?demo=1` also stay — bouncing them to /
  // would strip the query param and the DemoOverlay would never fire.
  if (user && !isDemoUser(user) && !demoRequested) redirect("/");
  return (
    <main className="flex min-h-[100dvh] items-center justify-center px-4 py-6 sm:px-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold">Amaso Dashboard</h1>
        <p className="mb-6 text-sm text-neutral-400">Sign in to continue.</p>
        <LoginForm />
      </div>
    </main>
  );
}
