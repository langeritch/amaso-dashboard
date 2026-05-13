"use client"
import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import type { ChatMsg, DayCard, Project, Subject, MobileAttachment, MobileToolStep, Tweaks } from "./types"
import { AmasoMark, IconBolt, IconExpand, IconArrowUp, IconMic, IconClose, IconFile, IconCalendar, IconPlus, IconCopy, IconVolume, IconShare } from "./icons"
import MobileVoice from "./voice"
import AssistantMarkdown from "../AssistantMarkdown"
import { TopicPill } from "../TopicPill"

// ── Chat screen ──────────────────────────────────────────────────────────────

interface ChatScreenProps {
  messages: ChatMsg[]
  setMessages: React.Dispatch<React.SetStateAction<ChatMsg[]>>
  project: Project | null
  autopilot: boolean
  onLeft: () => void
  onRight: () => void
  onReview?: () => void
  rightIcon?: "bolt" | "expand"
  headerCenter?: React.ReactNode
  placeholder?: string
  tweaks?: Tweaks
  onSend?: (text: string) => void
  attachments?: MobileAttachment[]
  onAddAttachments?: (files: FileList) => void
  onRemoveAttachment?: (id: string) => void
  conversationIdRef?: React.MutableRefObject<number | null>
  setConversationId?: (id: number) => void
  /** Stable per-browser PWA device id (lives in localStorage on the
   *  device). Same id is shared with the AudioLegBanner. */
  pwaDeviceId?: string
  /** Live TTS playback element for typewriter sync. When the audio
   *  element is playing, the typewriter reveals characters in
   *  proportion to currentTime/duration so the visible text matches
   *  the spoken pace. */
  ttsAudioRef?: React.MutableRefObject<HTMLAudioElement | null>
  /** Whether TTS audio is currently playing. */
  ttsPlaying?: boolean
  /** Message id whose text is currently being spoken (or just
   *  finished). Drives the per-message "animate or snap" decision
   *  inside ChatMessage. */
  ttsAiId?: number | null
  /** Topic scope for the current composer. When set, a TopicPill
   *  renders above the textarea and the parent's send handler
   *  includes topicId on the /api/spar POST. */
  activeTopic?: { id: number; slug: string; title: string } | null
  /** Clear the active topic pill. */
  onClearTopic?: () => void
}

