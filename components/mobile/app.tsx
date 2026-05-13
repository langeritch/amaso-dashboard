"use client"
import { useState, useEffect, useCallback, useRef } from "react"
import type { ChatMsg, DayCard, Project, Worker, Task, Thread, Tweaks, MobileUser, MobileAttachment, MobileToolStep } from "./types"
import { ChatScreen } from "./chat"
import WorkspaceScreen from "./workspace"
import SettingsScreen from "./settings"
import { LeftSidebar, RightSidebar } from "./sidebars"
import { DayChatView } from "./chat"
import BrainScreen from "./brain"
import ReviewScreen from "./review"
import HistoryScreen from "./history"
import AudioLegBanner from "../AudioLegBanner"
import { useMobileTts } from "./use-mobile-tts"

const PWA_DEVICE_ID_KEY = "amaso:pwa-device-id"

function getOrMintPwaDeviceId(): string {
  if (typeof window === "undefined") return "pwa:" + Math.random().toString(36).slice(2, 12)
  try {
    const cached = window.localStorage.getItem(PWA_DEVICE_ID_KEY)
    if (cached && cached.startsWith("pwa:")) return cached
    const fresh = "pwa:" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
    window.localStorage.setItem(PWA_DEVICE_ID_KEY, fresh)
    return fresh
  } catch {
    return "pwa:" + Math.random().toString(36).slice(2, 12)
  }
}

const TWEAK_DEFAULTS: Tweaks = {
  layout: "compact",
  density: "default",
  accent: "#f97316",
  fontFamily: "var(--font-sans)",
  theme: "dark",
  borderRadius: 12,
  fontSize: 14,
  sidebarW: 280,
  sparModel: "claude-opus-4-7",
  sparVoice: "af_nicole",
  sparPitch: 1.0,
  sparSpeed: 1.0,
  sparTone: "terse · honest",
  sparMemory: true,
  notifPush: true,
  notifTelegram: true,
  notifProactive: true,
  notifMorning: true,
  notifSound: true,
  holdSensitivity: 50,
  autoPlayTTS: true,
  ttsVolume: 80,
  micGain: 70,
  bootupSound: true,
}

const TWEAK_KEY = "amaso:mobile-tweaks"

const SEED_MSGS: ChatMsg[] = [
  {
    id: 1, role: "ai", time: new Date().toLocaleTimeString("nl", { hour: "2-digit", minute: "2-digit" }),
    content: "good morning. what are we working on?",
  },
]

// Exponential backoff between stream attempts. Up to 3 tries — first
// immediate, second after 3s, third after 9s. Total worst-case wait
// before giving up: ~12s plus stream timeouts. Matches what the user
// asked for in the "3-second exponential-backoff retry, max 3 attempts"
// brief.
const RETRY_DELAYS = [0, 3000, 9000]

// Watchdog: if no NDJSON event arrives in 60s, treat the stream as
// timed out, abort the fetch, and either commit partial text or move
// to the next retry attempt. Prevents the "stream silently hangs and
// the user sees only the running generation timer" failure mode that
// produced empty-looking replies like "5s" / "6s" (the timer text)
// when the network throttled mid-stream.
const STREAM_IDLE_TIMEOUT_MS = 60_000

interface Props {
  user?: MobileUser
}

