import { requireUser } from "@/lib/guard";
import Topbar from "@/components/Topbar";
import ChatClient from "@/components/ChatClient";
import { listChannelsForUser } from "@/lib/chat";
import { visibleProjects } from "@/lib/access";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const user = await requireUser();
  const channels = listChannelsForUser(user);
  const projects = visibleProjects(user).map((p) => ({
    id: p.id,
    name: p.name,
  }));
  const initialChannelId =
    channels.find((c) => c.kind === "general")?.id ?? channels[0]?.id ?? null;

  return (
    <div className="min-h-[100dvh]">
      <Topbar user={user} />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <header className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Team
          </h1>
          <p className="mt-2 text-sm text-neutral-400">
            Channels, project rooms, and direct messages.
          </p>
        </header>

        <ChatClient
          currentUser={{ id: user.id, name: user.name, role: user.role }}
          channels={channels}
          projects={projects}
          initialChannelId={initialChannelId}
        />
      </main>
    </div>
  );
}