export function ChatScreen({
  messages,
  setMessages,
  project,
  autopilot,
  onLeft,
  onRight,
  onReview,
  rightIcon = "bolt",
  headerCenter,
  placeholder,
  tweaks,
  onSend,
  attachments,
  onAddAttachments,
  onRemoveAttachment,
  conversationIdRef,
  setConversationId,
  pwaDeviceId,
  ttsAudioRef,
  ttsPlaying,
  ttsAiId,
  activeTopic,
  onClearTopic,
}: ChatScreenProps) {
  const [draft, setDraft] = useState("")
  const [voice, setVoice] = useState(false)
  const [menuMorph, setMenuMorph] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Per-message ref map so we can scroll a specific bubble's TOP
  // into view when it first appears (rather than slamming the feed
  // to the bottom on every content tick — which loses the start of
  // long replies).
  const bubbleRefs = useRef<Map<string | number, HTMLDivElement | null>>(new Map())
  // Track the previous tail-AI message id. When it changes we know a
  // new assistant bubble just arrived; that's the only time we
  // scroll. Content updates on the same bubble are ignored so the
  // user can read from the top.
  const prevTailAiIdRef = useRef<string | number | null>(null)

  const handleMenuClick = useCallback(() => {
    if (menuMorph) return
    setMenuMorph(true)
    setTimeout(() => onLeft(), 320)
    setTimeout(() => setMenuMorph(false), 720)
  }, [menuMorph, onLeft])

  // Scroll strategy:
  //   - On user message: scroll to bottom (the composer is there).
  //   - On a NEW assistant message: scroll TOP of that bubble into
  //     view (block: "start") so the user reads from the beginning.
  //   - During subsequent content streams on the same assistant
  //     bubble: do not scroll. The typewriter will reveal text in
  //     place and the user controls their own scroll.
  useEffect(() => {
    if (messages.length === 0) return
    const last = messages[messages.length - 1]
    if (last.role === "user") {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
      return
    }
    // last.role === "ai"
    if (last.id === prevTailAiIdRef.current) {
      // Same bubble, content update — no scroll.
      return
    }
    prevTailAiIdRef.current = last.id
    // Defer to next frame so the element is in the DOM.
    requestAnimationFrame(() => {
      const el = bubbleRefs.current.get(last.id)
      if (!el) {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight
        }
        return
      }
      try {
        el.scrollIntoView({ behavior: "smooth", block: "start" })
      } catch {
        // Older browsers may not support smooth; fall back to default.
        try { el.scrollIntoView({ block: "start" }) } catch { /* ignore */ }
      }
    })
  }, [messages])

  const send = useCallback((text?: string) => {
    const t = (text ?? draft).trim()
    if (!t && (!attachments || attachments.length === 0)) return
    if (onSend) {
      onSend(t)
      setDraft("")
      return
    }
    const now = new Date()
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`
    setMessages([
      ...messages,
      { id: Date.now(), role: "user", time, content: t },
      { id: Date.now() + 1, role: "ai", time, content: "ack. one sec." },
    ])
    setDraft("")
  }, [draft, messages, setMessages, onSend, attachments])

  const layout = tweaks?.layout ?? "compact"
  const density = tweaks?.density ?? "default"
  const headerH = layout === "spacious" ? 76 : 60
  const hasAttachments = attachments && attachments.length > 0
  return (
    <div className="amaso-screen">
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, zIndex: 30,
        background: "linear-gradient(to bottom, var(--bg-0) 70%, transparent)",
        padding: "env(safe-area-inset-top, 0px) 12px 10px",
      }}>
        <div className="row gap-2" style={{ height: 44 }}>
          <button
            onClick={handleMenuClick}
            className="btn-icon"
            style={{
              width: "auto",
              padding: "0 12px",
              // Match the header content row (44px) exactly so the
              // AMASO// logo sits flush with the rest of the header,
              // no vertical gap above/below the button background.
              height: 44,
              display: "flex",
              alignItems: "center",
            }}
            title="Menu"
          >
            {/* data-amaso-header-logo is the FLIP target for the AmasoIntro
                overlay (components/AmasoIntro.tsx). The intro measures
                this span's bounding rect at the morph handoff and writes
                the coords into CSS vars on its own wordmark, so the
                centered AMASO// shrinks + slides into this exact slot
                before the overlay fades out. */}
            <span
              data-amaso-header-logo
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              <AmasoMark size={14} gap={7} color="var(--fg)" morph={menuMorph} />
            </span>
          </button>
          {headerCenter
            ? <div style={{ flex: 1, minWidth: 0 }}>{headerCenter}</div>
            : <div style={{ flex: 1 }} />}
          {onReview && (
            <button onClick={onReview} className="btn-icon" title="Daily review">
              <IconCalendar size={16} stroke={1.6} />
            </button>
          )}
          <button
            onClick={onRight}
            className="btn-icon"
            data-on={rightIcon === "bolt" && autopilot ? "1" : "0"}
            title={rightIcon === "expand" ? "View transcript" : "Autopilot"}
          >
            {rightIcon === "expand"
              ? <IconExpand size={16} stroke={1.7} />
              : <IconBolt size={18} stroke={1.6} />}
          </button>
        </div>
        {layout === "spacious" && (
          <div className="t-mono" style={{ padding: "4px 6px", fontSize: 10, color: "var(--fg-4)", letterSpacing: "0.12em", textTransform: "uppercase" }}>
            SPAR
          </div>
        )}
      </div>

      <div
        ref={scrollRef}
        className="amaso-scroll"
        style={{
          paddingTop: `calc(env(safe-area-inset-top, 0px) + ${headerH + 4}px)`,
          // Pad the bottom by the composer's intrinsic height PLUS the
          // iOS home-indicator inset so the last message never scrolls
          // under the home-bar-cleared composer. Mirrors the composer's
          // `calc(12px + env(safe-area-inset-bottom))` padding-bottom.
          paddingBottom: hasAttachments
            ? "calc(239px + env(safe-area-inset-bottom, 0px))"
            : "calc(199px + env(safe-area-inset-bottom, 0px))",
        }}
      >
        {layout === "focus"
          ? <FocusLayout messages={messages} />
          : <BubbleLayout
              messages={messages}
              variant={layout}
              density={density}
              tweaks={tweaks}
              bubbleRefs={bubbleRefs}
              ttsAudioRef={ttsAudioRef}
              ttsPlaying={ttsPlaying}
              ttsAiId={ttsAiId}
            />}
      </div>

      <Composer
        draft={draft}
        setDraft={setDraft}
        voice={voice}
        setVoice={setVoice}
        onSend={send}
        autopilot={autopilot}
        layout={layout}
        placeholder={placeholder}
        attachments={attachments}
        onAddAttachments={onAddAttachments}
        onRemoveAttachment={onRemoveAttachment}
        activeTopic={activeTopic ?? null}
        onClearTopic={onClearTopic}
      />

      {voice && tweaks && conversationIdRef && setConversationId && pwaDeviceId && (
        <MobileVoice
          onClose={() => setVoice(false)}
          tweaks={tweaks}
          conversationIdRef={conversationIdRef}
          setConversationId={setConversationId}
          messages={messages}
          setMessages={setMessages}
          deviceId={pwaDeviceId}
        />
      )}
    </div>
  )
}

// ── Bubble layout ────────────────────────────────────────────────────────────

function BubbleLayout({
  messages, variant, density, tweaks, bubbleRefs, ttsAudioRef, ttsPlaying, ttsAiId,
}: {
  messages: ChatMsg[]
  variant: string
  density: string
  tweaks?: Tweaks
  bubbleRefs: React.MutableRefObject<Map<string | number, HTMLDivElement | null>>
  ttsAudioRef?: React.MutableRefObject<HTMLAudioElement | null>
  ttsPlaying?: boolean
  ttsAiId?: number | null
}) {
  const padY = density === "tight" ? 6 : density === "loose" ? 14 : 9
  const padX = variant === "spacious" ? 18 : 14
  // The tail assistant message is the one that should animate: either
  // still streaming, or just finished and being read aloud. Older
  // assistant messages snap to full text immediately.
  const tailAiId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "ai") return messages[i].id
    }
    return null
  })()
  return (
    <div style={{ padding: `4px ${padX}px`, display: "flex", flexDirection: "column", gap: padY * 1.4 }}>
      {messages.map((m, i) => (
        <ChatMessage
          key={String(m.id)}
          m={m}
          isTailAi={m.role === "ai" && m.id === tailAiId}
          ttsAudioRef={ttsAudioRef}
          ttsPlaying={!!ttsPlaying && ttsAiId === m.id}
          bubbleRef={(el) => {
            if (el) bubbleRefs.current.set(m.id, el)
            else bubbleRefs.current.delete(m.id)
          }}
          variant={variant}
          density={density}
          showAvatar={variant === "spacious" || messages[i - 1]?.role !== m.role}
          tweaks={tweaks}
        />
      ))}
    </div>
  )
}

function ChatMessage({
  m, variant, density, showAvatar, tweaks,
  isTailAi, ttsAudioRef, ttsPlaying, bubbleRef,
}: {
  m: ChatMsg
  variant: string
  density: string
  showAvatar: boolean
  tweaks?: Tweaks
  isTailAi?: boolean
  ttsAudioRef?: React.MutableRefObject<HTMLAudioElement | null>
  ttsPlaying?: boolean
  bubbleRef?: (el: HTMLDivElement | null) => void
}) {
  const padY = density === "tight" ? 8 : density === "loose" ? 14 : 11
  const padX = density === "tight" ? 11 : density === "loose" ? 16 : 13
  if (m.tool) return <ToolCallBlock tool={m.tool} />
  if (m.kind === "summary" && m.day) return <SummaryMessage m={m} showAvatar={showAvatar} />
  if (m.kind === "transcriptCTA") return <TranscriptCTA m={m} showAvatar={showAvatar} />

  const isUser = m.role === "user"
  if (isUser) {
    return (
      <div
        ref={bubbleRef}
        style={{
        alignSelf: "flex-end", maxWidth: "82%",
        padding: `${padY}px ${padX}px`,
        background: "var(--bg-2)", border: "1px solid var(--rule-strong)",
        borderRadius: 14, borderTopRightRadius: 6,
        fontSize: "var(--tweak-font-size)",
      }}>
        {m.attachments && m.attachments.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: m.content ? 6 : 0 }}>
            {m.attachments.map(a => (
              a.type.startsWith("image/") ? (
                <img
                  key={a.id}
                  src={a.dataUrl}
                  alt={a.name}
                  style={{
                    width: 120, height: 90, objectFit: "cover",
                    borderRadius: 6, border: "1px solid var(--rule-strong)",
                    display: "block",
                  }}
                />
              ) : (
                <div key={a.id} style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "5px 8px", borderRadius: 6,
                  background: "var(--bg-3)", border: "1px solid var(--rule-strong)",
                  fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)",
                  maxWidth: 160, overflow: "hidden",
                }}>
                  <IconFile size={11} stroke={1.6} style={{ flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</span>
                </div>
              )
            ))}
          </div>
        )}
        {m.content && <div style={{ color: "var(--fg)" }}>{m.content}</div>}
        <div className="t-mono" style={{ fontSize: 9.5, color: "var(--fg-5)", marginTop: 4, letterSpacing: "0.06em" }}>{m.time}</div>
      </div>
    )
  }

  // Animate the tail assistant bubble (still streaming OR currently
  // being spoken). Older assistant bubbles snap to full content.
  const shouldAnimate = !!isTailAi && (!!m.streaming || !!ttsPlaying)

  return (
    <div
      ref={bubbleRef}
      style={{ alignSelf: "stretch", display: "flex", gap: 10, paddingTop: showAvatar && variant === "spacious" ? 4 : 0 }}
    >
      {showAvatar ? (
        <div style={{
          width: 26, height: 26, borderRadius: 6,
          background: "var(--accent-soft)", color: "var(--accent)",
          border: "1px solid var(--accent-glow)",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 10, letterSpacing: 0.04,
        }}>//</div>
      ) : (
        <div style={{ width: 26, flexShrink: 0 }} />
      )}
      <div style={{ flex: 1, minWidth: 0, paddingRight: 16 }}>
        {/* Tool steps */}
        {m.steps && m.steps.length > 0 && (
          <div style={{ marginBottom: 6, display: "flex", flexDirection: "column", gap: 2 }}>
            {m.steps.map(step => (
              <ToolStepRow key={step.id} step={step} />
            ))}
          </div>
        )}
        {m.content ? (
          shouldAnimate ? (
            <AssistantTypewriter
              text={m.content}
              ttsAudioRef={ttsAudioRef}
              ttsPlaying={!!ttsPlaying}
            />
          ) : (
            <AssistantMarkdown content={m.content} />
          )
        ) : null}
        {m.streaming && (
          <div className="row gap-1" style={{ paddingTop: 4 }}>
            {[0, 1, 2].map(i => (
              <div key={i} className="amaso-thinking-dot" style={{ animationDelay: `${i * 0.15}s` }} />
            ))}
          </div>
        )}
        {(() => {
          const showActions = !m.streaming && !!m.content
          const showTimer = (m.streaming && typeof m.generationStartedAt === "number") || typeof m.generationTime === "number"
          if (!showActions && !showTimer) return null
          return (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 6 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                {showActions ? <AssistantActions text={m.content!} tweaks={tweaks} /> : null}
              </div>
              {showTimer ? (
                <GenTimer
                  startedAt={m.generationStartedAt}
                  finalTime={m.generationTime}
                  done={!m.streaming && typeof m.generationTime === "number"}
                />
              ) : null}
            </div>
          )
        })()}
      </div>
    </div>
  )
}

function AssistantActions({ text, tweaks }: { text: string; tweaks?: Tweaks }) {
  const [copied, setCopied] = useState(false)
  const [ttsState, setTtsState] = useState<"idle" | "loading" | "playing">("idle")
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)

  useEffect(() => () => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ""
    }
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
  }, [])

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }, [text])

  const stopTts = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.src = ""
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
    setTtsState("idle")
  }, [])

  const onSpeak = useCallback(async () => {
    if (ttsState !== "idle") {
      stopTts()
      return
    }
    setTtsState("loading")
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voice: tweaks?.sparVoice,
          speed: tweaks?.sparSpeed,
        }),
      })
      if (!r.ok || r.status === 204) {
        setTtsState("idle")
        return
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      blobUrlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => {
        setTtsState("idle")
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current)
          blobUrlRef.current = null
        }
      }
      audio.onerror = () => setTtsState("idle")
      await audio.play()
      setTtsState("playing")
    } catch {
      setTtsState("idle")
    }
  }, [text, ttsState, stopTts, tweaks])

  const onShare = useCallback(async () => {
    try {
      if (navigator.share) {
        await navigator.share({ text })
      } else {
        await navigator.clipboard.writeText(text)
      }
    } catch {}
  }, [text])

  const btnStyle: React.CSSProperties = {
    width: 28, height: 28, padding: 0,
    background: "transparent", border: "none",
    color: "var(--fg-4)", cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center",
    borderRadius: 6,
  }

  return (
    <div style={{ display: "flex", gap: 4, marginLeft: -4 }}>
      <button onClick={onCopy} title="Copy" style={btnStyle} aria-label="Copy">
        {copied ? <span className="t-mono" style={{ fontSize: 10, color: "var(--accent)" }}>OK</span> : <IconCopy size={14} stroke={1.6} />}
      </button>
      <button
        onClick={onSpeak}
        title={ttsState === "idle" ? "Speak" : "Stop"}
        style={{ ...btnStyle, color: ttsState === "idle" ? "var(--fg-4)" : "var(--accent)" }}
        aria-label="Speak"
      >
        {ttsState === "loading"
          ? <span className="amaso-thinking-dot" style={{ width: 6, height: 6 }} />
          : <IconVolume size={14} stroke={1.6} />}
      </button>
      <button onClick={onShare} title="Share" style={btnStyle} aria-label="Share">
        <IconShare size={14} stroke={1.6} />
      </button>
    </div>
  )
}

function formatGenTime(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}m ${r}s`
}

/**
 * Typewriter reveal for the tail assistant bubble.
 *
 * Two pacing modes:
 *   1. TTS-synced — when the shared audio element is playing AND has
 *      a known duration, target characters = round(currentTime /
 *      duration * total). The visible count never goes backwards, so
 *      a partial duration metadata update can't rewind the reveal.
 *   2. Default — 38 chars/sec. Used while the stream is still arriving
 *      OR while audio is between chunks. Roughly matches a natural
 *      speaking pace so the text feels in sync even before audio
 *      starts.
 *
 * When `ttsPlaying` flips false (audio ended / interrupted), the
 * default-cps mode keeps advancing until the buffer is fully revealed
 * — guarantees the user always sees the full text eventually.
 *
 * Render throttle: setState fires only when the floored character
 * count actually changes, so we don't re-render AssistantMarkdown
 * on every animation frame. On long replies the underlying
 * react-markdown render is the bottleneck — capping rerenders to
 * char-boundary changes keeps the typewriter smooth.
 *
 * Markdown is parsed each render on the partial text. react-markdown
 * is forgiving of half-finished bold / list tokens, so seeing
 * mid-token text briefly before the closing delimiter arrives is
 * acceptable visual cost for keeping formatting live.
 */
function AssistantTypewriter({
  text,
  ttsAudioRef,
  ttsPlaying,
  defaultCps = 38,
}: {
  text: string
  ttsAudioRef?: React.MutableRefObject<HTMLAudioElement | null>
  ttsPlaying: boolean
  defaultCps?: number
}) {
  const [visible, setVisible] = useState(0)
  // Float-precision cursor — state holds the integer floor we render.
  // Keeping the float in a ref lets sub-character progress accumulate
  // between frames without forcing a re-render every tick.
  const cursorRef = useRef(0)

  // Reset when text length collapses (a fresh turn re-seeded the same
  // component slot via React reconciliation — rare but possible if a
  // parent reuses key).
  useEffect(() => {
    if (text.length < cursorRef.current) {
      cursorRef.current = 0
      setVisible(0)
    }
  }, [text])

  useEffect(() => {
    if (text.length === 0) {
      cursorRef.current = 0
      setVisible(0)
      return
    }
    let cancelled = false
    let lastT = performance.now()
    let raf = 0
    function tick(now: number) {
      if (cancelled) return
      const dt = Math.max(0, (now - lastT) / 1000)
      lastT = now
      let next = cursorRef.current
      const audio = ttsAudioRef?.current
      const hasDuration = audio && Number.isFinite(audio.duration) && audio.duration > 0
      if (ttsPlaying && hasDuration) {
        const ratio = audio.currentTime / audio.duration
        const target = Math.min(text.length, Math.round(ratio * text.length))
        next = Math.max(next, target)
      } else {
        next = Math.min(text.length, next + dt * defaultCps)
      }
      if (next !== cursorRef.current) {
        cursorRef.current = next
        const floor = Math.floor(next)
        setVisible(prev => (floor === prev ? prev : floor))
      }
      if (next < text.length) {
        raf = requestAnimationFrame(tick)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => { cancelled = true; cancelAnimationFrame(raf) }
  }, [text, ttsAudioRef, ttsPlaying, defaultCps])

  const shown = text.slice(0, visible)
  // Caret: a thin pulsing rule shown when there's still text to
  // reveal, hidden when fully caught up. Inline-block so it sits next
  // to the markdown content without breaking the flow.
  const hasMore = visible < text.length
  return (
    <div style={{ position: "relative" }}>
      <AssistantMarkdown content={shown} />
      {hasMore && (
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 6,
            height: "1em",
            marginLeft: 2,
            verticalAlign: "text-bottom",
            background: "var(--accent, #f97316)",
            opacity: 0.7,
            animation: "amaso-typewriter-blink 1s steps(2, jump-none) infinite",
          }}
        />
      )}
      <style jsx>{`
        @keyframes amaso-typewriter-blink {
          0%, 49% { opacity: 0.7 }
          50%, 100% { opacity: 0.0 }
        }
      `}</style>
    </div>
  )
}

function ToolStepRow({ step }: { step: MobileToolStep }) {
  const dotColor = step.status === "running" ? "var(--accent)" : step.status === "ok" ? "var(--ok)" : "var(--bad)"
  const pulse = step.status === "running"
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{
        width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
        background: dotColor,
        animation: pulse ? "m-dot-pulse 1s ease-in-out infinite" : "none",
        boxShadow: pulse ? `0 0 5px ${dotColor}` : "none",
      }} />
      <span className="t-mono" style={{
        fontSize: 10, color: "var(--fg-4)",
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {step.label}
        {step.detail ? <span style={{ color: "var(--fg-5)" }}> · {step.detail}</span> : null}
      </span>
    </div>
  )
}


export function ToolCallBlock({ tool }: { tool: { name: string; status: string; detail: string } }) {
  return (
    <div style={{ padding: "0 14px" }}>
      <div className="term" style={{ marginLeft: 36 }}>
        <div className="row gap-2" style={{ marginBottom: 6 }}>
          <span className="dot dot-ok" />
          <span className="accent">$ {tool.name}</span>
          <span style={{ flex: 1 }} />
          <span className="dim">{tool.status}</span>
        </div>
        <div className="dim" style={{ whiteSpace: "pre-line" }}>{tool.detail}</div>
      </div>
    </div>
  )
}

function FocusLayout({ messages }: { messages: ChatMsg[] }) {
  return (
    <div style={{ padding: "4px 16px", fontFamily: "var(--font-mono)" }}>
      {messages.map((m, i) => {
        if (m.tool) return <ToolCallBlock key={String(m.id)} tool={m.tool} />
        const isUser = m.role === "user"
        return (
          <div key={String(m.id)} style={{ padding: "8px 0", borderBottom: i < messages.length - 1 ? "1px solid var(--rule)" : "none" }}>
            <div className="row gap-2" style={{ marginBottom: 4 }}>
              {isUser ? <span style={{ fontSize: 10, color: "var(--fg-3)", letterSpacing: "0.08em", fontWeight: 600 }}>YOU</span> : null}
              <span style={{ fontSize: 9.5, color: "var(--fg-5)" }}>{m.time}</span>
            </div>
            {isUser
              ? <div style={{ fontSize: 14, color: "var(--fg-2)", lineHeight: 1.5 }}>{m.content}</div>
              : <AssistantMarkdown content={m.content ?? ""} />
            }
          </div>
        )
      })}
    </div>
  )
}

// ── Composer ─────────────────────────────────────────────────────────────────

function Composer({
  draft, setDraft, voice, setVoice, onSend, autopilot, layout, placeholder,
  attachments, onAddAttachments, onRemoveAttachment,
  activeTopic, onClearTopic,
}: {
  draft: string; setDraft: (v: string) => void
  voice: boolean; setVoice: (v: boolean) => void
  onSend: (text?: string) => void; autopilot: boolean
  layout: string; placeholder?: string
  attachments?: MobileAttachment[]
  onAddAttachments?: (files: FileList) => void
  onRemoveAttachment?: (id: string) => void
  activeTopic?: { id: number; slug: string; title: string } | null
  onClearTopic?: () => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const hasAttachments = attachments && attachments.length > 0
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    const next = Math.min(el.scrollHeight, 200)
    el.style.height = `${next}px`
  }, [draft])

  return (
    <div style={{
      position: "absolute", left: 0, right: 0, bottom: 0,
      padding: "0 12px 4px",
      // Stack the iOS home-indicator inset on top of a dynamic floor:
      //   - textarea UNFOCUSED (idle): 21px floor (175% of original
      //     12px). On a home-bar iPhone: 21 + 34 = 55px lift, plenty
      //     of room above the gesture pill.
      //   - textarea FOCUSED (typing): 6px floor (50% of original).
      //     Keyboard is open on iOS so env() collapses to 0 anyway,
      //     and the user wants the capsule sitting right above the
      //     keyboard with minimal slack.
      // Smooth 180ms ease-out transition matches the iOS keyboard
      // open/close animation closely enough that the padding shift
      // rides along with it instead of snapping.
      paddingBottom: focused
        ? "calc(6px + env(safe-area-inset-bottom, 0px))"
        : "calc(21px + env(safe-area-inset-bottom, 0px))",
      transition: "padding-bottom 180ms ease-out",
      background: "linear-gradient(to top, var(--bg-0) 60%, rgba(10,10,12,0.85) 80%, transparent)",
      zIndex: 20,
    }}>
      {/* Active topic pill — sits above attachments + composer when
          the user opted into a topic-scoped turn via history's "Ask
          about this" button. Same TopicPill the desktop SparFullView
          renders so the two surfaces match. */}
      {activeTopic && onClearTopic && (
        <div style={{ padding: "8px 2px 0", display: "flex", flexShrink: 0 }}>
          <TopicPill
            topic={activeTopic}
            onDismiss={onClearTopic}
          />
        </div>
      )}
      {/* Attachment previews */}
      {hasAttachments && (
        <div style={{
          display: "flex", gap: 8, padding: "10px 2px 6px",
          overflowX: "auto", flexShrink: 0,
          WebkitOverflowScrolling: "touch" as any,
        }}>
          {attachments!.map(a => (
            <div key={a.id} style={{ position: "relative", flexShrink: 0 }}>
              {a.type.startsWith("image/") ? (
                <div style={{
                  width: 60, height: 60, borderRadius: 8,
                  background: "var(--bg-3)", border: "1px solid var(--rule-strong)",
                  overflow: "hidden",
                }}>
                  <img src={a.dataUrl} alt={a.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                </div>
              ) : (
                <div style={{
                  height: 36, paddingRight: 28, paddingLeft: 8,
                  borderRadius: 8, background: "var(--bg-3)",
                  border: "1px solid var(--rule-strong)",
                  display: "flex", alignItems: "center", gap: 5,
                  fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-3)",
                  maxWidth: 130,
                }}>
                  <IconFile size={11} stroke={1.6} style={{ flexShrink: 0 }} />
                  <span style={{
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{a.name}</span>
                </div>
              )}
              <button
                onClick={() => onRemoveAttachment?.(a.id)}
                style={{
                  position: "absolute", top: -4, right: -4,
                  width: 18, height: 18, borderRadius: "50%",
                  background: "var(--bg-0)", border: "1px solid var(--rule-strong)",
                  color: "var(--fg-3)", display: "flex", alignItems: "center", justifyContent: "center",
                  cursor: "pointer", padding: 0,
                }}
              >
                <IconClose size={9} stroke={2.2} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{
        display: "flex", alignItems: "flex-end", gap: 8,
        marginTop: hasAttachments ? 0 : "10px",
      }}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,application/pdf,text/*,.md,.ts,.tsx,.js,.jsx,.json,.yaml,.yml,.csv"
          style={{ display: "none" }}
          onChange={e => {
            if (e.target.files && e.target.files.length > 0) {
              onAddAttachments?.(e.target.files)
              e.target.value = ""
            }
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          title="Attach file"
          style={{
            width: 34, height: 34, flexShrink: 0,
            borderRadius: "50%",
            background: "#3a3a3e",
            border: "none",
            color: "var(--fg)",
            display: "flex", alignItems: "center", justifyContent: "center",
            cursor: "pointer", padding: 0,
          }}
        >
          <IconPlus size={18} stroke={2} />
        </button>
        <div style={{
          flex: 1,
          background: "#2a2a2e",
          borderRadius: 20,
          padding: "10px 16px",
          border: autopilot ? "1px solid var(--accent-glow)" : "1px solid transparent",
          boxShadow: autopilot ? "0 0 0 3px rgba(249,115,22,0.08)" : "none",
          transition: "border-color 0.16s, box-shadow 0.16s",
          display: "flex",
        }}>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                onSend()
              }
            }}
            placeholder={placeholder ?? (autopilot ? "autopilot on — describe an outcome…" : "Message…")}
            rows={1}
            style={{
              flex: 1, fontFamily: "var(--font-sans)", fontSize: 16,
              color: "#fff", resize: "none", maxHeight: 200, minHeight: 22,
              overflowY: "auto",
              padding: 0, lineHeight: 1.4,
              background: "transparent", border: "none", outline: "none",
              width: "100%",
            }}
          />
        </div>
        {(draft.trim() || hasAttachments) ? (
          <button
            onClick={() => onSend()}
            style={{
              width: 34, height: 34, flexShrink: 0,
              borderRadius: "50%",
              background: "#fff",
              border: "none",
              color: "#0a0a0c",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", padding: 0,
            }}
          >
            <IconArrowUp size={16} stroke={2.4} />
          </button>
        ) : (
          <button
            onClick={() => setVoice(!voice)}
            data-on={voice ? "1" : "0"}
            style={{
              width: 34, height: 34, flexShrink: 0,
              borderRadius: "50%",
              background: "#3a3a3e",
              border: "none",
              color: "var(--fg)",
              display: "flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", padding: 0,
            }}
          >
            {voice ? <VoiceWave /> : <IconMic size={17} stroke={1.6} />}
          </button>
        )}
      </div>
    </div>
  )
}

function GenTimer({ startedAt, finalTime, done }: { startedAt?: number; finalTime?: number; done: boolean }) {
  const [elapsed, setElapsed] = useState(
    typeof startedAt === "number" ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : 0
  )
  useEffect(() => {
    if (done || typeof startedAt !== "number") return
    const id = setInterval(() => {
      setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
    }, 1000)
    return () => clearInterval(id)
  }, [startedAt, done])
  const seconds = done && typeof finalTime === "number" ? finalTime : elapsed
  return (
    <div
      style={{
        fontSize: 11,
        flexShrink: 0,
        transition: "all 0.3s ease",
        opacity: done ? 1 : 0.4,
        fontWeight: done ? 700 : 400,
        color: done ? "#fff" : undefined,
      }}
    >
      {formatGenTime(seconds)}
    </div>
  )
}

function VoiceWave() {
  return (
    <div className="row gap-1" style={{ alignItems: "center", height: 18 }}>
      {[0, 1, 2, 3].map(i => (
        <div key={i} style={{
          width: 2.5, height: 14, borderRadius: 2,
          background: "var(--accent)",
          animation: `vwave 0.7s ease-in-out infinite ${i * 0.12}s`,
        }} />
      ))}
    </div>
  )
}

// ── Special AI message kinds ──────────────────────────────────────────────────

function AIRow({ showAvatar, time, children }: { showAvatar: boolean; time: string; children: React.ReactNode }) {
  return (
    <div style={{ alignSelf: "stretch", display: "flex", gap: 10 }}>
      {showAvatar ? (
        <div style={{
          width: 26, height: 26, borderRadius: 6,
          background: "var(--accent-soft)", color: "var(--accent)",
          border: "1px solid var(--accent-glow)",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 10,
        }}>//</div>
      ) : <div style={{ width: 26, flexShrink: 0 }} />}
      <div style={{ flex: 1, minWidth: 0, paddingRight: 16 }}>

        {children}
      </div>
    </div>
  )
}

function SummaryMessage({ m, showAvatar }: { m: ChatMsg; showAvatar: boolean }) {
  const day = m.day!
  const fmtWork = (mm: number) => {
    const h = Math.floor(mm / 60), r = mm % 60
    return h > 0 ? `${h}h ${r}m` : `${r}m`
  }
  return (
    <AIRow showAvatar={showAvatar} time={m.time}>
      <div className="t-eyebrow" style={{ marginBottom: 8, color: "var(--fg-4)" }}>
        EOD RECAP · {day.label} · {day.date}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 10 }}>
        <StatCell label="MESSAGES" value={String(day.messages)} />
        <StatCell label="WORK" value={fmtWork(day.workMin)} accent />
        <StatCell label="SUBJECTS" value={String(day.subjects.length)} />
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.5, color: "var(--fg)", marginBottom: 10 }}>{day.summary}</div>
      <div style={{ marginBottom: 4 }}>
        {day.subjects.map((s, i) => {
          const headline = (s.messages.find(x => x.role === "ai" && x.content) ?? {}).content ?? ""
          const trimmed = headline.split(/[.!?]\s/)[0]
          return (
            <div key={i} style={{
              display: "flex", gap: 8, alignItems: "baseline",
              padding: "4px 0",
              borderTop: i === 0 ? "1px solid var(--rule)" : "none",
              borderBottom: "1px solid var(--rule)",
            }}>
              <span className="t-mono" style={{ fontSize: 9, color: "var(--accent)", letterSpacing: "0.08em", minWidth: 22, textAlign: "right" }}>{String(i + 1).padStart(2, "0")}</span>
              <span className="t-mono" style={{ fontSize: 9, padding: "0 5px", borderRadius: 3, background: "var(--bg-3)", color: "var(--fg-3)", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{s.project}</span>
              <span style={{ flex: 1, fontSize: 13, color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
              <span className="t-mono" style={{ fontSize: 9.5, color: "var(--fg-5)" }}>{s.messages.length}</span>
            </div>
          )
        })}
      </div>
    </AIRow>
  )
}

function StatCell({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ padding: "8px 10px", background: "var(--bg-1)", border: "1px solid var(--rule)", borderRadius: 6 }}>
      <div className="t-eyebrow" style={{ marginBottom: 2, fontSize: 8.5 }}>{label}</div>
      <div className="t-mono" style={{ fontSize: 16, color: accent ? "var(--accent)" : "var(--fg)" }}>{value}</div>
    </div>
  )
}

function TranscriptCTA({ m, showAvatar }: { m: ChatMsg; showAvatar: boolean }) {
  return (
    <AIRow showAvatar={showAvatar} time={m.time}>
      <div style={{ fontSize: 13.5, lineHeight: 1.5, color: "var(--fg-2)", marginBottom: 8 }}>
        Want the full transcript? Open it fullscreen — every subject becomes its own chat.
      </div>
      <button onClick={m.onOpen} style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "10px 14px", background: "var(--bg-2)", border: "1px solid var(--rule-strong)",
        borderRadius: 10, color: "var(--fg)", fontFamily: "var(--font-mono)", fontSize: 11.5,
        letterSpacing: "0.06em", cursor: "pointer", width: "100%",
      }}>
        <IconExpand size={15} stroke={1.7} />
        <span style={{ flex: 1, textAlign: "left" }}>VIEW FULL TRANSCRIPT</span>
        <span style={{ color: "var(--fg-4)" }}>{m.subjectCount} subjects · {m.messageCount} msgs</span>
      </button>
    </AIRow>
  )
}

// ── Day chat view ─────────────────────────────────────────────────────────────

interface DayChatProps {
  day: DayCard
  onBack: () => void
  onLeft: () => void
  onSend?: (text: string) => void
  tweaks?: Tweaks
}

export function DayChatView({ day, onBack, onLeft, onSend, tweaks }: DayChatProps) {
  const summaryMsg: ChatMsg = useMemo(() => ({ id: -1, role: "ai", time: "—", kind: "summary", day }), [day])
  const totalMsgs = useMemo(() => day.subjects.reduce((n, s) => n + s.messages.length, 0), [day])
  const [transcriptOpen, setTranscriptOpen] = useState(false)
  const [openSubject, setOpenSubject] = useState<Subject | null>(null)

  const ctaMsg: ChatMsg = useMemo(() => ({
    id: -2, role: "ai", time: "—", kind: "transcriptCTA",
    subjectCount: day.subjects.length, messageCount: totalMsgs,
    onOpen: () => setTranscriptOpen(true),
  }), [day, totalMsgs])

  const [messages, setMessages] = useState<ChatMsg[]>([summaryMsg, ctaMsg])
  useEffect(() => { setMessages([summaryMsg, ctaMsg]) }, [day.date, summaryMsg, ctaMsg])

  const headerCenter = (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "0 10px", height: 36,
      background: "var(--bg-1)", border: "1px solid var(--rule-strong)",
      borderRadius: 10, marginRight: 4,
    }}>
      <span className="t-eyebrow" style={{ color: "var(--accent)" }}>{day.label}</span>
      <span style={{ flex: 1 }} />
      <span className="t-mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>{day.date}</span>
    </div>
  )

  return (
    <>
      <ChatScreen
        messages={messages}
        setMessages={setMessages}
        project={null}
        autopilot={false}
        onLeft={onLeft}
        onRight={onBack}
        rightIcon="expand"
        headerCenter={headerCenter}
        placeholder={`ask about ${day.label.toLowerCase()}…`}
        tweaks={tweaks}
        onSend={onSend}
      />
      {transcriptOpen && (
        <TranscriptModal
          day={day}
          onClose={() => setTranscriptOpen(false)}
          onOpenSubject={s => { setOpenSubject(s); setTranscriptOpen(false) }}
        />
      )}
      {openSubject && (
        <SubjectChatView
          day={day}
          subject={openSubject}
          onBack={() => { setOpenSubject(null); setTranscriptOpen(true) }}
          onClose={() => setOpenSubject(null)}
          onSend={onSend}
        />
      )}
    </>
  )
}

function TranscriptModal({ day, onClose, onOpenSubject }: { day: DayCard; onClose: () => void; onOpenSubject: (s: Subject) => void }) {
  return (
    <div className="amaso-screen" style={{ position: "absolute", inset: 0, zIndex: 80, background: "var(--bg-0)", animation: "amaso-modal-rise 0.18s ease-out" }}>
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, zIndex: 30,
        padding: "calc(env(safe-area-inset-top, 0px) + 6px) 12px 10px",
        background: "linear-gradient(to bottom, var(--bg-0) 70%, transparent)",
      }}>
        <div className="row gap-2" style={{ height: 44, paddingTop: 6 }}>
          <button onClick={onClose} className="btn-icon"><IconClose size={16} stroke={1.7} /></button>
          <div style={{
            flex: 1, display: "flex", alignItems: "center", gap: 8,
            padding: "0 10px", height: 36,
            background: "var(--bg-1)", border: "1px solid var(--rule-strong)",
            borderRadius: 10,
          }}>
            <span className="t-eyebrow" style={{ color: "var(--fg-2)" }}>TRANSCRIPT</span>
            <span style={{ flex: 1 }} />
            <span className="t-mono" style={{ fontSize: 11, color: "var(--fg-3)" }}>{day.label} · {day.date}</span>
          </div>
          <div style={{ width: 32 }} />
        </div>
      </div>

      <div className="amaso-scroll" style={{ position: "absolute", top: "calc(env(safe-area-inset-top, 0px) + 56px)", left: 0, right: 0, bottom: 0, padding: "8px 12px 24px" }}>
        <div className="t-eyebrow" style={{ padding: "8px 4px 10px", color: "var(--fg-4)" }}>
          {day.subjects.length} SUBJECTS · TAP TO OPEN AS A CHAT
        </div>
        {day.subjects.map((s, i) => {
          const firstAi = s.messages.find(m => m.role === "ai" && m.content)
          const preview = (firstAi?.content ?? "").slice(0, 120)
          return (
            <button key={i} onClick={() => onOpenSubject(s)} style={{
              display: "block", width: "100%", textAlign: "left",
              padding: "12px 14px", marginBottom: 8,
              background: "var(--bg-1)", border: "1px solid var(--rule)",
              borderRadius: 10, cursor: "pointer",
            }}>
              <div className="row gap-2" style={{ marginBottom: 6 }}>
                <span className="t-mono" style={{ fontSize: 9, padding: "1px 6px", borderRadius: 3, background: "var(--bg-3)", color: "var(--fg-3)", letterSpacing: "0.04em" }}>{s.project}</span>
                <span style={{ flex: 1 }} />
                <span className="t-mono" style={{ fontSize: 9.5, color: "var(--fg-5)" }}>{s.messages.length} msgs</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 500, color: "var(--fg)", marginBottom: 4 }}>{s.title}</div>
              <div style={{ fontSize: 12, lineHeight: 1.45, color: "var(--fg-3)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>{preview}</div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function SubjectChatView({ day, subject, onBack, onClose, onSend, tweaks }: {
  day: DayCard; subject: Subject
  onBack: () => void; onClose: () => void
  onSend?: (text: string) => void
  tweaks?: Tweaks
}) {
  const seed = useMemo(() => subject.messages.map(m => ({
    id: m.id,
    role: m.role === "ai" ? "ai" as const : "user" as const,
    time: m.time,
    content: m.content,
    tool: m.tool,
  })), [subject])
  const [messages, setMessages] = useState<ChatMsg[]>(seed)
  useEffect(() => { setMessages(seed) }, [subject])

  const headerCenter = (
    <div style={{
      display: "flex", flexDirection: "column", justifyContent: "center",
      padding: "2px 10px", height: 36, minWidth: 0,
      background: "var(--bg-1)", border: "1px solid var(--rule-strong)",
      borderRadius: 10, marginRight: 4,
    }}>
      <div className="row gap-2" style={{ alignItems: "center" }}>
        <span className="t-mono" style={{ fontSize: 9, padding: "0 5px", borderRadius: 3, background: "var(--bg-3)", color: "var(--fg-3)", letterSpacing: "0.04em" }}>{subject.project}</span>
        <span style={{ flex: 1, fontSize: 12, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{subject.title}</span>
      </div>
      <div className="t-mono" style={{ fontSize: 9, color: "var(--fg-5)", letterSpacing: "0.06em", marginTop: 1 }}>{day.label} · {day.date}</div>
    </div>
  )

  return (
    <div className="amaso-screen" style={{ position: "absolute", inset: 0, zIndex: 90, background: "var(--bg-0)", animation: "amaso-subject-rise 0.18s ease-out" }}>
      <ChatScreen
        messages={messages}
        setMessages={setMessages}
        project={null}
        autopilot={false}
        onLeft={onBack}
        onRight={onClose}
        rightIcon="expand"
        headerCenter={headerCenter}
        placeholder="ask about this thread…"
        tweaks={tweaks}
        onSend={onSend}
      />
    </div>
  )
}
