import { requireUser } from "@/lib/guard";
import Topbar from "@/components/Topbar";
import SparFullView from "@/components/SparFullView";
import SparPageShell from "@/components/SparPageShell";

export const dynamic = "force-dynamic";

export default async function SparPage() {
  const user = await requireUser();
  return (
    <div className="flex h-[100dvh] flex-col">
      <Topbar user={user} />
      <SparPageShell>
        <SparFullView />
      </SparPageShell>
    </div>
  );
}
