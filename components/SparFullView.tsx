"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  AlertCircle,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  Menu,
  MessageSquare,
  Mic,
  MicOff,
  Paperclip,
  Pencil,
  Phone,
  PhoneOff,
  Radio,
  Send,
  Activity,
  Trash2,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import {
  useSpar,
  MAX_TRANSCRIPT,
  type Attachment,
  type Dispatch,
  type ToolStep,
} from "./SparContext";
import SparAudioVisualizer from "./SparAudioVisualizer";
import { useVoiceChannel } from "./useVoiceChannel";
import { useClaimSparFooter } from "./SparFooterContext";
import { SparMediaRow } from "./SparMiniPlayer";
import HeartbeatPanel from "./HeartbeatPanel";
import { useLatestTick } from "./HeartbeatView";
import AutopilotSidebar from "./AutopilotSidebar";

type Mode = "text" | "voice";

/**
 * Slash-command registry. Single source of truth for the chat
 * autocomplete dropdown and for `submitDraft`'s recognition of typed
 * commands. Adding a new command is a one-liner: append an entry with
 * a `name`, `description`, and `action`.
 *
 *  - `action.kind === "insert"` → selecting the command in the
 *    dropdown replaces the input with `text` and leaves the cursor
 *    at the end so the user can type arguments. Submit semantics
 *    (e.g. parsing a YouTube URL out of the rest of the line) live
 *    in `submitDraft` and stay local to the consumer.
 *  - `action.kind === "execute"` → selecting (or submitting bare)
 *    the command runs `run(ctx)` immediately and clears the draft.
 *    No further input is needed.
 */
type SlashFillerMode = "news" | "quiet" | "fun-facts" | "calendar";

interface SlashCommandContext {
  setFillerMode: (mode: SlashFillerMode) => Promise<void>;
}

interface SlashCommand {
  name: string;
  description: string;
  action:
    | { kind: "insert"; text: string }
    | {
        kind: "execute";
        run: (ctx: SlashCommandContext) => void | Promise<void>;
      };
}

const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "/youtube",
    description: "play a YouTube URL or video ID",
    action: { kind: "insert", text: "/youtube " },
  },
  {
    name: "/queue",
    description: "queue a YouTube URL or video ID",
    action: { kind: "insert", text: "/queue " },
  },
  {
    name: "/news",
    description: "filler mode: news headline clips",
    action: { kind: "execute", run: (ctx) => ctx.setFillerMode("news") },
  },
  {
    name: "/quiet",
    description: "filler mode: ambient chime only",
    action: { kind: "execute", run: (ctx) => ctx.setFillerMode("quiet") },
  },
  // /off intentionally removed — the speaker toggle in the media
  // drawer is the user-facing way to silence assistant speech.
  // Legacy persisted "off" values normalise to "quiet" on read
  // (see lib/filler-mode.ts) so old configs keep working.
  {
    name: "/fun-facts",
    description: "filler mode: trivia spoken via TTS",
    action: { kind: "execute", run: (ctx) => ctx.setFillerMode("fun-facts") },
  },
  {
    name: "/calendar",
    description: "filler mode: agenda items spoken via TTS",
    action: { kind: "execute", run: (ctx) => ctx.setFillerMode("calendar") },
  },
];

/**
 * A draft is "in slash-completion territory" while it starts with `/`
 * and the user hasn't typed a separator yet (space or newline). Once
 * the user types past the command name (e.g. `/youtube <url>`), the
 * dropdown should close — they're typing arguments.
 */
function matchSlashCommands(draft: string): SlashCommand[] {
  if (!draft.startsWith("/")) return [];
  if (/\s/.test(draft)) return [];
  const lower = draft.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(lower));
}

