import { redirect } from "next/navigation";
import { userCount } from "@/lib/auth";
import SetupForm from "./SetupForm";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  if (userCount() > 0) redirect("/login");
  return (
    <main className="flex min-h-[100dvh] items-center justify-center px-4 py-6 sm:px-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold">Welcome</h1>
        <p className="mb-6 text-sm text-neutral-400">
          Create the first admin account. You can add team members and clients
          from the admin panel afterwards.
        </p>
        <SetupForm />
      </div>
    </main>
  );
}
