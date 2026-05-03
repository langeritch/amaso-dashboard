import { redirect } from "next/navigation";
import { userCount } from "@/lib/auth";
import SetupForm from "./SetupForm";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  if (userCount() > 0) redirect("/login");
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
          Set up your dashboard
        </h1>
        <p className="mb-6 text-sm leading-relaxed text-neutral-400">
          Create the first admin account. You can add team members and clients
          from the admin panel afterwards.
        </p>
        <SetupForm />
      </div>
    </main>
  );
}