export default function MobileApp({ user }: Props) {
  const [tweaks, setTweaksState] = useState<Tweaks>(TWEAK_DEFAULTS)

  // Load tweaks on mount
  useEffect(() => {
    const stored = localStorage.getItem(TWEAK_KEY)
    if (stored) {
      try {
        const parsed = JSON.parse(stored)
        setTweaksState(prev => ({ ...prev, ...parsed }))
      } catch {}
    }
  }, [])

  const setTweak = useCallback((key: keyof Tweaks, value: Tweaks[keyof Tweaks]) => {
    setTweaksState(prev => {
      const next = { ...prev, [key]: value }
      localStorage.setItem(TWEAK_KEY, JSON.stringify(next))
      return next
    })
  }, [])

  const [screen, setScreen] = useState<"chat" | "day" | "workspace" | "settings" | "brain" | "review" | "history">("chat")
  const pwaDeviceIdRef = useRef<string>(getOrMintPwaDeviceId())
  const [leftOpen, setLeftOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const [autopilot, setAutopilot] = useState(false)
  const [messages, setMessages] = useState<ChatMsg[]>(SEED_MSGS)
  const [project, setProject] = useState<Project | null>(null)
  const [viewedDay, setViewedDay] = useState<DayCard | null>(null)
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [attachments, setAttachments] = useState<MobileAttachment[]>([])

  const [today, setToday] = useState<{ date: string; dailyChat: { id: number | null; subject: string } } | null>(null)
  const [dayHistory, setDayHistory] = useState<DayCard[]>([])
  const [workers, setWorkers] = useState<Worker[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [teamCount, setTeamCount] = useState<number | null>(null)
  const [deviceCount, setDeviceCount] = useState<number | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const attachmentsRef = useRef<MobileAttachment[]>([])
  const conversationIdRef = useRef<number | null>(null)
  // Topic-scoped chat. Set from history's "Ask about this" button;
  // the ChatScreen composer renders a TopicPill while non-null and
  // handleSend includes topicId on the next /api/spar POST.
  const [activeTopic, setActiveTopic] = useState<{ id: number; slug: string; title: string } | null>(null)
  const activeTopicRef = useRef<typeof activeTopic>(null)
  useEffect(() => { activeTopicRef.current = activeTopic }, [activeTopic])
  // Auto-speak assistant replies through Kokoro after the stream
  // closes. Hook handles its own audio element + abort coordination
  // and skips silently when another device holds the audio leg.
  const tts = useMobileTts()
  // Which assistant message id is currently being spoken. Drives
  // the per-bubble typewriter animation: the matching bubble paces
  // its reveal to tts.audioRef.currentTime / .duration. Cleared a
  // short beat after tts.playing flips false so the typewriter has
  // a chance to catch up to the final character.
  const [ttsAiId, setTtsAiId] = useState<number | null>(null)
  useEffect(() => {
    if (tts.playing) return
    if (ttsAiId === null) return
    // 1s tail so the typewriter glides to the end on stop/error.
    const t = setTimeout(() => setTtsAiId(null), 1000)
    return () => clearTimeout(t)
  }, [tts.playing, ttsAiId])
  // Snapshot of TTS-relevant tweaks the handleSend callback can read
  // without forcing itself to depend on the full tweaks object (which
  // would re-create the callback on every density / colour tweak).
  const ttsTweaksRef = useRef({
    autoPlay: TWEAK_DEFAULTS.autoPlayTTS,
    voice: TWEAK_DEFAULTS.sparVoice,
    speed: TWEAK_DEFAULTS.sparSpeed,
    pitch: TWEAK_DEFAULTS.sparPitch,
    volume: TWEAK_DEFAULTS.ttsVolume,
  })

  useDailySubjectSync(messages, today, setToday)

  useEffect(() => { attachmentsRef.current = attachments }, [attachments])
  useEffect(() => { conversationIdRef.current = conversationId }, [conversationId])
  useEffect(() => {
    ttsTweaksRef.current = {
      autoPlay: tweaks.autoPlayTTS,
      voice: tweaks.sparVoice,
      speed: tweaks.sparSpeed,
      pitch: tweaks.sparPitch,
      volume: tweaks.ttsVolume,
    }
  }, [tweaks.autoPlayTTS, tweaks.sparVoice, tweaks.sparSpeed, tweaks.sparPitch, tweaks.ttsVolume])

  // Kill any in-flight assistant TTS the moment the user leaves the
  // chat surface. Workspace / settings / brain screens all expect
  // silence; the visibilitychange handler inside the hook handles
  // tab-level hides, this covers same-tab in-app navigation.
  useEffect(() => {
    if (screen !== "chat") tts.stop()
  }, [screen, tts])

  // Apply tweaks to CSS vars
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".amaso-mobile-shell")
    if (!shell) return
    shell.style.setProperty("--tweak-font-size", tweaks.fontSize + "px")
    shell.style.setProperty("--tweak-sidebar-w", tweaks.sidebarW + "px")
    shell.style.setProperty("--tweak-radius", tweaks.borderRadius + "px")
    shell.style.setProperty("--font-sans", tweaks.fontFamily)
    shell.style.setProperty("--accent", tweaks.accent)
    shell.dataset.density = tweaks.density
    shell.dataset.layout = tweaks.layout
    shell.dataset.theme = tweaks.theme
    
    // OLED / Pure black mode support
    if (tweaks.theme === "oled") {
      shell.style.setProperty("--bg-0", "#000000")
      shell.style.setProperty("--bg-1", "#050505")
      shell.style.setProperty("--fg", "#f5f5f0")
      shell.style.setProperty("--fg-2", "#d4d4cf")
      shell.style.setProperty("--rule", "#1f1f24")
      shell.style.setProperty("--rule-strong", "#2a2a30")
    } else if (tweaks.theme === "light") {
      shell.style.setProperty("--bg-0", "#fafafa")
      shell.style.setProperty("--bg-1", "#ffffff")
      shell.style.setProperty("--fg", "#18181b")
      shell.style.setProperty("--fg-2", "#27272a")
      shell.style.setProperty("--rule", "#e4e4e7")
      shell.style.setProperty("--rule-strong", "#d4d4d8")
    } else {
      shell.style.setProperty("--bg-0", "#0a0a0c")
      shell.style.setProperty("--bg-1", "#111114")
      shell.style.setProperty("--fg", "#f5f5f0")
      shell.style.setProperty("--fg-2", "#d4d4cf")
      shell.style.setProperty("--rule", "#1f1f24")
      shell.style.setProperty("--rule-strong", "#2a2a30")
    }
  }, [tweaks])

  // Consolidated data loading
  useEffect(() => {
    async function load() {
      const [todayR, historyR, workersR, tasksR, projectsR, devicesR] = await Promise.all([
        fetch("/api/mobile/today"),
        fetch("/api/mobile/history"),
        fetch("/api/mobile/workers"),
        fetch("/api/mobile/tasks"),
        fetch("/api/mobile/projects"),
        fetch("/api/companion/devices"),
      ])

      if (todayR.ok) todayR.json().then(setToday).catch(() => {})
      if (historyR.ok) historyR.json().then(d => Array.isArray(d) && setDayHistory(d)).catch(() => {})
      if (workersR.ok) workersR.json().then(d => Array.isArray(d) && setWorkers(d)).catch(() => {})
      if (tasksR.ok) tasksR.json().then(d => Array.isArray(d) && setTasks(d)).catch(() => {})
      if (projectsR.ok) projectsR.json().then(d => {
        if (Array.isArray(d)) {
          setProjects(d)
          if (!project && d.length > 0) setProject(d[0])
        }
      }).catch(() => {})
      if (devicesR.ok) devicesR.json().then(d => {
        if (d && Array.isArray(d.devices)) {
          setDeviceCount(d.devices.filter((dev: any) => dev.connected).length)
        }
      }).catch(() => {})
      
      if (user?.role === "admin") {
        fetch("/api/admin/users").then(r => r.ok ? r.json() : null).then(d => {
          if (d && Array.isArray(d.users)) setTeamCount(d.users.length)
        }).catch(() => {})
      }
    }
    load()
  }, [])

  const handleSignOut = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" })
      window.location.href = "/login"
    } catch {
      window.location.href = "/login"
    }
  }, [])

  // On mount: check if new day since last open and trigger yesterday's summary if needed
  useEffect(() => {
    if (typeof window === "undefined") return
    const today = new Date().toLocaleDateString("en-CA")
    const last = localStorage.getItem("amaso-last-open-date")
    if (last && last !== today) {
      const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("en-CA")
      fetch("/api/mobile/daily-summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: yesterday }),
      }).catch(() => {})
    }
    localStorage.setItem("amaso-last-open-date", today)
  }, [])

  // Load today's spar conversation on mount (one chat per day)
  useEffect(() => {
    async function loadTodayConversation() {
      try {
        const listRes = await fetch("/api/spar/conversations")
        if (!listRes.ok) return
        const listBody = await listRes.json() as { conversations?: Array<{ id: number; createdAt: number }> }
        const list = listBody.conversations
        if (!Array.isArray(list) || list.length === 0) return

        // Find the conversation created today (local date)
        const todayStr = new Date().toLocaleDateString("en-CA")
        const todayConv = list.find(c => new Date(c.createdAt).toLocaleDateString("en-CA") === todayStr)
        if (!todayConv) return  // No conversation yet today — seed greeting stays, first send creates one

        const detailRes = await fetch(`/api/spar/conversations/${todayConv.id}`, { cache: "no-store" })
        if (!detailRes.ok) return
        const body = await detailRes.json() as {
          messages?: Array<{
            id: number
            role: "user" | "assistant" | "system"
            content: string
            toolCalls: unknown
            createdAt: number
          }>
        }
        const incoming = Array.isArray(body.messages) ? body.messages : []
        if (incoming.length === 0) return

        const hydrated: ChatMsg[] = []
        let nextId = 1
        for (const m of incoming) {
          if (m.role !== "user" && m.role !== "assistant") continue
          const time = new Date(m.createdAt).toLocaleTimeString("nl", { hour: "2-digit", minute: "2-digit" })
          let steps: MobileToolStep[] | undefined
          if (m.role === "assistant" && Array.isArray(m.toolCalls)) {
            const arr = m.toolCalls as Array<{ id?: unknown; label?: unknown; detail?: unknown; status?: unknown }>
            const mapped = arr
              .filter(s => s && typeof s.id === "string" && typeof s.label === "string")
              .map(s => ({
                id: s.id as string,
                label: s.label as string,
                detail: typeof s.detail === "string" ? s.detail : "",
                status: (s.status === "running" ? "ok" : (s.status ?? "ok")) as "ok" | "error",
              }))
            if (mapped.length > 0) steps = mapped
          }
          hydrated.push({
            id: nextId++,
            role: m.role === "assistant" ? "ai" : "user",
            time,
            content: m.content,
            ...(steps ? { steps } : {}),
          })
        }

        if (hydrated.length > 0) {
          conversationIdRef.current = todayConv.id
          setConversationId(todayConv.id)
          setMessages(hydrated)
        }
      } catch {}
    }
    loadTodayConversation()
  }, [])

  const addAttachments = useCallback((files: FileList) => {
    const readers: Promise<MobileAttachment>[] = Array.from(files).map(file =>
      new Promise<MobileAttachment>(resolve => {
        const reader = new FileReader()
        reader.onload = e => resolve({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name,
          type: file.type,
          size: file.size,
          dataUrl: e.target?.result as string,
        })
        reader.readAsDataURL(file)
      })
    )
    Promise.all(readers).then(newAttachments => {
      setAttachments(prev => [...prev, ...newAttachments])
    })
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  // SSE chat send — wired to /api/spar NDJSON streaming
  const handleSend = useCallback(async (text: string) => {
    if (!text.trim() && attachmentsRef.current.length === 0) return

    // iOS standalone PWA gates audio playback behind a user gesture.
    // handleSend is invoked from the send-button onClick chain, so
    // this prime() runs INSIDE the user gesture and unlocks the
    // shared audio element for the rest of the session. Idempotent
    // after the first call.
    tts.prime()

    // Interrupt any in-flight TTS playback the instant the user fires
    // a new turn. Matches desktop behaviour: a fresh question always
    // wins over the previous reply's voice-over.
    tts.stop()

    const snap = attachmentsRef.current
    setAttachments([])

    const now = new Date().toLocaleTimeString("nl", { hour: "2-digit", minute: "2-digit" })
    const userMsg: ChatMsg = {
      id: Date.now(), role: "user", time: now, content: text,
      attachments: snap.length > 0 ? snap : undefined,
    }
    const aiId = Date.now() + 1
    const startedAt = Date.now()
    const aiMsg: ChatMsg = { id: aiId, role: "ai", time: now, content: "", streaming: true, generationStartedAt: startedAt }

    setMessages(prev => [...prev, userMsg, aiMsg])

    // Each retry attempt rebinds this so the idle-watchdog can abort
    // its own attempt without poisoning the next one. abortRef.current
    // always points to the most recent ctrl so a subsequent
    // handleSend (or hangup) call can cancel whichever is in flight.
    if (abortRef.current) abortRef.current.abort()
    let ctrl = new AbortController()
    abortRef.current = ctrl

    // Build history snapshot (capture before setMessages resolves)
    const historySnap = [...messages, userMsg]
      .filter(m => (m.role === "user" && m.content) || (m.role === "ai" && m.content && !m.streaming))
      .map(m => ({
        role: m.role === "user" ? "user" as const : "assistant" as const,
        content: m.content || "",
      }))

    let realChunksEmitted = false
    let allAttemptsFailed = false
    let accumulatedText = ""
    let accumulatedSteps: MobileToolStep[] = []

    // Parse one NDJSON line. Mutates accumulatedText / accumulatedSteps
    // / conversationIdRef. Returns true when the line produced a
    // visible change worth pushing to the DOM. Shared by the inner
    // loop AND the tail-drain path so the same parsing logic runs
    // whether or not the final chunk arrived with a trailing newline.
    const consumeLine = (line: string): boolean => {
      const trimmed = line.trim()
      if (!trimmed) return false
      let evt: Record<string, unknown>
      try { evt = JSON.parse(trimmed) } catch { return false }
      if (!evt || typeof evt !== "object") return false
      const t = evt.t
      if (t === "ping") return false
      if (t === "conversation" && typeof evt.id === "number") {
        if (conversationIdRef.current !== evt.id) {
          conversationIdRef.current = evt.id
          setConversationId(evt.id)
        }
        return false
      }
      if (t === "text" && typeof evt.v === "string") {
        const v = evt.v
        if (
          accumulatedText &&
          /[.!?]['")\]]?$/.test(accumulatedText) &&
          /^[A-Za-z0-9]/.test(v)
        ) {
          accumulatedText += " "
        }
        accumulatedText += v
        if (!realChunksEmitted) realChunksEmitted = true
        return true
      }
      if (t === "tool_use" && typeof evt.id === "string") {
        accumulatedSteps = [...accumulatedSteps, {
          id: evt.id as string,
          label: typeof evt.label === "string" ? evt.label : evt.id as string,
          detail: typeof evt.detail === "string" ? evt.detail : "",
          status: "running" as const,
        }]
        if (!realChunksEmitted) realChunksEmitted = true
        return true
      }
      if (t === "tool_result" && typeof evt.id === "string") {
        const ok = evt.ok !== false
        accumulatedSteps = accumulatedSteps.map(s =>
          s.id === evt.id ? { ...s, status: ok ? "ok" as const : "error" as const } : s
        )
        return true
      }
      if (t === "error" && typeof evt.v === "string") {
        accumulatedText = accumulatedText
          ? accumulatedText + `\n[error: ${evt.v}]`
          : `[error: ${evt.v as string}]`
        return true
      }
      return false
    }

    // Push the latest accumulated state to the AI bubble.
    const flushToDom = () => {
      const soFarText = accumulatedText
      const soFarSteps = accumulatedSteps
      setMessages(prev => prev.map(m =>
        m.id === aiId ? { ...m, content: soFarText, steps: soFarSteps } : m
      ))
    }

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      if (RETRY_DELAYS[attempt] > 0) {
        console.info(
          `[mobile-spar] retry attempt ${attempt + 1}/${RETRY_DELAYS.length} ` +
          `after ${RETRY_DELAYS[attempt]}ms backoff`,
        )
        await new Promise<void>(r => setTimeout(r, RETRY_DELAYS[attempt]))
        // Reset accumulators ONLY when the previous attempt produced
        // nothing visible. Retrying after partial content would
        // double-write (the server starts the reply from scratch),
        // so when partial text exists the catch block below will
        // have already broken out of the loop and committed it.
        accumulatedText = ""
        accumulatedSteps = []
        flushToDom()
      } else {
        console.info(`[mobile-spar] stream start attempt ${attempt + 1}/${RETRY_DELAYS.length}`)
      }

      let r: Response
      try {
        r = await fetch("/api/spar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            autopilot: false,
            conversationId: conversationIdRef.current ?? undefined,
            messages: historySnap,
            attachments: snap.length > 0
              ? snap.map(a => ({ name: a.name, type: a.type, dataUrl: a.dataUrl }))
              : undefined,
            model: tweaks.sparModel,
            tone: tweaks.sparTone,
            memory: tweaks.sparMemory,
            // Topic scope: when the user has the pill active, tell
            // /api/spar to prepend the topic's summary + recent
            // tagged messages to the system context.
            ...(activeTopicRef.current
              ? { topicId: activeTopicRef.current.id }
              : {}),
          }),
          signal: ctrl.signal,
        })
      } catch (err: any) {
        if (err?.name === "AbortError") {
          console.info("[mobile-spar] fetch aborted (user cancelled)")
          return
        }
        console.warn(`[mobile-spar] fetch threw on attempt ${attempt + 1}:`, err?.message ?? err)
        if (attempt < RETRY_DELAYS.length - 1) continue
        allAttemptsFailed = true
        break
      }

      if (!r.ok || !r.body) {
        console.warn(`[mobile-spar] bad response on attempt ${attempt + 1}: status=${r.status} hasBody=${!!r.body}`)
        if (attempt < RETRY_DELAYS.length - 1) continue
        allAttemptsFailed = true
        break
      }

      const reader = r.body.getReader()
      const decoder = new TextDecoder()
      let lineBuf = ""
      let streamFailed = false
      // Set by the idle-timeout watchdog so the catch block can
      // distinguish a 60s-no-event abort from a user-cancel abort
      // (both throw AbortError on reader.read()).
      let timedOut = false
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      const armIdleTimeout = () => {
        if (idleTimer !== null) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          console.warn(
            `[mobile-spar] stream idle for ${STREAM_IDLE_TIMEOUT_MS}ms — ` +
            `aborting (partial text so far: ${accumulatedText.length} chars)`,
          )
          timedOut = true
          try { ctrl.abort() } catch { /* already aborted */ }
        }, STREAM_IDLE_TIMEOUT_MS)
      }
      const clearIdleTimeout = () => {
        if (idleTimer !== null) { clearTimeout(idleTimer); idleTimer = null }
      }
      armIdleTimeout()

      try {
        while (true) {
          const { done, value } = await reader.read()
          // Every successful read resets the idle watchdog — gives
          // the server another 60s of headroom regardless of payload
          // size or pacing.
          armIdleTimeout()
          if (done) {
            console.info(
              `[mobile-spar] stream done (text=${accumulatedText.length} chars, ` +
              `steps=${accumulatedSteps.length})`,
            )
            break
          }
          lineBuf += decoder.decode(value, { stream: true })
          let nl: number
          let touched = false
          while ((nl = lineBuf.indexOf("\n")) !== -1) {
            const line = lineBuf.slice(0, nl)
            lineBuf = lineBuf.slice(nl + 1)
            if (consumeLine(line)) touched = true
          }
          if (touched) flushToDom()
        }
        // Drain tail line that arrived without a trailing newline.
        // Critical: parse AND flush — the previous version parsed
        // but never pushed to the DOM, so a final chunk with no
        // trailing newline was visible only via the post-loop
        // setMessages, which is correct ONLY if that final
        // setMessages actually runs. If we got here we DID exit
        // the read loop cleanly so it WILL run, but the same
        // flushToDom() here makes the path symmetric with the
        // error / timeout branches below.
        if (consumeLine(lineBuf)) {
          lineBuf = ""
          flushToDom()
        }
        clearIdleTimeout()
      } catch (err: any) {
        clearIdleTimeout()
        // Salvage any text already parsed and any tail-fragment in
        // the buffer BEFORE deciding whether to retry. Otherwise a
        // mid-stream throw drops the partial reply on the floor.
        if (consumeLine(lineBuf)) {
          lineBuf = ""
          flushToDom()
        }
        if (err?.name === "AbortError") {
          if (timedOut) {
            console.warn(
              `[mobile-spar] timeout abort handled — ` +
              `realChunks=${realChunksEmitted}, text=${accumulatedText.length} chars`,
            )
            // If we already have visible content, commit it as-is
            // (the model probably finished and the tail trickle
            // just never closed). Retrying would replay the
            // request and the server starts a NEW turn, producing
            // a duplicate. Only retry on a timeout that yielded
            // zero output.
            if (realChunksEmitted) {
              streamFailed = false
              break
            }
            streamFailed = true
            // The aborted controller is now poisoned — give the next
            // attempt a fresh one, otherwise the next fetch will
            // throw AbortError immediately on signal: ctrl.signal.
            if (attempt < RETRY_DELAYS.length - 1) {
              ctrl = new AbortController()
              abortRef.current = ctrl
            }
            continue
          }
          console.info("[mobile-spar] stream aborted (user cancelled)")
          return
        }
        console.warn(`[mobile-spar] stream threw on attempt ${attempt + 1}:`, err?.message ?? err)
        streamFailed = true
        // Same logic as the timeout branch: if we already have
        // visible content, keep it; don't retry into a duplicate.
        if (realChunksEmitted) break
        if (attempt >= RETRY_DELAYS.length - 1) break
        continue
      }

      if (!streamFailed) break
    }

    const generationTime = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
    setMessages(prev => prev.map(m =>
      m.id === aiId ? {
        ...m,
        content: allAttemptsFailed
          ? "Connection lost after 3 attempts — please try again."
          : accumulatedText,
        streaming: false,
        steps: accumulatedSteps,
        generationTime,
      } : m
    ))

    // Auto-speak the completed reply. Skipped when the user has the
    // setting off, when the stream failed (we'd be reading an error
    // placeholder), or when the assistant emitted nothing visible
    // (e.g. tool-only turn). The TTS hook itself handles the leg
    // pre-check + abort coordination — no extra gating needed here.
    const tt = ttsTweaksRef.current
    const finalText = allAttemptsFailed ? "" : accumulatedText.trim()
    if (tt.autoPlay && finalText) {
      // Mark this bubble as the typewriter target so the chat surface
      // can pace character reveal against audio.currentTime.
      setTtsAiId(aiId)
      void tts.speak(finalText, {
        voice: tt.voice,
        speed: tt.speed,
        pitch: tt.pitch,
        volume: tt.volume,
        deviceId: pwaDeviceIdRef.current,
      })
    }
  }, [messages, tweaks, tts])

  const openProject = useCallback((p: Project) => {
    setProject(p)
    setScreen("workspace")
    setLeftOpen(false)
  }, [])

  const openDailyChat = useCallback(() => {
    setLeftOpen(false)
    setScreen("chat")
  }, [])

  const openDay = useCallback((d: DayCard) => {
    setViewedDay(d)
    setScreen("day")
    setLeftOpen(false)
  }, [])

  return (
    <div className="amaso-app">
      {/* Universal banner: rendered above every screen so the user
          always knows when another device holds the audio leg.
          Renders nothing when WE hold it or no leg exists, so the
          common case is zero-cost visually. Sits at z=150 — below
          the call screen (z=200, so the call screen's own
          "blocked/released" panel takes the room) and below the
          sidebars (also z=200+ when open). */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0,
        paddingTop: "env(safe-area-inset-top, 0px)",
        zIndex: 150, pointerEvents: "none",
      }}>
        <div style={{ pointerEvents: "auto" }}>
          <AudioLegBanner localDeviceId={pwaDeviceIdRef.current} variant="mobile" />
        </div>
      </div>

      {screen === "chat" && (
        <ChatScreen
          messages={messages}
          setMessages={setMessages}
          project={project}
          autopilot={autopilot}
          onLeft={() => setLeftOpen(true)}
          onRight={() => setRightOpen(true)}
          onReview={() => setScreen("review")}
          tweaks={tweaks}
          onSend={handleSend}
          attachments={attachments}
          onAddAttachments={addAttachments}
          onRemoveAttachment={removeAttachment}
          conversationIdRef={conversationIdRef}
          setConversationId={setConversationId}
          pwaDeviceId={pwaDeviceIdRef.current}
          ttsAudioRef={tts.audioRef}
          ttsPlaying={tts.playing}
          ttsAiId={ttsAiId}
          activeTopic={activeTopic}
          onClearTopic={() => setActiveTopic(null)}
        />
      )}

      {screen === "day" && viewedDay && (
        <DayChatViewWrapper
          day={viewedDay}
          onBack={() => { setViewedDay(null); setScreen("chat") }}
          onLeft={() => setLeftOpen(true)}
          tweaks={tweaks}
        />
      )}

      {screen === "workspace" && project && (
        <WorkspaceScreen
          project={project}
          onBack={() => setScreen("chat")}
          onAsk={() => setScreen("chat")}
          onLeft={() => setLeftOpen(true)}
        />
      )}

      {screen === "settings" && (
        <SettingsScreen
          onBack={() => setScreen("chat")}
          tweaks={tweaks}
          setTweak={setTweak}
          user={user}
          teamCount={teamCount}
          deviceCount={deviceCount}
          onSignOut={handleSignOut}
        />
      )}

      {screen === "brain" && (
        <BrainScreen onBack={() => setScreen("chat")} />
      )}

      {screen === "review" && (
        <ReviewScreen onBack={() => setScreen("chat")} />
      )}

      {screen === "history" && (
        <HistoryScreen
          onBack={() => setScreen("chat")}
          onNavigateToChat={() => setScreen("chat")}
          onScopeTopic={(topic) => {
            setActiveTopic(topic)
            setScreen("chat")
          }}
        />
      )}

      <LeftSidebar
        open={leftOpen}
        onClose={() => setLeftOpen(false)}
        today={today}
        dayHistory={dayHistory}
        workers={workers}
        tasks={tasks}
        onSelectDailyChat={openDailyChat}
        onSelectDay={openDay}
        onSettings={() => { setLeftOpen(false); setScreen("settings") }}
        onBrain={() => { setLeftOpen(false); setScreen("brain") }}
        onHistory={() => { setLeftOpen(false); setScreen("history") }}
        user={user}
      />

      <RightSidebar
        open={rightOpen}
        onClose={() => setRightOpen(false)}
        autopilot={autopilot}
        setAutopilot={setAutopilot}
      />
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Keep today's rolling-chat subject in sync with the server's derived
 * label (most recently active topic). Two staggered re-fetches per new
 * message:
 *   - 400ms: catches topics that resolve via the cheap matcher
 *     (Layer 1 synchronous path) — e.g. exact slug / alias hits.
 *   - 3000ms: catches the async Haiku-classifier path, where the
 *     attach lands a couple seconds after the message persists.
 * Both timers debounce a single fetch on rapid stream chunks because
 * the dependency is `messages.length`, not the array identity.
 */
function useDailySubjectSync(
  messages: ChatMsg[],
  today: { date: string; dailyChat: { id: number | null; subject: string } } | null,
  setToday: React.Dispatch<React.SetStateAction<{ date: string; dailyChat: { id: number | null; subject: string } } | null>>
) {
  const dailyId = today?.dailyChat.id ?? null;
  useEffect(() => {
    if (!dailyId) return;
    const refetch = () => {
      fetch("/api/mobile/today")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data && data.dailyChat) setToday(data);
        })
        .catch(() => {});
    };
    const t1 = setTimeout(refetch, 400);
    const t2 = setTimeout(refetch, 3000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [messages.length, dailyId, setToday]);
}

function DayChatViewWrapper({
  day, onBack, onLeft, tweaks
}: { day: DayCard; onBack: () => void; onLeft: () => void; tweaks: Tweaks }) {
  return <DayChatView day={day} onBack={onBack} onLeft={onLeft} tweaks={tweaks} />
}
