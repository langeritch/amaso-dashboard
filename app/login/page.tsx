import { redirect } from "next/navigation";
import { getCurrentUser, userCount } from "@/lib/auth";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (userCount() === 0) redirect("/setup");
  const user = await getCurrentUser();
  if (user) {
    // Clients land on the portal; admin/team land on /spar — the
    // sparring command center is the post-login home for the
    // internal dashboard now.
    redirect(user.role === "client" ? "/client" : "/spar");
  }
  return (
    <main className="flex min-h-[100dvh] items-center justify-center px-4 py-6 sm:px-6">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-orange-500 shadow-[0_0_8px_rgba(255,107,61,0.6)]" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-neutral-500">
            Amaso
          </span>
        </div>
        <h1 className="mb-1.5 text-2xl font-semibold tracking-tight">
          Welcome back
        </h1>
        <p className="mb-6 text-sm leading-relaxed text-neutral-400">
          Sign in to continue.
        </p>
        <LoginForm />
      </div>
    </main>
  );
}
