"use client";

import { useState } from "react";
import { MessageSquare, Activity, Users } from "lucide-react";
import ChatClient from "./ChatClient";
import UnifiedActivityFeed from "./UnifiedActivityFeed";
import PeopleActivity, { type ProjectRef } from "./PeopleActivity";
import type { ChannelView } from "@/lib/chat";

type Role = "admin" | "team" | "client";

interface TeamHubProps {
  currentUser: { id: number; name: string; role: Role };
  channels: ChannelView[];
  projects: ProjectRef[];
  initialChannelId: number | null;
}

const tabs = [
  { id: "chat", label: "Chat", Icon: MessageSquare },
  { id: "activity", label: "Activity", Icon: Activity },
  { id: "people", label: "People", Icon: Users },
] as const;

type TabId = (typeof tabs)[number]["id"];

export default function TeamHub({
  currentUser,
  channels,
  projects,
  initialChannelId,
}: TeamHubProps) {
  const [activeTab, setActiveTab] = useState<TabId>("chat");

  return (
    <div className="flex flex-col gap-4">
      <nav className="flex gap-1 rounded-lg border border-neutral-800/80 bg-neutral-950/60 p-1">
        {tabs.map(({ id, label, Icon }) => {
          const active = id === activeTab;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`amaso-fx flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-neutral-800/80 text-orange-300 shadow-sm"
                  : "text-neutral-500 hover:bg-neutral-900/60 hover:text-neutral-200"
              }`}
              aria-pressed={active}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          );
        })}
      </nav>

      <div>
        {activeTab === "chat" && (
          <ChatClient
            currentUser={currentUser}
            channels={channels}
            projects={projects}
            initialChannelId={initialChannelId}
          />
        )}
        {activeTab === "activity" && <UnifiedActivityFeed />}
        {activeTab === "people" && <PeopleActivity projects={projects} />}
      </div>
    </div>
  );
}
