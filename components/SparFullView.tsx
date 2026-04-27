"use client";

import { useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Radio,
  Save,
  Send,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react";
import { useSpar, MAX_TRANSCRIPT, type Dispatch } from "./SparContext";
import SparAudioVisualizer from "./SparAudioVisualizer";
import SparMiniPlayer from "./SparMiniPlayer";
import WorkerStatusPanel from "./WorkerStatusPanel";
import { useVoiceChannel } from "./useVoiceChannel";

type Mode = "text" | "voice";

export default function SparFullView() {
  const {
    currentUser: _currentUser,
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
    sendMessage,
    saveHeartbeat,
    loadHeartbeatFor,
    clearTranscript,
  } = useSpar();
  void _currentUser;

  const [draft, setDraft] = useState("");
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [heartbeatOpen, setHeartbeatOpen] = useState(false);
  // Default to text mode — the page now opens like a normal chat app
  // and lets the user toggle into voice mode (which keeps the existing
  // ring + call dock UI verbatim). State is local to this view; the
  // underlying call/audio infrastructure in SparContext doesn't care
  // which mode is rendered, so toggling never disturbs an active call.
  const [mode, setMode] = useState<Mode>("text");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  // Auto-scroll the active chat surface to the latest message. The
  // shared messagesEndRef is rendered inside the text-mode chat list
  // (and inside the transcript drawer when it's open). On mode changes
  // we also nudge it so switching from voice → text lands at the
  // bottom of the conversation.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, messagesEndRef]);
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [mode, messagesEndRef]);

  // Auto-grow the text-mode composer up to a cap so multi-line drafts
  // don't get cut off but can't push the input past ~6 lines either.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [draft, mode]);

  function submitDraft() {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    void sendMessage(text);
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-gradient-to-b from-neutral-950 via-neutral-900 to-black text-neutral-100">
      {/* Header chrome — present in both modes */}
      <div className="pt-safe pl-safe pr-safe flex items-center gap-2 px-4 py-3">
        <div className="flex flex-col">
          <span className="text-[11px] uppercase tracking-[0.18em] text-neutral-500">
            sparring partner
          </span>
          <span className="text-sm text-neutral-300">
            Opus 4.6 · {mode === "voice" ? "voice mode" : "text mode"}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2 text-neutral-400">
          {onTelegram && (
            <span
              title={
                voice.previousChannel
                  ? `call is on Telegram (continued from ${voice.previousChannel})`
                  : "call is on Telegram — same session, speakerphone swapped for the phone"
              }
              className="inline-flex items-center gap-1.5 rounded-full border border-sky-400/60 bg-sky-500/15 px-3 py-1 text-[11px] font-medium text-sky-200 shadow-[0_0_18px_rgba(56,189,248,0.3)]"
            >
              <Radio className="h-3 w-3 animate-pulse" />
              <span>{phase ? `${phase} on Telegram` : "on Telegram"}</span>
              <span
                aria-hidden
                className={`inline-block h-1.5 w-1.5 rounded-full ${phaseDot} ${phase ? "animate-pulse" : ""}`}
              />
            </span>
          )}
          {/* In-call hangup pill — only surfaces in text mode so the
              user can end an active call without switching back. Voice
              mode already exposes the big red end-call button. */}
          {mode === "text" && inCall && (
            <button
              type="button"
              onClick={endCall}
              title={`live · ${callTimeLabel} · click to end`}
              className="inline-flex items-center gap-1.5 rounded-full border border-rose-400/60 bg-rose-500/15 px-3 py-1 text-[11px] font-medium text-rose-100 shadow-[0_0_18px_rgba(244,63,94,0.25)] hover:bg-rose-500/25"
            >
              <PhoneOff className="h-3 w-3" />
              <span className="font-mono tabular-nums">{callTimeLabel}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode((m) => (m === "text" ? "voice" : "text"))}
            aria-pressed={mode === "voice"}
            title={
              mode === "text" ? "switch to voice mode" : "switch to text mode"
            }
            className="inline-flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-900/60 px-3 py-1 text-[11px] hover:border-neutral-700 hover:text-neutral-200"
          >
            {mode === "text" ? (
              <Mic className="h-3 w-3" />
            ) : (
              <MessageSquare className="h-3 w-3" />
            )}
            <span>{mode === "text" ? "voice" : "text"}</span>
          </button>
          <button
            type="button"
            onClick={toggleAutopilot}
            aria-pressed={autopilot}
            title={
              autopilot
                ? "autopilot on — spar handles permission gates itself"
                : "autopilot off — spar asks before acting"
            }
            className={`group flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] transition ${
              autopilot
                ? "border-emerald-400/60 bg-emerald-500/15 text-emerald-200 shadow-[0_0_18px_rgba(16,185,129,0.45)] hover:border-emerald-300/80"
                : "border-neutral-800 bg-neutral-900/60 hover:border-neutral-700 hover:text-neutral-200"
            }`}
          >
            <Zap
              className={`h-3 w-3 ${
                autopilot
                  ? "fill-emerald-300 text-emerald-300 animate-pulse"
                  : "text-neutral-500 group-hover:text-neutral-300"
              }`}
            />
            autopilot
          </button>
          {/* Transcript button is only useful in voice mode — in text
              mode the transcript is the page itself. */}
          {mode === "voice" && (
            <button
              type="button"
              onClick={() => setTranscriptOpen(true)}
              className="rounded-full border border-neutral-800 bg-neutral-900/60 px-3 py-1 text-[11px] hover:border-neutral-700 hover:text-neutral-200"
            >
              transcript
            </button>
          )}
          <button
            type="button"
            onClick={() => setHeartbeatOpen(true)}
            className="rounded-full border border-neutral-800 bg-neutral-900/60 px-3 py-1 text-[11px] hover:border-neutral-700 hover:text-neutral-200"
          >
            heartbeat
          </button>
        </div>
      </div>

      {lastDispatch && Date.now() - lastDispatch.confirmedAt < 30_000 && (
        <DispatchBanner dispatch={lastDispatch} />
      )}

      <SparMiniPlayer />

      {/* Mission-control feed for active workers — visible in both
          modes. Sits above the mode-switching area so it pins to the
          top of the page regardless of whether the body is showing
          chat or the central ring. */}
      <WorkerStatusPanel />

      {/* Mode-switching body. Both views are kept mounted and
          crossfaded via opacity so the audio analyser, ring animation,
          and chat scroll position never re-mount when toggling. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* ── Voice mode ────────────────────────────────────────── */}
        <div
          className={`absolute inset-0 flex flex-col transition-opacity duration-300 ${
            mode === "voice" ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          aria-hidden={mode !== "voice"}
        >
          {/* Flex-1 spacer so the dock sits at the bottom of the
              column and the ring centres in the empty space above. */}
          <div className="flex-1" />
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
          <div className="pb-safe flex flex-col items-center gap-3 px-6 pb-6">
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
                  onClick={toggleTtsMute}
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
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitDraft();
              }}
              className="mt-2 flex w-full max-w-sm items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-sm"
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={busy ? "thinking…" : "type instead…"}
                disabled={busy}
                className="flex-1 bg-transparent text-neutral-200 placeholder-neutral-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={busy || !draft.trim()}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-700 text-neutral-100 transition disabled:opacity-40"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>

        {/* ── Text mode ─────────────────────────────────────────── */}
        <div
          className={`absolute inset-0 flex flex-col transition-opacity duration-300 ${
            mode === "text" ? "opacity-100" : "pointer-events-none opacity-0"
          }`}
          aria-hidden={mode !== "text"}
        >
          <div className="flex items-center gap-2 border-b border-neutral-900/80 px-4 py-2 text-[11px] text-neutral-500">
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
          <div className="flex-1 overflow-y-auto">
            <ul className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6">
              {messages.length === 0 && (
                <li className="mt-12 text-center text-sm text-neutral-500">
                  type below to chat — or hit{" "}
                  <span className="rounded border border-neutral-800 px-1.5 py-0.5 font-mono text-[11px]">
                    voice
                  </span>{" "}
                  to call.
                </li>
              )}
              {messages.map((m) => (
                <li
                  key={m.id}
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                    m.role === "user"
                      ? "self-end bg-emerald-700/30 text-emerald-50"
                      : "self-start bg-neutral-800/70 text-neutral-100"
                  }`}
                >
                  {m.content || (busy && m.role === "assistant" ? "…" : "")}
                </li>
              ))}
              {/* Live STT preview — shows what the user is saying
                  while a voice call streams into text mode. Faded so
                  it reads as not-yet-committed. */}
              {interimText && (
                <li className="max-w-[85%] self-end rounded-2xl bg-emerald-700/15 px-4 py-2.5 text-sm italic leading-relaxed text-emerald-100/70">
                  {interimText}
                </li>
              )}
              {/* Anchor for auto-scroll. Only attaches the shared ref
                  in text mode so the transcript drawer's anchor (in
                  voice mode) doesn't fight for the same ref slot. */}
              <div ref={mode === "text" ? messagesEndRef : null} />
            </ul>
          </div>
          {/* Subtle phase indicator above the input so users know
              something's happening even without the central ring. */}
          {(busy || !ttsIdle || (inCall && listening && !micMuted)) && (
            <div className="px-4 pb-1 text-center text-[11px] italic text-neutral-500">
              {!ttsIdle
                ? "speaking…"
                : busy
                  ? "thinking…"
                  : "listening…"}
            </div>
          )}
          <div className="pb-safe border-t border-neutral-900/80 bg-neutral-950/70 px-4 pb-4 pt-3 backdrop-blur">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                submitDraft();
              }}
              className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-neutral-800 bg-neutral-900/60 px-3 py-2 transition focus-within:border-neutral-700"
            >
              <textarea
                ref={textareaRef}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter adds a newline. Skip
                  // submit while an IME composition is in flight so
                  // Japanese/Chinese input methods aren't broken.
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
                  busy ? "thinking…" : "message your sparring partner…"
                }
                disabled={busy}
                className="flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed text-neutral-100 placeholder-neutral-500 focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setMode("voice")}
                aria-label="switch to voice mode"
                title="voice mode"
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-neutral-400 transition hover:bg-neutral-800 hover:text-neutral-200"
              >
                <Mic className="h-4 w-4" />
              </button>
              <button
                type="submit"
                disabled={busy || !draft.trim()}
                className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-neutral-200 text-neutral-900 transition hover:bg-white disabled:opacity-40"
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      </div>

      <SideDrawer
        open={transcriptOpen}
        onClose={() => setTranscriptOpen(false)}
        title="transcript"
      >
        <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
          <span>
            {messages.length} / {MAX_TRANSCRIPT}
          </span>
          <button
            type="button"
            disabled={messages.length === 0}
            onClick={clearTranscript}
            className="ml-auto rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-red-500 hover:text-red-200 disabled:opacity-40"
          >
            clear
          </button>
        </div>
        <ul className="flex flex-col gap-3 p-4">
          {messages.length === 0 && (
            <li className="text-sm text-neutral-500">no messages yet</li>
          )}
          {messages.map((m) => (
            <li
              key={m.id}
              className={`max-w-[90%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === "user"
                  ? "self-end bg-emerald-700/30 text-emerald-50"
                  : "self-start bg-neutral-800/70 text-neutral-100"
              }`}
            >
              {m.content || (busy && m.role === "assistant" ? "…" : "")}
            </li>
          ))}
          {/* Drawer's auto-scroll anchor: only attaches when text mode
              isn't using the shared ref, otherwise React's last-write-
              wins ref handling causes the two to clobber each other. */}
          <div ref={mode === "voice" ? messagesEndRef : null} />
        </ul>
      </SideDrawer>

      <SideDrawer
        open={heartbeatOpen}
        onClose={() => setHeartbeatOpen(false)}
        title="heartbeat"
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
            {canManageOthers && (
              <label className="flex items-center gap-1 text-[11px] text-neutral-500">
                user
                <input
                  type="number"
                  min={1}
                  value={speakingUserId}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n) && n > 0) void loadHeartbeatFor(n);
                  }}
                  className="w-16 rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-right text-[11px] text-neutral-200"
                />
              </label>
            )}
            <button
              type="button"
              disabled={!heartbeatDirty || savingHeartbeat}
              onClick={() => void saveHeartbeat()}
              className="ml-auto flex items-center gap-1 rounded border border-neutral-700 px-2 py-0.5 text-[11px] text-neutral-200 hover:border-neutral-600 disabled:opacity-40"
            >
              <Save className="h-3 w-3" /> {savingHeartbeat ? "…" : "save"}
            </button>
          </div>
          <textarea
            value={heartbeat}
            onChange={(e) => {
              setHeartbeat(e.target.value);
              setHeartbeatDirty(true);
            }}
            spellCheck={false}
            className="flex-1 resize-none bg-neutral-950 px-3 py-2 font-mono text-[12px] leading-relaxed text-neutral-200 focus:outline-none"
            placeholder={"# What's on my plate\n\n- "}
          />
        </div>
      </SideDrawer>
    </div>
  );
}

function DispatchBanner({ dispatch }: { dispatch: Dispatch }) {
  const tone =
    dispatch.status === "sent"
      ? "border-emerald-500/40 bg-emerald-950/40 text-emerald-100"
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
        ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/40"
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

function SideDrawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`fixed inset-0 z-40 ${open ? "" : "pointer-events-none"}`}
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
        className={`absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-neutral-950 shadow-xl transition-transform ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3 text-sm">
          <span className="text-xs uppercase tracking-[0.22em] text-neutral-500">
            {title}
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
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
