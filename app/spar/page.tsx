import { requireUser } from "@/lib/guard";
import Topbar from "@/components/Topbar";
import SparFullView from "@/components/SparFullView";
import SparPageShell from "@/components/SparPageShell";
import SparTodayPanel from "@/components/SparTodayPanel";

export const dynamic = "force-dynamic";

export default async function SparPage() {
  // /spar is the home page for admin/team — login lands here directly
  // (lib/guard + app/login redirect). The Today-at-a-glance strip sits
  // above the chat so active terminals, open loops from the heartbeat,
  // and unresolved remarks are visible without scrolling. SparPageShell
  // owns the left sidebar (chats + workers); SparFullView is the chat
  // itself with its fixed-bottom composer.
  const user = await requireUser();
  return (
    <div className="flex h-[100dvh] flex-col">
      <Topbar user={user} />
      <SparPageShell>
        <SparTodayPanel />
        <SparFullView />
      </SparPageShell>
    </div>
  );
}
