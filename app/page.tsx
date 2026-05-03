import { requireUser } from "@/lib/guard";
import { listChannelsForUser } from "@/lib/chat";
import { visibleProjects } from "@/lib/access";
import Topbar from "@/components/Topbar";
import ChatClient from "@/components/ChatClient";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  // requireUser handles client → /client redirect.
  const user = await requireUser();
  const channels = listChannelsForUser(user);
  const projects = visibleProjects(user).map((p) => ({ id: p.id, name: p.name }));
  const initialChannelId =
    channels.find((c) => c.kind === "general")?.id ?? channels[0]?.id ?? null;

  return (
    // h-[100dvh] (not min-h-screen) so the layout actually shrinks when the
    // iOS keyboard opens — otherwise the page stays 100vh tall, the body
    // starts scrolling, and the Topbar + channel header drift off the top
    // while the input disappears behind the keyboard.
    <div className="flex h-[100dvh] flex-col">
      <Topbar user={user} />
      <ChatClient
        currentUser={{ id: user.id, name: user.name, role: user.role }}
        channels={channels}
        projects={projects}
        initialChannelId={initialChannelId}
      />
    </div>
  );
}
