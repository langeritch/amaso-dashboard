"use client";

import Link from "next/link";
import { useMemo } from "react";
import {
  ExternalLink,
  Music,
  Newspaper,
  Phone,
  PhoneOff,
  Radio,
  Sparkles,
  StickyNote,
  Wind,
  Zap,
} from "lucide-react";
import { useSparOptional, type FillerNow } from "./SparContext";

interface ProjectLite {
  id: string;
  name: string;
}

interface OpenRemark {
  id: number;
  userName: string;
  projectId: string;
  path: string | null;
  line: number | null;
  category: "frontend" | "backend" | "other";
  body: string;
  createdAt: number;
}

interface Props {
  projects: ProjectLite[];
  openRemarks: OpenRemark[];
}

export default function BrainSparringPanel({ projects, openRemarks }: Props) {
  const spar = useSparOptional();
  const projectName = useMemo(() => {
    const m = new Map(projects.map((p) => [p.id, p.name]));
    return (id: string) => m.get(id) ?? id;
  }, [projects]);

  const recentDispatches = useMemo(() => {
    if (!spar) return [];
    return spar.dispatches
      .slice()
      .sort((a, b) => b.confirmedAt - a.confirmedAt)
      .slice(0, 6);
  }, [spar]);

  const recentMessages = useMemo(() => {
    if (!spar) return [];
    return spar.messages.slice(-4);
  }, [spar]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Sparring partner
        </h1>
        <p className="mt-2 text-sm text-neutral-400">
          Live status from the voice-first Spar session, plus open remarks
          across every project you can see.
        </p>
      </header>

      {!spar ? (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 text-sm text-neutral-400">
          Spar isn&rsquo;t mounted in this session.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <StatusCard
            inCall={spar.inCall}
            status={spar.status}
            callTimeLabel={spar.callTimeLabel}
            autopilot={spar.autopilot}
            interimText={spar.interimText}
          />
          <NowPlayingCard fillerNow={spar.fillerNow} />
        </div>
      )}

      {spar && (
        <section className="mt-6">
          <SectionHeading icon={Radio} label="Recent dispatches" />
          {recentDispatches.length === 0 ? (
            <Empty>No dispatches yet this session.</Empty>
          ) : (
            <ul className="flex flex-col gap-2">
              {recentDispatches.map((d) => {
                const tone =
                  d.status === "sent"
                    ? "border-emerald-500/40 bg-emerald-950/20"
                    : "border-red-500/40 bg-red-950/20";
                return (
                  <li
                    key={d.id}
                    className={`rounded-xl border px-3 py-2 text-sm ${tone}`}
                  >
                    <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-neutral-400">
                      <span>{d.status === "sent" ? "sent" : "failed"}</span>
                      <span className="font-mono text-neutral-500">
                        {projectName(d.projectId)}
                      </span>
                      <span className="ml-auto text-neutral-500">
                        {timeAgo(d.confirmedAt)}
                      </span>
                    </div>
                    <div className="mt-1 line-clamp-3 text-neutral-200 whitespace-pre-wrap">
                      {d.prompt}
                    </div>
                    {d.error && (
                      <div className="mt-1 text-[11px] text-red-300">
                        {d.error}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {spar && recentMessages.length > 0 && (
        <section className="mt-6">
          <SectionHeading icon={Sparkles} label="Recent transcript" />
          <ul className="flex flex-col gap-2">
            {recentMessages.map((m) => (
              <li
                key={m.id}
                className={`rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                  m.role === "user"
                    ? "bg-emerald-700/20 text-emerald-50"
                    : "bg-neutral-800/60 text-neutral-100"
                }`}
              >
                <span className="mr-2 text-[10px] uppercase tracking-[0.18em] text-neutral-400">
                  {m.role}
                </span>
                {m.content || (spar.busy && m.role === "assistant" ? "…" : "")}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-6">
        <SectionHeading
          icon={StickyNote}
          label={`Open remarks · ${openRemarks.length}`}
        />
        {openRemarks.length === 0 ? (
          <Empty>No open remarks across your projects.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {openRemarks.slice(0, 12).map((r) => (
              <li
                key={r.id}
                className="rounded-xl border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-neutral-400">
                  <CategoryDot category={r.category} />
                  <span className="text-neutral-300">{r.userName}</span>
                  <span className="font-mono text-neutral-500">
                    {projectName(r.projectId)}
                  </span>
                  {r.path && (
                    <span className="font-mono text-neutral-500">
                      · {r.path}
                      {r.line ? `:${r.line}` : ""}
                    </span>
                  )}
                  <span className="ml-auto text-neutral-500">
                    {timeAgo(r.createdAt)}
                  </span>
                </div>
                <div className="mt-1 line-clamp-3 text-neutral-200 whitespace-pre-wrap">
                  {r.body}
                </div>
              </li>
            ))}
          </ul>
        )}
        {openRemarks.length > 12 && (
          <Link
            href="/remarks"
            className="mt-3 inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-200"
          >
            See all {openRemarks.length} remarks
            <ExternalLink className="h-3 w-3" />
          </Link>
        )}
      </section>
    </div>
  );
}

function StatusCard({
  inCall,
  status,
  callTimeLabel,
  autopilot,
  interimText,
}: {
  inCall: boolean;
  status: string;
  callTimeLabel: string;
  autopilot: boolean;
  interimText: string;
}) {
  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-neutral-400">
        {inCall ? (
          <>
            <Phone className="h-3 w-3 text-emerald-400" />
            <span className="text-emerald-300">in call · {callTimeLabel}</span>
          </>
        ) : (
          <>
            <PhoneOff className="h-3 w-3" />
            <span>standby</span>
          </>
        )}
        {autopilot && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full border border-emerald-400/60 bg-emerald-500/15 px-2 py-0.5 text-emerald-200">
            <Zap className="h-3 w-3" />
            autopilot
          </span>
        )}
      </div>
      <div className="mt-3 text-2xl font-semibold tracking-tight text-neutral-100">
        {status}
      </div>
      {interimText && (
        <div className="mt-2 line-clamp-2 text-sm italic leading-snug text-neutral-400">
          {interimText}
        </div>
      )}
      <Link
        href="/spar"
        className="mt-4 inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-200"
      >
        Open Spar
        <ExternalLink className="h-3 w-3" />
      </Link>
    </div>
  );
}

function NowPlayingCard({ fillerNow }: { fillerNow: FillerNow }) {
  const { icon: Icon, tint, label, sub } = describeFiller(fillerNow);
  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="text-[11px] uppercase tracking-[0.18em] text-neutral-400">
        Now playing
      </div>
      <div className="mt-3 flex items-center gap-3">
        {fillerNow.kind === "youtube" && fillerNow.thumbnailUrl ? (
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded-md bg-neutral-800">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fillerNow.thumbnailUrl}
              alt={fillerNow.title ?? "now playing"}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </div>
        ) : (
          <div
            className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-md ${tint}`}
          >
            <Icon className="h-6 w-6" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-medium text-neutral-100">
            {label}
          </div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">
            {sub}
          </div>
        </div>
      </div>
    </div>
  );
}

function describeFiller(fn: FillerNow): {
  icon: React.ComponentType<{ className?: string }>;
  tint: string;
  label: string;
  sub: string;
} {
  switch (fn.kind) {
    case "youtube":
      return {
        icon: Music,
        tint: "bg-neutral-800 text-neutral-300",
        label: fn.title ?? "playing",
        sub: fn.status === "playing" ? "youtube · playing" : "youtube · paused",
      };
    case "news":
      return {
        icon: Newspaper,
        tint: "bg-amber-900/30 text-amber-200",
        label: "Reading the news",
        sub: "filler · news clip",
      };
    case "hum":
      return {
        icon: Wind,
        tint: "bg-sky-900/30 text-sky-200",
        label: "Windchime hum",
        sub: "filler · ambient",
      };
    case "speaking":
      return {
        icon: Radio,
        tint: "bg-emerald-900/30 text-emerald-200",
        label: "Sparring partner speaking",
        sub: "tts · live",
      };
    case "listening":
      return {
        icon: Radio,
        tint: "bg-rose-900/30 text-rose-200",
        label: "Listening…",
        sub: "voice · live",
      };
    case "thinking":
      return {
        icon: Sparkles,
        tint: "bg-violet-900/30 text-violet-200",
        label: "Thinking…",
        sub: "claude · working",
      };
    case "telegram":
      switch (fn.phase) {
        case "thinking":
          return {
            icon: Sparkles,
            tint: "bg-violet-900/30 text-violet-200",
            label: "Telegram · thinking…",
            sub: "phone · claude working",
          };
        case "speaking":
          return {
            icon: Radio,
            tint: "bg-emerald-900/30 text-emerald-200",
            label: "Telegram · speaking",
            sub: "phone · assistant talking",
          };
        case "listening":
          return {
            icon: Phone,
            tint: "bg-sky-900/30 text-sky-200",
            label: "Telegram · listening…",
            sub: "phone · mic open",
          };
      }
    case "idle":
      return {
        icon: Music,
        tint: "bg-neutral-800 text-neutral-500",
        label: "Nothing playing",
        sub: "ready",
      };
  }
}

function SectionHeading({
  icon: Icon,
  label,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] text-neutral-400">
      <Icon className="h-3.5 w-3.5" />
      {label}
    </h2>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-neutral-800 bg-neutral-900/30 px-3 py-4 text-sm text-neutral-500">
      {children}
    </div>
  );
}

function CategoryDot({ category }: { category: OpenRemark["category"] }) {
  const tone =
    category === "frontend"
      ? "bg-sky-400"
      : category === "backend"
        ? "bg-amber-400"
        : "bg-neutral-400";
  return (
    <span
      className={`inline-block h-1.5 w-1.5 rounded-full ${tone}`}
      title={category}
      aria-label={category}
    />
  );
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "now";
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  return `${w}w ago`;
}
