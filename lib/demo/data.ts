// Fake content for the demo-mode walkthrough. Everything here is
// render-only — no IDs or timestamps are wired to real storage. Edit the
// names, messages, and file trees freely; nothing else depends on them.

import type { ProjectConfig } from "../config";
import type { ChannelView, MessageView } from "../chat";

export interface DemoProject {
  id: string;
  name: string;
  client: string;
  status: "active" | "review" | "paused";
  accent: string; // tailwind text-* class used as a tiny color chip
  preview: string; // a line of flavor text shown on the project card
  lastActivity: string; // display-only "2h ago" style label
}

export interface DemoMessage {
  id: string;
  author: string;
  role: "team" | "client";
  body: string;
  time: string; // "10:42" display label
}

export interface DemoChannel {
  id: string;
  projectId: string;
  name: string;
  unread: number;
  messages: DemoMessage[];
}

export interface DemoFileNode {
  name: string;
  kind: "file" | "folder";
  children?: DemoFileNode[];
}

export const DEMO_USER = {
  id: 99001,
  name: "Santi van der Kraay",
  email: "santi@amaso.nl",
  role: "admin" as const,
};

export const DEMO_PROJECTS: DemoProject[] = [
  {
    id: "horizon-architects",
    name: "Horizon Architects",
    client: "Horizon Architects B.V.",
    status: "active",
    accent: "text-emerald-400",
    preview: "Portfolio redesign — case studies module shipping this week.",
    lastActivity: "12m ago",
  },
  {
    id: "bloom-interiors",
    name: "Bloom Interiors",
    client: "Bloom Interiors Studio",
    status: "review",
    accent: "text-fuchsia-400",
    preview: "Booking flow in client review — awaiting copy sign-off.",
    lastActivity: "1h ago",
  },
  {
    id: "nova-studios",
    name: "Nova Studios",
    client: "Nova Studios Amsterdam",
    status: "active",
    accent: "text-sky-400",
    preview: "Headless CMS migration — 70% of pages ported.",
    lastActivity: "3h ago",
  },
  {
    id: "atlas-coffee",
    name: "Atlas Coffee Roasters",
    client: "Atlas Coffee Roasters",
    status: "active",
    accent: "text-amber-400",
    preview: "Subscription checkout + Shopify bridge live in staging.",
    lastActivity: "yesterday",
  },
  {
    id: "meridian-clinic",
    name: "Meridian Clinic",
    client: "Meridian Health Clinic",
    status: "paused",
    accent: "text-rose-400",
    preview: "Patient portal — paused pending compliance sign-off.",
    lastActivity: "3d ago",
  },
];

export const DEMO_CHANNELS: DemoChannel[] = [
  {
    id: "ch-horizon-general",
    projectId: "horizon-architects",
    name: "horizon-architects",
    unread: 2,
    messages: [
      {
        id: "m1",
        author: "Eva (Horizon)",
        role: "client",
        body: "Love the new case-study layout. One thought — can the hero image bleed to the edges on mobile?",
        time: "09:14",
      },
      {
        id: "m2",
        author: "Santi",
        role: "team",
        body: "On it. I'll push a tweak this afternoon and drop a preview link here.",
        time: "09:22",
      },
      {
        id: "m3",
        author: "Santi",
        role: "team",
        body: "Deployed to staging. Check staging.horizonarchitects.nl — looks clean on iPhone 14 + 15.",
        time: "11:47",
      },
      {
        id: "m4",
        author: "Eva (Horizon)",
        role: "client",
        body: "Perfect. Green-light from our side. Let's ship.",
        time: "12:03",
      },
    ],
  },
  {
    id: "ch-bloom-general",
    projectId: "bloom-interiors",
    name: "bloom-interiors",
    unread: 0,
    messages: [
      {
        id: "b1",
        author: "Lotte (Bloom)",
        role: "client",
        body: "Draft copy for the booking confirmation is in the shared doc.",
        time: "yesterday",
      },
      {
        id: "b2",
        author: "Santi",
        role: "team",
        body: "Wired it in — review link incoming.",
        time: "yesterday",
      },
    ],
  },
  {
    id: "ch-nova-general",
    projectId: "nova-studios",
    name: "nova-studios",
    unread: 1,
    messages: [
      {
        id: "n1",
        author: "Mika (Nova)",
        role: "client",
        body: "Migration status update? Team's asking about the about-us page.",
        time: "2h ago",
      },
    ],
  },
];

