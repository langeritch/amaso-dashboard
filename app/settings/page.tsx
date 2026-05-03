import { requireUser } from "@/lib/guard";
import Topbar from "@/components/Topbar";
import SettingsPanel from "@/components/SettingsPanel";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();
  return (
    <div className="min-h-[100dvh]">
      <Topbar user={user} />
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-12">
        <header className="mb-6 flex flex-col gap-1.5 sm:mb-8">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Settings</h1>
          <p className="text-sm leading-relaxed text-neutral-500">
            Appearance, notifications, and your account — everything that used
            to live in the header.
          </p>
        </header>
        <SettingsPanel user={user} />
      </main>
    </div>
  );
}
