import { requireUser } from "@/lib/guard";
import Topbar from "@/components/Topbar";
import SettingsPanel from "@/components/SettingsPanel";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();
  return (
    <div className="min-h-[100dvh]">
      <Topbar user={user} />
      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-10">
        <header className="mb-5 flex flex-col gap-1 sm:mb-6">
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="text-sm text-neutral-500">
            Appearance, notifications, and your account — everything that used
            to live in the header.
          </p>
        </header>
        <SettingsPanel user={user} />
      </main>
    </div>
  );
}