export const DEMO_FILES: Record<string, DemoFileNode[]> = {
  "horizon-architects": [
    {
      name: "app",
      kind: "folder",
      children: [
        {
          name: "(marketing)",
          kind: "folder",
          children: [
            { name: "page.tsx", kind: "file" },
            { name: "layout.tsx", kind: "file" },
            {
              name: "case-studies",
              kind: "folder",
              children: [
                { name: "page.tsx", kind: "file" },
                { name: "[slug]", kind: "folder", children: [
                  { name: "page.tsx", kind: "file" },
                ]},
              ],
            },
          ],
        },
        { name: "globals.css", kind: "file" },
      ],
    },
    {
      name: "components",
      kind: "folder",
      children: [
        { name: "Hero.tsx", kind: "file" },
        { name: "CaseStudyCard.tsx", kind: "file" },
        { name: "Topbar.tsx", kind: "file" },
      ],
    },
    {
      name: "content",
      kind: "folder",
      children: [
        { name: "studio-villa-noord.mdx", kind: "file" },
        { name: "atelier-de-pijp.mdx", kind: "file" },
      ],
    },
    { name: "package.json", kind: "file" },
    { name: "README.md", kind: "file" },
  ],
};

// Adapters that surface the fake content in the shapes the real data
// helpers return. These are what `visibleProjects`, `listChannelsForUser`,
// and `listMessages` hand back when the caller is the demo user.

export function demoProjectConfigs(): ProjectConfig[] {
  return DEMO_PROJECTS.map((p) => ({
    id: p.id,
    name: p.name,
    path: `/demo/${p.id}`,
    visibility: "team",
    previewUrl: undefined,
    liveUrl: undefined,
  }));
}

export function demoChannelViews(): ChannelView[] {
  return DEMO_CHANNELS.map((c, i) => ({
    id: 1000 + i,
    kind: "project",
    projectId: c.projectId,
    projectName: DEMO_PROJECTS.find((p) => p.id === c.projectId)?.name ?? c.name,
    name: DEMO_PROJECTS.find((p) => p.id === c.projectId)?.name ?? c.name,
    createdAt: Date.now() - i * 86400_000,
  }));
}

/** Synthetic MessageView list for a given demo channel id. */
export function demoMessagesForChannel(channelId: number): MessageView[] {
  const idx = channelId - 1000;
  const channel = DEMO_CHANNELS[idx];
  if (!channel) return [];
  return channel.messages.map((m, i) => ({
    id: channelId * 100 + i,
    channelId,
    userId: m.role === "team" ? DEMO_USER.id : -100 - i,
    userName: m.author,
    kind: "text",
    body: m.body,
    meta: null,
    createdAt: Date.now() - (channel.messages.length - i) * 60_000,
    attachments: [],
  }));
}

// A single file's content for the "open a file" tour step. Kept short so
// it fits on screen without scrolling.
export const DEMO_FILE_PREVIEW = {
  path: "components/CaseStudyCard.tsx",
  language: "tsx",
  body: `import Image from "next/image";
import Link from "next/link";

interface CaseStudyCardProps {
  slug: string;
  title: string;
  client: string;
  cover: string;
}

export function CaseStudyCard({ slug, title, client, cover }: CaseStudyCardProps) {
  return (
    <Link
      href={\`/case-studies/\${slug}\`}
      className="group block overflow-hidden rounded-2xl bg-neutral-900"
    >
      <div className="relative aspect-[4/3]">
        <Image
          src={cover}
          alt={title}
          fill
          className="object-cover transition duration-700 group-hover:scale-105"
        />
      </div>
      <div className="p-5">
        <p className="text-xs uppercase tracking-wider text-neutral-400">
          {client}
        </p>
        <h3 className="mt-2 text-lg font-medium">{title}</h3>
      </div>
    </Link>
  );
}
`,
};
