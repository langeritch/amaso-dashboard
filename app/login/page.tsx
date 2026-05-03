import { redirect } from "next/navigation";
import { getCurrentUser, userCount } from "@/lib/auth";
import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (userCount() === 0) redirect("/setup");
  const user = await getCurrentUser();
  if (user) {
    // Clients land on the portal; everyone else on the dashboard home.
    redirect(user.role === "client" ? "/client" : "/");
  }
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