// Pulls the 11-char video ID out of any common YouTube URL shape, or
// accepts a bare ID. Returns null when the input doesn't look like a
// YouTube reference at all so callers can fall through to normal
// message handling instead of triggering on noise.
function parseYoutubeVideoId(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;
  const idPattern = /^[A-Za-z0-9_-]{11}$/;
  if (idPattern.test(input)) return input;
  let url: URL;
  try {
    url = new URL(input.includes("://") ? input : `https://${input}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.replace(/^\/+/, "").split("/")[0];
    return idPattern.test(id) ? id : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com") {
    const v = url.searchParams.get("v");
    if (v && idPattern.test(v)) return v;
    // /shorts/<id> and /embed/<id> are common alternates worth picking
    // up since the parser otherwise feels surprisingly strict.
    const segs = url.pathname.split("/").filter(Boolean);
    if (segs[0] === "shorts" || segs[0] === "embed") {
      const id = segs[1] ?? "";
      return idPattern.test(id) ? id : null;
    }
  }
  return null;
}

/**
 * One step the agent took inside its tool-using loop. Renders as a
 * small inline card just above the assistant's text bubble — running
 * steps animate, completed ones flatten into a quiet badge so the
 * user can scan past steps after reading the final answer.
 */
function ToolStepCard({ step }: { step: ToolStep }) {
  const tone =
    step.status === "running"
      ? "border-sky-700/50 bg-sky-950/40 text-sky-100"
      : step.status === "ok"
        ? "border-neutral-800/80 bg-neutral-900/60 text-neutral-300"
        : "border-rose-800/60 bg-rose-950/40 text-rose-100";
  const Icon =
    step.status === "running"
      ? Loader2
      : step.status === "ok"
        ? Check
        : AlertCircle;
  const iconClass =
    step.status === "running"
      ? "animate-spin text-sky-300"
      : step.status === "ok"
        ? "text-orange-300/80"
        : "text-rose-300";
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-[12px] leading-snug ${tone}`}
    >
      <Icon className={`mt-0.5 h-3.5 w-3.5 flex-shrink-0 ${iconClass}`} />
      <div className="min-w-0 flex-1">
        <div className="break-words">
          <span className="font-medium">{step.label}</span>
          {step.detail ? (
            <span className="ml-1 text-neutral-400">{step.detail}</span>
          ) : null}
        </div>
        {step.summary ? (
          <div className="mt-0.5 break-words text-[11px] text-neutral-400">
            {step.summary}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ToolStepList({ steps }: { steps: ToolStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="mb-1 flex flex-col gap-1">
      {steps.map((s) => (
        <ToolStepCard key={s.id} step={s} />
      ))}
    </div>
  );
}

/**
 * Subtle "sources read" strip rendered under each assistant bubble.
 * Default state is collapsed: just an icon and the count. Tap to
 * expand and show the full list as small chips. The visual weight is
 * deliberately low — this is transparency for users who want it, not
 * a primary surface that competes with the answer.
 */
function SourcesStrip({ sources }: { sources: string[] }) {
  const [open, setOpen] = useState(false);
  if (!sources.length) return null;
  const count = sources.length;
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 self-start rounded-full border border-neutral-800/70 bg-neutral-900/40 px-2 py-0.5 text-[11px] text-neutral-400 transition hover:border-neutral-700 hover:text-neutral-200"
        aria-expanded={open}
      >
        <BookOpen className="h-3 w-3" />
        <span>
          {count} {count === 1 ? "source" : "sources"} read
        </span>
        <ChevronRight
          className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open ? (
        <div className="flex flex-wrap gap-1 pl-1">
          {sources.map((s) => (
            <span
              key={s}
              className="break-all rounded-full border border-neutral-800/70 bg-neutral-900/30 px-2 py-0.5 text-[10.5px] text-neutral-400"
            >
              {s}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentPreviewBar({
  attachments,
  onRemove,
}: {
  attachments: Attachment[];
  onRemove: (id: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="flex gap-2 overflow-x-auto px-1 pb-2">
      {attachments.map((a) => (
        <div
          key={a.id}
          className="group relative flex-shrink-0 rounded-lg border border-neutral-700 bg-neutral-800/60 p-1"
        >
          <button
            type="button"
            onClick={() => onRemove(a.id)}
            className="absolute -right-1.5 -top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-700 text-neutral-300 opacity-0 transition group-hover:opacity-100 hover:bg-red-600 hover:text-white"
          >
            <X className="h-3 w-3" />
          </button>
          {a.type.startsWith("image/") ? (
            <img
              src={a.dataUrl}
              alt={a.name}
              className="h-16 w-16 rounded object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 flex-col items-center justify-center gap-1 text-neutral-400">
              <FileText className="h-5 w-5" />
              <span className="max-w-full truncate px-1 text-[9px]">
                {a.name}
              </span>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function InlineAttachments({ attachments }: { attachments: Attachment[] }) {
  const [enlarged, setEnlarged] = useState<string | null>(null);
  if (!attachments.length) return null;
  return (
    <>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {attachments.map((a) =>
          a.type.startsWith("image/") ? (
            <img
              key={a.id}
              src={a.dataUrl}
              alt={a.name}
              onClick={() => setEnlarged(a.dataUrl)}
              className="h-20 max-w-[160px] cursor-pointer rounded-lg border border-neutral-700 object-cover transition hover:border-neutral-500"
            />
          ) : (
            <div
              key={a.id}
              className="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800/50 px-2 py-1 text-[11px] text-neutral-300"
            >
              <FileText className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="max-w-[120px] truncate">{a.name}</span>
            </div>
          ),
        )}
      </div>
      {enlarged && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setEnlarged(null)}
        >
          <img
            src={enlarged}
            alt=""
            className="max-h-[90vh] max-w-[90vw] rounded-lg"
          />
        </div>
      )}
    </>
  );
}

/**
 * Compact dropdown that floats above the chat input while the user is
 * typing a slash command. Positioned via `absolute bottom-full` on
 * the relatively-positioned form, so it sits flush against the top
 * edge of the composer regardless of how tall the textarea has grown.
 *
 * Mouse handlers use `onMouseDown` + preventDefault so clicking an
 * item doesn't blur the textarea before the click registers.
 */
function SlashCommandDropdown({
  matches,
  selectedIndex,
  onSelect,
  onHover,
}: {
  matches: SlashCommand[];
  selectedIndex: number;
  onSelect: (cmd: SlashCommand) => void;
  onHover: (idx: number) => void;
}) {
  if (matches.length === 0) return null;
  return (
    <div className="absolute inset-x-0 bottom-full mb-2">
      <ul
        role="listbox"
        className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/95 shadow-2xl backdrop-blur"
      >
        {matches.map((cmd, idx) => {
          const active = idx === selectedIndex;
          return (
            <li key={cmd.name} role="option" aria-selected={active}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(cmd);
                }}
                onMouseEnter={() => onHover(idx)}
                className={`flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-sm transition ${
                  active
                    ? "bg-neutral-800/80 text-neutral-100"
                    : "text-neutral-200 hover:bg-neutral-800/40"
                }`}
              >
                <span className="font-mono text-[13px]">{cmd.name}</span>
                <span className="truncate text-[11px] text-neutral-500">
                  {cmd.description}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Friendly cluster-divider timestamp. Today: "12:34"; yesterday or
 *  earlier this week: "Mon · 12:34"; older: "Mar 14 · 12:34". Used by
 *  the chat surface to anchor message clusters without spamming a
 *  timestamp under every bubble. */
function formatClusterTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  const dayMs = 24 * 60 * 60_000;
  const ageDays = (now.getTime() - ts) / dayMs;
  if (ageDays < 7) {
    const day = d.toLocaleDateString(undefined, { weekday: "short" });
    return `${day} · ${time}`;
  }
  const md = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${md} · ${time}`;
}

function ThinkingTimer({ startedAt }: { startedAt: number }) {
  const [elapsed, setElapsed] = useState(
    Math.round((Date.now() - startedAt) / 1000),
  );
  useEffect(() => {
    const id = setInterval(
      () => setElapsed(Math.round((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [startedAt]);
  return (
    <span className="mt-1 block text-[10px] text-neutral-500">
      {elapsed}s…
    </span>
  );
}

export default function SparFullView() {
  const {
    currentUser,
    canManageOthers,
    messages,
    busy,
    interimText,
    status,
    inCall,
    listening,
    micMuted,
    ttsMuted,
    ttsIdle,
    autopilot,
    callTimeLabel,
    lastDispatch,
    heartbeat,
    setHeartbeat,
    heartbeatDirty,
    setHeartbeatDirty,
    savingHeartbeat,
    speakingUserId,
    analyserRef,
    messagesEndRef,
    startCall,
    endCall,
    toggleMicMute,
    toggleTtsMute,
    toggleAutopilot,
    pendingAttachments,
    addAttachments,
    removeAttachment,
    sendMessage,
    messageQueue,
    enqueueMessage,
    editQueuedMessage,
    removeQueuedMessage,
    saveHeartbeat,
    loadHeartbeatFor,
    clearTranscript,
    fillerNow,
    youtubePlay,
    youtubePause,
    appendNotice,
    activeDriftNotice,
    dismissDriftNotice,
    newConversation,
  } = useSpar();
  const queue = messageQueue;

  // Latest heartbeat tick drives the small status dot on the heartbeat
  // button so the user can see at a glance whether the last cron tick
  // was clean (green) or escalated to a tier-2 alert (amber). Polled
  // independently of the panel so the dot stays fresh even when the
  // panel is closed.
  const latestTick = useLatestTick(currentUser?.id ?? 0);

  const [draft, setDraft] = useState("");
  // Slash-command autocomplete state. `slashIndex` is the highlighted
  // row in the dropdown; `slashDismissed` latches when the user hits
  // Escape so the dropdown stays hidden until the next text edit.
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  // Pending messages the user submitted while the agent is thinking
  // or TTS is still speaking. Drained FIFO once both go idle so the
  // user can keep typing without waiting on a reply. Lives in the
  // provider so auto-report nudges can use the SAME queue — they
  // enqueue, wait their turn, and drain through sendMessage exactly
  // the same way a typed draft does.
  const [heartbeatOpen, setHeartbeatOpen] = useState(false);
  const [autopilotSidebarOpen, setAutopilotSidebarOpen] = useState(false);
  // Mobile-only bottom sheet that holds the secondary controls
  // (autopilot, heartbeat, transcript, speaker, telegram, workers).
  // The desktop header keeps showing them inline; on small screens the
  // header reduces to mode toggle + a hamburger that opens this sheet.
  const [menuOpen, setMenuOpen] = useState(false);
  // Tracks viewport so the workers panel can render in exactly one
  // place (desktop overlay vs. mobile sheet) instead of two — otherwise
  // both instances poll /api/spar/worker-status independently.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  // Default to text mode — the page now opens like a normal chat app
  // and lets the user toggle into voice mode (which keeps the existing
  // ring + call dock UI verbatim). State is local to this view; the
  // underlying call/audio infrastructure in SparContext doesn't care
  // which mode is rendered, so toggling never disturbs an active call.
  const [mode, setMode] = useState<Mode>("text");

  // Listen for spar:remote-sidebar events so the spar voice assistant
  // can open / close the right autopilot panel via the remote-control
  // API. Mirrors the left-sidebar listener in SparPageShell.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ side?: string; open?: boolean }>)
        .detail;
      if (!detail || detail.side !== "right") return;
      setAutopilotSidebarOpen(Boolean(detail.open));
    };
    window.addEventListener("spar:remote-sidebar", handler);
    return () => window.removeEventListener("spar:remote-sidebar", handler);
  }, []);

  // Claim the global SparMiniPlayer footer slot so the mini-player
  // hides itself while this view is mounted — we render a single
  // unified footer below that bundles the media row, control buttons,
  // and chat composer in one bar.
  useClaimSparFooter();
  // Declarations must precede the `bottomReserve` calc below — the
  // previous order had `bottomReserve` reading `unifiedFooterHeight`
  // four lines before the useState call that creates it, which TS's
  // block-scoped TDZ check (correctly) rejected. Build failed in a
  // tight loop until this got moved up.
  const unifiedFooterRef = useRef<HTMLDivElement>(null);
  const [unifiedFooterHeight, setUnifiedFooterHeight] = useState(0);
  const bottomReserve = (unifiedFooterHeight || 120) + 4;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Scroll container for the text-mode message list. We track whether
  // the user is "stuck to bottom" (within ~80px of the floor) so new
  // messages auto-scroll only when they're already at the latest —
  // scrolling up to read history shouldn't yank you back. When you
  // *aren't* stuck and a new message arrives, a "scroll to bottom"
  // pill appears above the composer.
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const [hasNewBelow, setHasNewBelow] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragCountRef = useRef(0);
  // Tracks whether the speaker toggle (not the user's own mini-player
  // pause) is what stopped YouTube. Lets unmute resume only what we
  // ourselves paused — if the user paused the track manually before
  // muting TTS, hitting unmute shouldn't reach in and start playback.
  const pausedYoutubeRef = useRef(false);
  const voice = useVoiceChannel();
  const onTelegram = voice.channel === "telegram";
  const phase: "speaking" | "thinking" | "listening" | null = !ttsIdle
    ? "speaking"
    : busy
      ? "thinking"
      : listening && !micMuted
        ? "listening"
        : null;
  const phaseDot =
    phase === "speaking"
      ? "bg-teal-300"
      : phase === "thinking"
        ? "bg-amber-300"
        : phase === "listening"
          ? "bg-rose-300"
          : "bg-sky-300";

  // Auto-scroll behaviour, position-aware. We only smooth-scroll to
  // the latest message when the user is already pinned to the bottom;
  // if they've scrolled up to read older context, new messages don't
  // yank them back — instead the "↓ new messages" pill (rendered
  // above the composer) lights up so they can opt in.
  useEffect(() => {
    if (mode !== "text") return;
    if (stuckToBottom) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      setHasNewBelow(false);
    } else {
      setHasNewBelow(true);
    }
    // We deliberately don't depend on `stuckToBottom` here — the
    // intent is "react to new messages", not "react when the user
    // scrolls". The current value is read via closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, messagesEndRef, mode]);
  useEffect(() => {
    // Mode swap (voice → text or back) always lands at the floor.
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    setStuckToBottom(true);
    setHasNewBelow(false);
  }, [mode, messagesEndRef]);

  // Live transcript follow. As the user speaks, `interimText` grows
  // word by word and the bubble it's rendered in expands — without
  // this, that growing line slides down behind the footer and the
  // user can't see what's being captured. Fire on every interim
  // update but only when the user is already pinned to the bottom
  // (same rule as the message-arrival effect): if they've scrolled
  // up to read history, we still don't yank them. `behavior: auto`
  // because interim updates fire many times a second and queued
  // smooth-scrolls would visibly lag the typing.
  useEffect(() => {
    if (!interimText) return;
    if (!stuckToBottom) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interimText, mode]);

  // Keep `stuckToBottom` in sync with actual scroll position. Threshold
  // is a forgiving 80px so a half-line of overscroll (or a momentum
  // wobble on iOS) still counts as "at the bottom".
  useEffect(() => {
    if (mode !== "text") return;
    const el = messagesScrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distanceFromBottom < 80;
      setStuckToBottom(atBottom);
      if (atBottom) setHasNewBelow(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [mode]);

  const scrollToLatest = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setHasNewBelow(false);
  }, [messagesEndRef]);

  // Auto-grow the text-mode composer up to a cap so multi-line drafts
  // don't get cut off but can't push the input past ~6 lines either.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [draft, mode]);

  // Measure the unified footer in both modes — chat content uses this
  // height to know how much bottom padding to reserve so messages
  // never sit behind the bar (which grows with safe-area insets and
  // when the textarea expands to multi-line).
  useEffect(() => {
    const el = unifiedFooterRef.current;
    if (!el) return;
    const update = () =>
      setUnifiedFooterHeight(Math.ceil(el.getBoundingClientRect().height));
    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  // POST to the filler-mode endpoint and surface a transcript notice
  // so the user has a visible confirmation that their /news, /quiet,
  // etc. command landed. Fire-and-forget — the underlying writer in
  // `lib/filler-mode.ts` is the source of truth, and the next filler
  // tick picks up the new mode.
  const setFillerModeRemote = useCallback(
    async (mode: SlashFillerMode) => {
      try {
        const res = await fetch("/api/spar/filler-mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode }),
          cache: "no-store",
        });
        if (res.ok) {
          appendNotice(`Filler mode → ${mode}`);
        } else {
          appendNotice(`Failed to set filler mode (${mode})`);
        }
      } catch {
        appendNotice(`Failed to set filler mode (${mode})`);
      }
    },
    [appendNotice],
  );

  const slashCtx: SlashCommandContext = useMemo(
    () => ({ setFillerMode: setFillerModeRemote }),
    [setFillerModeRemote],
  );

  const slashMatches = useMemo(() => matchSlashCommands(draft), [draft]);
  const slashOpen = slashMatches.length > 0 && !slashDismissed;

  // Keep the highlighted row inside the current match set. Without
  // this, narrowing the matches (e.g. typing another character) could
  // leave `slashIndex` pointing past the array end.
  useEffect(() => {
    if (slashIndex >= slashMatches.length) setSlashIndex(0);
  }, [slashMatches, slashIndex]);

  function applySlashCommand(cmd: SlashCommand) {
    setSlashIndex(0);
    setSlashDismissed(false);
    if (cmd.action.kind === "insert") {
      const text = cmd.action.text;
      setDraft(text);
      // Defer focus + caret placement until React has rendered the new
      // value, otherwise setSelectionRange runs against the stale text.
      setTimeout(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(text.length, text.length);
      }, 0);
    } else {
      setDraft("");
      void Promise.resolve(cmd.action.run(slashCtx)).catch(() => {
        /* notice already surfaced inside the runner */
      });
    }
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current += 1;
    if (e.dataTransfer.types.includes("Files")) setDragOver(true);
  }
  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current -= 1;
    if (dragCountRef.current <= 0) {
      dragCountRef.current = 0;
      setDragOver(false);
    }
  }
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) addAttachments(files);
  }
  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length) addAttachments(files);
    e.target.value = "";
  }

  function submitDraft() {
    const text = draft.trim();
    if (!text && !pendingAttachments.length) return;
    // Slash-command interception runs before queueing so a /youtube
    // typed mid-reply doesn't get held behind a long TTS stream — the
    // command is local-only and doesn't compete with the AI turn.
    //
    // Execute-type commands (e.g. /news) are bare names — match them
    // first so the user can hit Enter directly on a typed-out command
    // without going through the dropdown.
    const bareExecute = SLASH_COMMANDS.find(
      (c) => c.action.kind === "execute" && c.name === text.toLowerCase(),
    );
    if (bareExecute && bareExecute.action.kind === "execute") {
      const run = bareExecute.action.run;
      setDraft("");
      void Promise.resolve(run(slashCtx)).catch(() => {
        /* notice already surfaced inside the runner */
      });
      return;
    }
    const ytMatch = text.match(/^\/youtube\s+(.+)$/i);
    // Skip the /queue regex if /youtube already matched. Was previously
    // `!ytMatch && text.match(...)` which typed queueMatch as
    // `false | RegExpMatchArray | null` and broke the build at
    // `match![1]`. Using a ternary keeps the same short-circuit semantics
    // but gives queueMatch the clean `RegExpMatchArray | null` type.
    const queueMatch = ytMatch ? null : text.match(/^\/queue\s+(.+)$/i);
    const match = ytMatch ?? queueMatch;
    if (match) {
      const isQueue = !ytMatch;
      const videoId = parseYoutubeVideoId(match[1]);
      if (videoId) {
        void fetch("/api/youtube/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: isQueue ? "enqueue" : "play", video_id: videoId }),
          cache: "no-store",
        }).catch(() => {
          /* non-fatal — server poll re-syncs eventually */
        });
        appendNotice(`${isQueue ? "Queued" : "Playing"} YouTube video: https://youtu.be/${videoId}`);
        setDraft("");
        return;
      }
    }
    setDraft("");
    const canSendNow = !busy && ttsIdle && queue.length === 0;
    if (canSendNow) {
      void sendMessage(text);
    } else {
      enqueueMessage(text);
    }
  }

  function handleSpeakerToggle() {
    const willMute = !ttsMuted;
    if (willMute) {
      if (fillerNow.kind === "youtube" && fillerNow.status === "playing") {
        pausedYoutubeRef.current = true;
        youtubePause();
      }
    } else if (pausedYoutubeRef.current) {
      pausedYoutubeRef.current = false;
      youtubePlay();
    }
    toggleTtsMute();
  }

  function editQueued(id: number) {
    const text = editQueuedMessage(id);
    if (text == null) return;
    setDraft((d) => (d ? d + "\n" + text : text));
    // Defer focus so the textarea has the new value when we land on it.
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function removeQueued(id: number) {
    removeQueuedMessage(id);
  }

  // Drain effect lives in the provider now (so auto-report nudges
  // share the same FIFO drain). Nothing to do here.

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-gradient-to-b from-neutral-950 via-neutral-900 to-black text-neutral-100">
      {lastDispatch && Date.now() - lastDispatch.confirmedAt < 30_000 && (
        <DispatchBanner dispatch={lastDispatch} />
      )}
      {activeDriftNotice && (
        <DriftHintBanner
          message={activeDriftNotice}
          onDismiss={() => void dismissDriftNotice()}
          onStartNewChat={() => {
            newConversation();
            void dismissDriftNotice();
          }}
        />
      )}

      {/* Mode-switching body. Both views are kept mounted and
          crossfaded via opacity so the audio analyser, ring animation,
          and chat scroll position never re-mount when toggling. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* Workers panel used to overlay the chat area here; it now
            lives in the page-level SparSidebar (see SparPageShell)
            so the chat reclaims that vertical space. Mobile users
            access it via the sidebar drawer triggered by the
            hamburger button in the page shell. */}
        {/* ── Voice mode ────────────────────────────────────────── */}
        <div
          className={`absolute inset-x-0 top-0 flex min-h-0 flex-col transition-opacity duration-300 ${
            mode === "voice" ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          aria-hidden={mode !== "voice"}
          style={{
            paddingTop: "var(--spar-chrome-h)",
            bottom: bottomReserve,
          }}
        >
          {/* Flex-1 spacer so the dock sits at the bottom of the
              column and the ring centres in the empty space above.
              `min-h-0` allows it to shrink when the dock grows. */}
          <div className="min-h-0 flex-1" />
          {/* Ring container is `fixed` at viewport centre via
              transform-centring. `pointer-events-none` so the ring
              never swallows clicks. Opacity inherits from the parent
              wrapper, so the ring fades alongside the rest of the
              voice UI when the user switches modes. */}
          <div className="pointer-events-none fixed left-1/2 top-1/2 z-20 h-72 w-72 -translate-x-1/2 -translate-y-1/2">
            <SparAudioVisualizer
              analyserRef={analyserRef}
              inCall={inCall}
              listening={listening && !micMuted}
              speaking={!ttsIdle}
              thinking={busy}
              autopilot={autopilot}
            />
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
              <div className="text-xs uppercase tracking-[0.28em] text-neutral-500 whitespace-nowrap">
                {status}
              </div>
              {inCall && (
                <div className="mt-1 font-mono text-sm tabular-nums text-neutral-500 whitespace-nowrap">
                  {callTimeLabel}
                </div>
              )}
              {interimText && (
                <div className="mt-3 line-clamp-3 max-w-[30%] text-[11px] italic leading-snug break-words text-neutral-300">
                  {interimText}
                </div>
              )}
            </div>
          </div>
          {/* Call control dock at the bottom of the voice column. */}
          <div className="pb-safe flex flex-shrink-0 flex-col items-center gap-3 px-6 pb-6">
            {inCall ? (
              <div className="flex w-full max-w-sm items-center justify-between gap-4">
                <CallButton
                  onClick={toggleMicMute}
                  active={!micMuted && ttsIdle}
                  tone="neutral"
                  label={
                    micMuted
                      ? "unmute"
                      : !ttsIdle
                        ? "on speaker"
                        : listening
                          ? "listening"
                          : "mic"
                  }
                >
                  {micMuted || !ttsIdle ? (
                    <MicOff className="h-6 w-6" />
                  ) : (
                    <Mic className="h-6 w-6" />
                  )}
                </CallButton>
                <CallButton
                  onClick={endCall}
                  tone="red"
                  label="end"
                  size="lg"
                  active
                >
                  <PhoneOff className="h-7 w-7" />
                </CallButton>
                <CallButton
                  onClick={handleSpeakerToggle}
                  active={!ttsMuted}
                  tone="neutral"
                  label={ttsMuted ? "speaker off" : "speaker on"}
                >
                  {ttsMuted ? (
                    <VolumeX className="h-6 w-6" />
                  ) : (
                    <Volume2 className="h-6 w-6" />
                  )}
                </CallButton>
              </div>
            ) : (
              <CallButton
                onClick={startCall}
                tone="green"
                size="lg"
                label="call"
                active
              >
                <Phone className="h-7 w-7" />
              </CallButton>
            )}
            {/* Always-visible speaker toggle. Lives outside the
                in-call branch so the user can mute TTS (and pause
                background YouTube) without first picking up the
                phone. The in-call layout above keeps its own speaker
                button to balance the mic/end/speaker triad. */}
            <button
              type="button"
              onClick={handleSpeakerToggle}
              aria-pressed={!ttsMuted}
              title={ttsMuted ? "unmute speaker" : "mute speaker"}
              className="inline-flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-900/60 px-3 py-1 text-[11px] text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
            >
              {ttsMuted ? (
                <VolumeX className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
              <span>{ttsMuted ? "speaker off" : "speaker on"}</span>
            </button>
            <QueueList
              widthClass="w-full max-w-sm"
              queue={queue}
              busy={busy}
              ttsIdle={ttsIdle}
              onEdit={editQueued}
              onRemove={removeQueued}
            />
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitDraft();
              }}
              className="mt-2 flex w-full max-w-sm items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/70 px-3 py-1.5 text-sm transition-[border-color,box-shadow] duration-200 ease-out focus-within:border-orange-500/50 focus-within:shadow-[0_0_0_3px_rgba(255, 107, 61,0.12)]"
            >
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach files"
                className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-neutral-400 hover:text-neutral-200"
              >
                <Paperclip className="h-3.5 w-3.5" />
              </button>
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  busy || !ttsIdle ? "type — will queue…" : "type instead…"
                }
                className="flex-1 bg-transparent text-neutral-200 placeholder-neutral-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={!draft.trim() && !pendingAttachments.length}
                className="amaso-fx amaso-press flex h-8 w-8 items-center justify-center rounded-full bg-orange-500 text-neutral-950 shadow-[0_2px_8px_rgba(255, 107, 61,0.35)] hover:bg-orange-400 disabled:bg-neutral-700 disabled:text-neutral-400 disabled:shadow-none"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>

        {/* ── Text mode ─────────────────────────────────────────── */}
        {/* `min-h-0` here ensures the inner `flex-1 overflow-y-auto`
            messages list can actually shrink and clip — without it,
            flex's default `min-height: auto` lets children push the
            column past its parent's height, leaving the scroll area
            stuck at content size and the messages clumped at the
            bottom of the viewport. The static rows (count bar,
            phase indicator, input dock) get `flex-shrink-0` so they
            stay at natural height instead of competing with the
            list for vertical space. */}
        <div
          className={`absolute inset-x-0 top-0 flex min-h-0 flex-col transition-opacity duration-300 ${
            mode === "text" ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          aria-hidden={mode !== "text"}
          style={{
            paddingTop: "var(--spar-chrome-h)",
            bottom: bottomReserve,
          }}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          {dragOver && (
            <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-sky-400/60 bg-sky-950/40 backdrop-blur-sm">
              <span className="text-lg font-medium text-sky-200">Drop files here</span>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />
          <div className="flex flex-shrink-0 items-center gap-2 border-b border-neutral-900/80 px-4 py-2 text-[11px] text-neutral-500">
            <span className="font-mono">
              {messages.length} / {MAX_TRANSCRIPT}
            </span>
            <button
              type="button"
              disabled={messages.length === 0}
              onClick={clearTranscript}
              className="ml-auto rounded border border-neutral-800 px-2 py-0.5 text-[10px] uppercase tracking-wider hover:border-rose-500/60 hover:text-rose-200 disabled:opacity-40"
            >
              clear
            </button>
          </div>
          <div
            ref={messagesScrollRef}
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <ul className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6">
              {messages.length === 0 && (
                <li className="amaso-fade-in-slow mt-8 flex flex-col items-center px-6 py-12 text-center">
                  <span
                    aria-hidden
                    className="relative mb-5 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-orange-500/30 bg-orange-500/5"
                  >
                    <span className="absolute inset-0 rounded-2xl bg-gradient-to-br from-orange-500/15 to-transparent" />
                    <span className="relative inline-block h-2.5 w-2.5 rounded-full bg-orange-500 shadow-[0_0_12px_rgba(255,107,61,0.7)]" />
                  </span>
                  <h2 className="text-lg font-semibold tracking-tight text-neutral-100">
                    What&rsquo;s on your mind?
                  </h2>
                  <p className="mt-2 max-w-xs text-sm leading-relaxed text-neutral-500">
                    Type below to chat with your sparring partner — or hit{" "}
                    <span className="rounded-md border border-neutral-800 bg-neutral-900/70 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400">
                      voice
                    </span>{" "}
                    to call.
                  </p>
                </li>
              )}
              {messages.flatMap((m, idx) => {
                const dur =
                  m.role === "assistant" && m.startedAt && m.completedAt
                    ? Math.round((m.completedAt - m.startedAt) / 1000)
                    : null;
                const isThinking =
                  m.role === "assistant" &&
                  m.startedAt &&
                  !m.completedAt &&
                  busy;
                // Group messages into time clusters: render an inline
                // timestamp divider above the first message of each
                // cluster (and on first message). Cluster boundary =
                // ≥5min gap between consecutive messages.
                const prev = idx > 0 ? messages[idx - 1] : null;
                const ts = m.startedAt ?? m.completedAt ?? null;
                const prevTs = prev?.startedAt ?? prev?.completedAt ?? null;
                const showTimestamp =
                  ts !== null &&
                  (prev === null ||
                    prevTs === null ||
                    ts - prevTs > 5 * 60_000);
                const tsLabel = showTimestamp ? formatClusterTime(ts!) : null;
                const steps =
                  m.role === "assistant" && m.steps?.length ? m.steps : null;
                const sources =
                  m.role === "assistant" && m.sources?.length
                    ? m.sources
                    : null;
                // Tool steps render as their own track, full-width and
                // off to the side of the assistant bubble. Wrapping
                // them in the same list-item as the message keeps the
                // chronological grouping intact (steps belong to
                // *this* assistant turn) while letting them break out
                // of the bubble's max-w-[85%] constraint visually.
                let bubble: React.ReactElement;
                if (m.role === "assistant" && steps) {
                  // While steps are running and no visible text has
                  // arrived yet, suppress the empty "…" bubble so the
                  // tool cards are the focus. Once any text streams in
                  // (or the turn completes), the bubble appears below.
                  const hasText = m.content && m.content.length > 0;
                  bubble = (
                    <li
                      key={m.id}
                      className="amaso-fade-in flex max-w-[85%] flex-col self-start"
                    >
                      <ToolStepList steps={steps} />
                      {(hasText || !isThinking) && (
                        <div className="rounded-2xl rounded-tl-md bg-neutral-800/70 px-4 py-2.5 text-[14px] leading-[1.55] tracking-[-0.005em] whitespace-pre-wrap text-neutral-100 ring-1 ring-white/[0.04] shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 active:bg-neutral-700/80">
                          {m.content || (busy ? "…" : "")}
                          {dur !== null && (
                            <span className="mt-1 block text-[10px] text-neutral-500">
                              {dur}s
                            </span>
                          )}
                          {isThinking && (
                            <ThinkingTimer startedAt={m.startedAt!} />
                          )}
                        </div>
                      )}
                      {sources && (hasText || !isThinking) ? (
                        <SourcesStrip sources={sources} />
                      ) : null}
                    </li>
                  );
                } else if (m.role === "user" && m.isAutoReport) {
                  // Auto-report bubbles render as user messages with a
                  // small badge above them so the operator can tell at
                  // a glance that the system kicked the turn off (a
                  // dispatched terminal went idle), not them. Otherwise
                  // visually identical to a typed user message.
                  bubble = (
                    <li
                      key={m.id}
                      className="amaso-fade-in flex max-w-[85%] flex-col items-end gap-1 self-end"
                    >
                      <span
                        className="rounded-full border border-orange-700/60 bg-orange-900/30 px-2 py-0.5 text-[10px] uppercase tracking-wider text-orange-300"
                        title="Inserted by the auto-report path after a dispatched terminal finished"
                      >
                        Auto-report
                      </span>
                      <div className="rounded-2xl rounded-tr-md bg-orange-600/25 px-4 py-2.5 text-[14px] leading-[1.55] tracking-[-0.005em] whitespace-pre-wrap text-orange-50 ring-1 ring-orange-400/15 shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 active:bg-orange-600/40">
                        {m.content || ""}
                        {m.attachments?.length ? (
                          <InlineAttachments attachments={m.attachments} />
                        ) : null}
                      </div>
                    </li>
                  );
                } else {
                  bubble = (
                    <li
                      key={m.id}
                      className={
                        m.role === "user"
                          ? "amaso-fade-in max-w-[85%] self-end rounded-2xl rounded-tr-md bg-orange-600/25 px-4 py-2.5 text-[14px] leading-[1.55] tracking-[-0.005em] whitespace-pre-wrap text-orange-50 ring-1 ring-orange-400/15 shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 active:bg-orange-600/40"
                          : "amaso-fade-in flex max-w-[85%] flex-col self-start"
                      }
                    >
                      {m.role === "assistant" ? (
                        <>
                          <div className="rounded-2xl rounded-tl-md bg-neutral-800/70 px-4 py-2.5 text-[14px] leading-[1.55] tracking-[-0.005em] whitespace-pre-wrap text-neutral-100 ring-1 ring-white/[0.04] shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-colors duration-150 active:bg-neutral-700/80">
                            {m.content || (busy ? "…" : "")}
                            {m.attachments?.length ? (
                              <InlineAttachments attachments={m.attachments} />
                            ) : null}
                            {dur !== null && (
                              <span className="mt-1 block text-[10px] text-neutral-500">
                                {dur}s
                              </span>
                            )}
                            {isThinking && (
                              <ThinkingTimer startedAt={m.startedAt!} />
                            )}
                          </div>
                          {sources ? <SourcesStrip sources={sources} /> : null}
                        </>
                      ) : (
                        <>
                          {m.content || ""}
                          {m.attachments?.length ? (
                            <InlineAttachments attachments={m.attachments} />
                          ) : null}
                        </>
                      )}
                    </li>
                  );
                }
                if (tsLabel) {
                  return [
                    <li
                      key={`ts-${m.id}`}
                      aria-hidden
                      className="amaso-fade-in mx-auto py-1 text-center text-[10.5px] font-medium uppercase tracking-[0.16em] text-neutral-600"
                    >
                      {tsLabel}
                    </li>,
                    bubble,
                  ];
                }
                return bubble;
              })}
              {/* Live STT preview — shows what the user is saying
                  while a voice call streams into text mode. Faded so
                  it reads as not-yet-committed. */}
              {interimText && (
                <li className="max-w-[85%] self-end rounded-2xl rounded-tr-md bg-orange-700/15 px-4 py-2.5 text-[14px] italic leading-[1.55] text-orange-100/70 ring-1 ring-orange-400/10">
                  {interimText}
                </li>
              )}
              {/* Anchor for auto-scroll. Only attaches the shared ref
                  in text mode so the transcript drawer's anchor (in
                  voice mode) doesn't fight for the same ref slot. */}
              <div ref={mode === "text" ? messagesEndRef : null} />
            </ul>
          </div>
          {/* "Scroll to bottom" pill — only visible when the user
              has scrolled up AND a new message has arrived since.
              Sits centred above the composer; the bottom offset
              matches the unified footer height so it floats just
              above the bar regardless of how tall the composer
              grew. Self-dismisses when the user scrolls back to
              the floor. */}
          {hasNewBelow && (
            <button
              type="button"
              onClick={scrollToLatest}
              aria-label="Scroll to latest message"
              className="amaso-fx amaso-press amaso-fade-in pointer-events-auto absolute left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-orange-500/40 bg-neutral-900/90 px-3.5 py-2 text-[12px] font-medium text-orange-200 shadow-[0_4px_16px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,107,61,0.15)] backdrop-blur hover:border-orange-400/60 hover:text-orange-100"
              style={{ bottom: bottomReserve + 8 }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="none"
                aria-hidden
              >
                <path
                  d="M6 2v7m0 0L3 6m3 3l3-3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              New messages
            </button>
          )}
          {/* Subtle phase indicator above the input so users know
              something's happening even without the central ring. */}
          {(busy || !ttsIdle || (inCall && listening && !micMuted)) && (
            <div className="flex-shrink-0 px-4 pb-1 flex items-center justify-center gap-1.5 text-[11px] text-neutral-500">
              <span className="inline-flex items-center gap-1" aria-hidden>
                <span className="amaso-thinking-dot" />
                <span className="amaso-thinking-dot" />
                <span className="amaso-thinking-dot" />
              </span>
              <span className="italic">
                {!ttsIdle
                  ? "speaking"
                  : busy
                    ? "thinking"
                    : "listening"}
              </span>
            </div>
          )}
        </div>
      </div>

      <AutopilotSidebar
        open={autopilotSidebarOpen}
        onClose={() => setAutopilotSidebarOpen(false)}
      />

      {/* Right-edge presence indicator. Only shows when autopilot is on
          AND the panel is closed — gives a subtle "loop is alive" cue
          without taking up footer space. Tap to open the panel. */}
      {autopilot && !autopilotSidebarOpen && (
        <button
          type="button"
          onClick={() => setAutopilotSidebarOpen(true)}
          aria-label="open autopilot panel"
          title="autopilot is on — open panel"
          className="fixed right-1.5 top-1/2 z-30 flex h-8 w-3 -translate-y-1/2 items-center justify-center rounded-l-md bg-orange-500/10 transition hover:bg-orange-500/20"
        >
          <span
            aria-hidden
            className="h-2 w-2 animate-pulse rounded-full bg-orange-400 shadow-[0_0_8px_rgba(255, 107, 61,0.85)]"
          />
        </button>
      )}

      <MobileControlsSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        mode={mode}
        inCall={inCall}
        onTelegram={onTelegram}
        previousChannel={voice.previousChannel}
        callTimeLabel={callTimeLabel}
        phase={phase}
        phaseDot={phaseDot}
        autopilot={autopilot}
        toggleAutopilot={toggleAutopilot}
        ttsMuted={ttsMuted}
        onSpeakerToggle={handleSpeakerToggle}
        endCall={endCall}
        openHeartbeat={() => {
          setHeartbeatOpen(true);
          setMenuOpen(false);
        }}
      />

      <HeartbeatPanel
        open={heartbeatOpen}
        onClose={() => setHeartbeatOpen(false)}
        userId={currentUser?.id ?? 0}
        initialBody={heartbeat}
        canManageOthers={canManageOthers}
        speakingUserId={speakingUserId}
        onSpeakerChange={(n) => void loadHeartbeatFor(n)}
        editorBody={heartbeat}
        setEditorBody={setHeartbeat}
        editorDirty={heartbeatDirty}
        setEditorDirty={setHeartbeatDirty}
        saving={savingHeartbeat}
        onSave={saveHeartbeat}
      />

      {/* Unified footer — single horizontal strip with media controls
          on the left, the chat composer flexing in the middle, and the
          mode/autopilot/heartbeat action buttons on the right. Fixed to
          the viewport bottom and clears the safe-area inset; chat
          surfaces above reserve `bottomReserve` so messages never sit
          behind it. The composer renders in text mode only — voice
          mode keeps its dock inside the voice column. Queue list and
          attachment previews stack above the row when text mode is
          active so the input row itself stays a single line. */}
      <div
        ref={unifiedFooterRef}
        className="pb-safe pointer-events-auto fixed inset-x-0 bottom-0 z-30 border-t border-neutral-800/80 bg-neutral-950/85 shadow-[0_-8px_32px_rgba(0,0,0,0.55)] backdrop-blur-md backdrop-saturate-150"
      >
        {mode === "text" && (queue.length > 0 || pendingAttachments.length > 0) && (
          <div className="mx-auto w-full max-w-3xl px-3 pt-2">
            <QueueList
              widthClass="max-w-3xl"
              queue={queue}
              busy={busy}
              ttsIdle={ttsIdle}
              onEdit={editQueued}
              onRemove={removeQueued}
            />
            <AttachmentPreviewBar
              attachments={pendingAttachments}
              onRemove={removeAttachment}
            />
          </div>
        )}
        {/* Three-section row.
            ┌──────────────────────────────────────────────────────┐
            │ media (left) │ composer (center, flex-1) │ actions   │
            └──────────────────────────────────────────────────────┘
            On phones (<640px) it stacks: media on its own line
            above, composer + actions sharing the line below — the
            three-up layout doesn't survive a 375px viewport without
            squeezing the input below readable width. From `sm:` up
            we switch to a 3-column grid with equal-flex side rails
            (`1fr` each) and a center column capped at `max-w-3xl`
            (768px). The equal side rails are what visually centers
            the composer between the screen edges even when the
            media row and the action cluster have different widths
            — without them, `flex-1` on the form would just stretch
            it across whatever space was left and the input would
            drift toward whichever side had less content. */}
        <div className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-3">
          {/* LEFT — media controls. `flex-shrink-0` is critical: media
              must never be squeezed below its natural width or the
              now-playing thumb / play / skip / volume / PiP buttons
              start clipping. The inner `min-w-0` only lets the title
              label truncate within the cap; the controls themselves
              stay full size. */}
          <div className="flex flex-shrink-0 items-center min-w-0 max-w-[14rem] sm:max-w-[18rem] sm:justify-self-start">
            <SparMediaRow compact />
          </div>

          {/* CENTER + RIGHT lane — on phones this wrapper holds the
              composer and the action cluster on a shared flex line
              (the second stacked row). From `sm:` up the wrapper
              becomes `display: contents` so its children (form +
              buttons) become direct flex items of the parent flex
              row, sitting next to the media block above. */}
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:contents">
            {/* CENTER — text composer (text mode only). `mx-auto
                max-w-3xl` caps the input on huge desktops so it
                doesn't stretch into one unreadable line. The
                composer holds only paperclip + textarea + send —
                speaker/TTS lives in the right cluster instead. */}
            {mode === "text" ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitDraft();
                }}
                className="relative mx-auto flex min-w-0 max-w-3xl flex-1 items-end gap-1.5 rounded-2xl border border-neutral-800 bg-neutral-900/70 px-2.5 py-1.5 shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-[border-color,box-shadow,background-color] duration-200 ease-out focus-within:border-orange-500/50 focus-within:bg-neutral-900/85 focus-within:shadow-[0_0_0_3px_rgba(255, 107, 61,0.12),0_1px_2px_rgba(0,0,0,0.25)]"
              >
                {slashOpen && (
                  <SlashCommandDropdown
                    matches={slashMatches}
                    selectedIndex={Math.min(
                      slashIndex,
                      Math.max(slashMatches.length - 1, 0),
                    )}
                    onSelect={applySlashCommand}
                    onHover={setSlashIndex}
                  />
                )}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  aria-label="Attach files"
                  title="Attach files"
                  className="amaso-fx amaso-press flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
                >
                  <Paperclip className="h-4 w-4" />
                </button>
                <textarea
                  ref={textareaRef}
                  rows={1}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    // Any edit re-opens a dismissed dropdown so a follow-up
                    // keystroke (e.g. typing more after Esc) can re-engage
                    // autocomplete without an explicit re-trigger.
                    setSlashDismissed(false);
                  }}
                  onKeyDown={(e) => {
                    if (slashOpen) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setSlashIndex(
                          (i) => (i + 1) % slashMatches.length,
                        );
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setSlashIndex(
                          (i) =>
                            (i - 1 + slashMatches.length) % slashMatches.length,
                        );
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setSlashDismissed(true);
                        return;
                      }
                      if (
                        e.key === "Enter" ||
                        e.key === " " ||
                        e.key === "Tab"
                      ) {
                        e.preventDefault();
                        const idx = Math.min(
                          slashIndex,
                          slashMatches.length - 1,
                        );
                        const cmd = slashMatches[idx];
                        if (cmd) applySlashCommand(cmd);
                        return;
                      }
                    }
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      submitDraft();
                    }
                  }}
                  placeholder={
                    busy || !ttsIdle
                      ? "type — will queue until ready…"
                      : "message your sparring partner…"
                  }
                  // transition-[height] eases the auto-grow on each
                  // keystroke that crosses a line boundary so the
                  // composer doesn't snap-resize. Cap at ~4 lines
                  // (160px) is enforced by the height-measure effect.
                  className="min-w-0 flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-neutral-100 placeholder-neutral-500 transition-[height] duration-150 ease-out focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={!draft.trim() && !pendingAttachments.length}
                  className="amaso-fx amaso-press flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-orange-500 text-neutral-950 shadow-[0_2px_8px_rgba(255, 107, 61,0.35)] hover:bg-orange-400 hover:shadow-[0_2px_12px_rgba(255, 107, 61,0.5)] disabled:bg-neutral-700 disabled:text-neutral-400 disabled:shadow-none"
                  aria-label="Send"
                >
                  <Send className="h-4 w-4" />
                </button>
              </form>
            ) : (
              <div className="flex-1 sm:hidden" />
            )}

            {/* RIGHT — autopilot, heartbeat, mode toggle, then the
                mobile menu trigger. The TTS mute toggle lives inside
                the media drawer (left column) — there is intentionally
                only one. Each button collapses to icon-only below
                `sm:` so the cluster fits next to the composer on
                phones. From `sm:` up the parent wrapper switches to
                `display: contents` so this div lands in column 3 of
                the grid — `justify-self-end` glues it to the right
                edge of that column. */}
            <div className="flex flex-shrink-0 items-center gap-1 sm:ml-auto sm:gap-1.5">
              <button
                type="button"
                onClick={toggleAutopilot}
                aria-pressed={autopilot}
                aria-label={
                  autopilot
                    ? "autopilot on — spar handles permission gates itself"
                    : "autopilot off — spar asks before acting"
                }
                title={
                  autopilot
                    ? "autopilot on — spar handles permission gates itself"
                    : "autopilot off — spar asks before acting"
                }
                className={`group inline-flex h-8 items-center gap-1.5 rounded-full border px-2 text-[11px] transition sm:px-3 ${
                  autopilot
                    ? "border-orange-400/60 bg-orange-500/15 text-orange-200 shadow-[0_0_18px_rgba(255, 107, 61,0.45)] hover:border-orange-300/80"
                    : "border-neutral-800 bg-neutral-900/80 text-neutral-300 hover:border-neutral-700 hover:text-neutral-200"
                }`}
              >
                <Zap
                  className={`h-3.5 w-3.5 ${
                    autopilot
                      ? "fill-orange-300 text-orange-300 animate-pulse"
                      : "text-neutral-500 group-hover:text-neutral-300"
                  }`}
                />
                <span className="hidden sm:inline">autopilot</span>
              </button>
              <button
                type="button"
                onClick={() => setAutopilotSidebarOpen(true)}
                aria-label="open autopilot panel"
                title="autopilot controls"
                className="inline-flex h-8 w-7 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900/80 text-neutral-500 transition hover:border-neutral-700 hover:text-neutral-200"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setHeartbeatOpen((v) => !v)}
                aria-label={heartbeatOpen ? "close heartbeat" : "open heartbeat"}
                aria-pressed={heartbeatOpen}
                title={heartbeatOpen ? "close heartbeat" : "open heartbeat"}
                className={`relative inline-flex h-8 items-center gap-1.5 rounded-full border px-2 text-[11px] transition sm:px-3 ${
                  heartbeatOpen
                    ? "border-orange-400/60 bg-orange-500/15 text-orange-100 shadow-[0_0_18px_rgba(255, 107, 61,0.35)]"
                    : "border-neutral-800 bg-neutral-900/80 text-neutral-300 hover:border-neutral-700 hover:text-neutral-200"
                }`}
              >
                <Activity className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">heartbeat</span>
                {latestTick && (
                  <span
                    aria-hidden
                    title={
                      latestTick.status === "ok"
                        ? "last tick: ok"
                        : latestTick.notified
                          ? "last tick: alert pushed"
                          : "last tick: alert (silent)"
                    }
                    className={`absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full ${
                      latestTick.status === "ok"
                        ? "bg-orange-400"
                        : latestTick.notified
                          ? "bg-amber-400 animate-pulse"
                          : "bg-amber-400/70"
                    } shadow-[0_0_6px_currentColor]`}
                  />
                )}
              </button>
              <button
                type="button"
                onClick={() => setMode((m) => (m === "text" ? "voice" : "text"))}
                aria-pressed={mode === "voice"}
                aria-label={
                  mode === "text"
                    ? "switch to voice mode"
                    : "switch to text mode"
                }
                title={
                  mode === "text"
                    ? "switch to voice mode"
                    : "switch to text mode"
                }
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-900/80 px-2 text-[11px] text-neutral-300 hover:border-neutral-700 hover:text-neutral-200 sm:px-3"
              >
                {mode === "text" ? (
                  <Mic className="h-3.5 w-3.5" />
                ) : (
                  <MessageSquare className="h-3.5 w-3.5" />
                )}
                <span className="hidden sm:inline">
                  {mode === "text" ? "voice" : "text"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => setMenuOpen(true)}
                aria-label="open controls"
                title="open controls"
                className="relative inline-flex h-8 w-8 items-center justify-center rounded-full border border-neutral-800 bg-neutral-900/80 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100 md:hidden"
              >
                <Menu className="h-4 w-4" />
                {(inCall || onTelegram || autopilot) && (
                  <span
                    aria-hidden
                    className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ${
                      inCall
                        ? "bg-rose-400"
                        : onTelegram
                          ? "bg-sky-400"
                          : "bg-orange-400"
                    } animate-pulse shadow-[0_0_8px_currentColor]`}
                  />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Subtle "this chat has drifted" banner. Server-side drift detection
 * sets the message; the user dismisses it here, optionally starting a
 * new chat in the same gesture. Renders just below the dispatch
 * banner so it stays inside the chat column without obscuring the
 * media row underneath.
 */
function DriftHintBanner({
  message,
  onDismiss,
  onStartNewChat,
}: {
  message: string;
  onDismiss: () => void;
  onStartNewChat: () => void;
}) {
  return (
    <div className="mx-4 mb-2 flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-xs text-amber-100">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-300" />
      <div className="min-w-0 flex-1">
        <div className="text-[10px] uppercase tracking-[0.18em] text-amber-300/80">
          topic drift
        </div>
        <div className="mt-1 leading-snug whitespace-pre-wrap text-amber-50/90">
          {message}
        </div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onStartNewChat}
          className="rounded-md border border-amber-400/40 bg-amber-900/30 px-2 py-1 text-[11px] text-amber-100 transition hover:bg-amber-800/50"
        >
          new chat
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md p-1 text-amber-300/80 transition hover:bg-amber-900/40 hover:text-amber-100"
          aria-label="dismiss drift hint"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function DispatchBanner({ dispatch }: { dispatch: Dispatch }) {
  const tone =
    dispatch.status === "sent"
      ? "border-orange-500/40 bg-orange-950/40 text-orange-100"
      : "border-red-500/40 bg-red-950/40 text-red-100";
  const label =
    dispatch.status === "sent" ? "just sent to project" : "dispatch failed";
  const preview =
    dispatch.prompt.length > 160
      ? dispatch.prompt.slice(0, 160) + "…"
      : dispatch.prompt;
  return (
    <div className={`mx-4 mb-2 rounded-2xl border px-3 py-2 text-xs ${tone}`}>
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] opacity-70">
        <span>{label}</span>
        <span className="ml-auto font-mono text-[10px] opacity-60">
          {dispatch.projectId}
        </span>
      </div>
      <div className="mt-1 text-sm leading-snug whitespace-pre-wrap">
        {preview}
      </div>
      {dispatch.error && (
        <div className="mt-1 text-[11px] opacity-80">{dispatch.error}</div>
      )}
    </div>
  );
}

function QueueList({
  widthClass,
  queue,
  busy,
  ttsIdle,
  onEdit,
  onRemove,
}: {
  widthClass: string;
  queue: { id: number; text: string }[];
  busy: boolean;
  ttsIdle: boolean;
  onEdit: (id: number) => void;
  onRemove: (id: number) => void;
}) {
  if (queue.length === 0) return null;
  const status = !ttsIdle
    ? "waiting for tts"
    : busy
      ? "waiting for agent"
      : "sending…";
  return (
    <div
      className={`mx-auto mb-2 flex ${widthClass} flex-col gap-1 rounded-xl border border-neutral-800/70 bg-neutral-900/40 px-2 py-1.5`}
    >
      <div className="flex items-center justify-between px-1 text-[10px] uppercase tracking-[0.18em] text-neutral-500">
        <span>queued · {queue.length}</span>
        <span className="text-[10px] italic tracking-normal normal-case text-neutral-600">
          {status}
        </span>
      </div>
      {queue.map((item) => (
        <div
          key={item.id}
          className="flex items-start gap-2 rounded-lg bg-neutral-900/70 px-2.5 py-1.5 text-[12px] leading-snug text-neutral-300"
        >
          <span className="flex-1 break-words whitespace-pre-wrap">
            {item.text}
          </span>
          <button
            type="button"
            onClick={() => onEdit(item.id)}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title="edit"
            aria-label="edit"
          >
            <Pencil className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-800 hover:text-rose-300"
            title="remove"
            aria-label="remove"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

function CallButton({
  children,
  onClick,
  active = false,
  tone = "neutral",
  size = "md",
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  tone?: "neutral" | "red" | "green";
  size?: "md" | "lg";
  label?: string;
}) {
  const toneClasses =
    tone === "red"
      ? "bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-900/40"
      : tone === "green"
        ? "bg-orange-600 hover:bg-orange-500 text-white shadow-lg shadow-orange-900/40"
        : active
          ? "bg-neutral-200 text-neutral-900"
          : "bg-neutral-800 text-neutral-400";
  const sizeClasses = size === "lg" ? "h-16 w-16" : "h-14 w-14";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex flex-col items-center gap-1"
    >
      <span
        className={`flex items-center justify-center rounded-full transition ${sizeClasses} ${toneClasses}`}
      >
        {children}
      </span>
      {label && (
        <span className="text-[11px] uppercase tracking-[0.18em] text-neutral-400">
          {label}
        </span>
      )}
    </button>
  );
}

/**
 * Mobile-only bottom sheet that holds every secondary control the
 * desktop header shows inline. Slides up from the bottom over a
 * dimmed backdrop, full width, rounded top corners. The trigger lives
 * in the header (hamburger button visible only below md). Keeping the
 * sheet structurally separate from `SideDrawer` (right slide-in) lets
 * each animate independently without prop gymnastics.
 */
function MobileControlsSheet({
  open,
  onClose,
  mode,
  inCall,
  onTelegram,
  previousChannel,
  callTimeLabel,
  phase,
  phaseDot,
  autopilot,
  toggleAutopilot,
  ttsMuted,
  onSpeakerToggle,
  endCall,
  openHeartbeat,
}: {
  open: boolean;
  onClose: () => void;
  mode: "text" | "voice";
  inCall: boolean;
  onTelegram: boolean;
  previousChannel: string | null;
  callTimeLabel: string;
  phase: "speaking" | "thinking" | "listening" | null;
  phaseDot: string;
  autopilot: boolean;
  toggleAutopilot: () => void;
  ttsMuted: boolean;
  onSpeakerToggle: () => void;
  endCall: () => void;
  openHeartbeat: () => void;
}) {
  return (
    <div
      className={`fixed inset-0 z-50 md:hidden ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label="close"
        tabIndex={-1}
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 transition-opacity ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        className={`pb-safe absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col overflow-hidden rounded-t-2xl border-t border-neutral-800 bg-neutral-950 shadow-2xl transition-transform duration-300 ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
      >
        {/* Drag handle / title row */}
        <div className="flex flex-shrink-0 items-center gap-2 px-4 pb-2 pt-3">
          <span
            aria-hidden
            className="mx-auto block h-1 w-10 rounded-full bg-neutral-700"
          />
        </div>
        <div className="flex flex-shrink-0 items-center gap-2 px-4 pb-3">
          <span className="text-xs uppercase tracking-[0.22em] text-neutral-500">
            controls
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto flex h-8 w-8 items-center justify-center rounded-full text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col gap-3 px-4 pb-6">
            {/* Live-call state surfaces first so the user can end the
                call without scrolling through everything else. */}
            {(onTelegram || (mode === "text" && inCall)) && (
              <div className="flex flex-col gap-2 rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
                {onTelegram && (
                  <div
                    title={
                      previousChannel
                        ? `call is on Telegram (continued from ${previousChannel})`
                        : "call is on Telegram — same session, speakerphone swapped for the phone"
                    }
                    className="flex items-center gap-2 rounded-lg border border-sky-400/60 bg-sky-500/15 px-3 py-2 text-xs font-medium text-sky-200"
                  >
                    <Radio className="h-3.5 w-3.5 animate-pulse" />
                    <span>{phase ? `${phase} on Telegram` : "on Telegram"}</span>
                    <span
                      aria-hidden
                      className={`ml-auto inline-block h-1.5 w-1.5 rounded-full ${phaseDot} ${phase ? "animate-pulse" : ""}`}
                    />
                  </div>
                )}
                {mode === "text" && inCall && (
                  <button
                    type="button"
                    onClick={() => {
                      endCall();
                      onClose();
                    }}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-rose-400/60 bg-rose-500/15 px-3 py-2.5 text-sm font-medium text-rose-100 hover:bg-rose-500/25"
                  >
                    <PhoneOff className="h-4 w-4" />
                    <span>End call</span>
                    <span className="ml-auto font-mono tabular-nums text-xs text-rose-200/80">
                      {callTimeLabel}
                    </span>
                  </button>
                )}
              </div>
            )}

            {/* Toggles section */}
            <div className="flex flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40">
              <button
                type="button"
                onClick={toggleAutopilot}
                aria-pressed={autopilot}
                className="flex items-center gap-3 px-4 py-3 text-left transition hover:bg-neutral-900/80"
              >
                <Zap
                  className={`h-4 w-4 flex-shrink-0 ${
                    autopilot
                      ? "fill-orange-300 text-orange-300"
                      : "text-neutral-500"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-neutral-100">Autopilot</div>
                  <div className="text-[11px] text-neutral-500">
                    {autopilot
                      ? "spar handles permission gates itself"
                      : "spar asks before acting"}
                  </div>
                </div>
                <span
                  className={`flex h-6 w-10 flex-shrink-0 items-center rounded-full p-0.5 transition ${
                    autopilot ? "bg-orange-500/80" : "bg-neutral-700"
                  }`}
                >
                  <span
                    className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${
                      autopilot ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </span>
              </button>
              <div className="h-px bg-neutral-800" />
              <button
                type="button"
                onClick={onSpeakerToggle}
                aria-pressed={!ttsMuted}
                className="flex items-center gap-3 px-4 py-3 text-left transition hover:bg-neutral-900/80"
              >
                {ttsMuted ? (
                  <VolumeX className="h-4 w-4 flex-shrink-0 text-neutral-500" />
                ) : (
                  <Volume2 className="h-4 w-4 flex-shrink-0 text-neutral-300" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-neutral-100">Speaker</div>
                  <div className="text-[11px] text-neutral-500">
                    {ttsMuted
                      ? "TTS muted — replies are silent"
                      : "TTS on — replies are spoken"}
                  </div>
                </div>
                <span
                  className={`flex h-6 w-10 flex-shrink-0 items-center rounded-full p-0.5 transition ${
                    !ttsMuted ? "bg-neutral-300" : "bg-neutral-700"
                  }`}
                >
                  <span
                    className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${
                      !ttsMuted ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </span>
              </button>
            </div>

            {/* Drawer entry-points */}
            <div className="flex flex-col overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40">
              <button
                type="button"
                onClick={openHeartbeat}
                className="flex items-center gap-3 px-4 py-3 text-left transition hover:bg-neutral-900/80"
              >
                <FileText className="h-4 w-4 flex-shrink-0 text-neutral-400" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-neutral-100">Heartbeat</div>
                  <div className="text-[11px] text-neutral-500">
                    what's on your plate, shared with spar
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 flex-shrink-0 text-neutral-600" />
              </button>
            </div>

            {/* Workers panel moved out of this sheet entirely — it
                now lives in the spar sidebar so mobile users open it
                with the hamburger toggle, not the controls sheet. */}
          </div>
        </div>
      </div>
    </div>
  );
}

