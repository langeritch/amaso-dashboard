"use client";

import { useEffect, useRef, useState } from "react";
import {
  Square,
  RotateCcw,
  Keyboard,
  Maximize2,
  Minimize2,
  ArrowDown,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
} from "lucide-react";
// Side-effect CSS import — Next.js bundles; TS just needs to not care
import "@xterm/xterm/css/xterm.css";
import { useVoiceChannel } from "./useVoiceChannel";

/** Cheap NL-vs-EN detector based on presence of high-frequency, language-
 *  exclusive function words. Accurate enough to steer the TTS voice even on
 *  one-sentence replies; falls through to English on ties because iOS always
 *  ships an English voice but not always a Dutch one. */
function detectSpeechLang(text: string): "nl-NL" | "en-US" {
  const padded = " " + text.toLowerCase().replace(/[^\p{L}\s]/gu, " ") + " ";
  const nlMarkers = [
    " de ",
    " het ",
    " een ",
    " niet ",
    " maar ",
    " voor ",
    " naar ",
    " met ",
    " zijn ",
    " heeft ",
    " wordt ",
    " bij ",
    " uit ",
    " ook ",
    " ik ",
    " je ",
    " we ",
    " dat ",
    " dit ",
    " als ",
    " dus ",
  ];
  const enMarkers = [
    " the ",
    " and ",
    " you ",
    " that ",
    " this ",
    " with ",
    " have ",
    " are ",
    " was ",
    " will ",
    " would ",
    " from ",
    " there ",
    " about ",
    " but ",
    " not ",
    " for ",
    " what ",
    " when ",
    " which ",
  ];
  let nl = 0;
  let en = 0;
  for (const w of nlMarkers) if (padded.includes(w)) nl++;
  for (const w of enMarkers) if (padded.includes(w)) en++;
  return nl > en ? "nl-NL" : "en-US";
}

/** Heuristic: is this line mostly code/symbols rather than prose? We check
 *  the ratio of syntax characters to letters. Tight threshold — we err on
 *  the side of keeping prose rather than reading code aloud. */
function looksLikeCode(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (/^[-+]\s/.test(trimmed)) return true; // diff markers
  if (/^\s*\d+\s*[→:|]/.test(line)) return true; // line-number prefix
  const letters = (trimmed.match(/[a-zA-Z]/g) || []).length;
  const symbols = (trimmed.match(/[{}()[\];=<>/\\|&*`]/g) || []).length;
  if (letters + symbols < 8) return false;
  return symbols / (letters + symbols) > 0.25;
}

/** Turn a block of xterm buffer text into a spoken *summary* of Claude's
 *  reply — not a full read-aloud. We keep:
 *    - prose lines (explanations, intent)
 *    - tool-call headers (● Edit(foo.ts), ● Write(...)) so the user hears
 *      what Claude is doing
 *  and skip:
 *    - the TUI chrome at the bottom (input box, hints)
 *    - fenced code blocks
 *    - tool body output (the indented lines under ⎿) — diffs, file dumps,
 *      command output
 *    - code-looking lines
 *    - the pulse status ("* Baked for 3m") */
// Collapse Claude Code tool-call headers like "Edit(src/foo.tsx)" or
// "Bash(npm run build)" to a short spoken phrase ("editing file",
// "running command"). Anything that doesn't look like a tool call —
// plain prose after the bullet — is passed through unchanged.
function summarizeToolCall(line: string): string {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (!m) return line.replace(/\s+/g, " ");
  const map: Record<string, string> = {
    Bash: "running command",
    Edit: "editing file",
    MultiEdit: "editing file",
    Write: "writing file",
    Read: "reading file",
    Glob: "finding files",
    Grep: "searching code",
    Task: "delegating to subagent",
    Agent: "delegating to subagent",
    WebFetch: "fetching webpage",
    WebSearch: "searching the web",
    TodoWrite: "updating tasks",
    TaskCreate: "creating task",
    TaskUpdate: "updating task",
    TaskList: "checking tasks",
    NotebookEdit: "editing notebook",
    ExitPlanMode: "presenting plan",
    AskUserQuestion: "asking a question",
    ToolSearch: "loading a tool",
    Skill: "running skill",
    ScheduleWakeup: "scheduling wakeup",
  };
  return map[m[1]] ?? m[1].toLowerCase();
}

function cleanForSpeech(raw: string): { text: string; scopeHead: string } {
  const rawLines = raw.split("\n");
  const strip = (s: string) =>
    s
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
      .replace(/[\u2500-\u257f]/g, "")
      .replace(/[\u2800-\u28ff]/g, "");
  const isChrome = (line: string) => {
    const stripped = strip(line).trim();
    if (stripped === "" || stripped === ">") return true;
    if (/[⏵▶]/.test(line)) return true;
    if (/accept\s*edits/i.test(line)) return true;
    if (/shift\s*[-+]?\s*tab/i.test(line)) return true;
    if (/\?\s*for\s*shortcuts/i.test(line)) return true;
    return false;
  };
  let end = rawLines.length;
  while (end > 0 && isChrome(rawLines[end - 1])) end--;

  // Scope to the latest assistant turn. Claude Code's TUI marks each
  // assistant bullet (prose reply, tool call) with ● / ⏺, and on response
  // completion it often redraws the full conversation into scrollback —
  // without this the speaker re-reads every prior reply in the range.
  // If no bullet is present, refuse to speak — the buffer doesn't contain
  // a recognizable assistant turn, and the old "start from 0" fallback
  // caused enormous Kokoro synths whenever we scanned full scrollback.
  let start = -1;
  for (let i = end - 1; i >= 0; i--) {
    if (/[●⏺]/.test(rawLines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return { text: "", scopeHead: "" };
  const scopeHead = strip(rawLines[start]).replace(/\s+/g, " ").trim().slice(0, 80);

  const kept: string[] = [];
  let inCodeBlock = false;
  let inToolBody = false;
  for (let i = start; i < end; i++) {
    const rawLine = rawLines[i];
    const stripped = strip(rawLine).trim();
    // Code fences: skip the whole block.
    if (/^```/.test(stripped)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;
    // Tool body marker: ⎿ opens a block of indented output (diff, file
    // content, shell output). Skip until we hit a non-indented prose line.
    if (/⎿/.test(rawLine)) {
      inToolBody = true;
      continue;
    }
    if (inToolBody) {
      const isIndented = /^\s{2,}/.test(rawLine);
      if (isIndented || looksLikeCode(rawLine) || stripped === "") continue;
      inToolBody = false;
    }
    if (stripped === "" || stripped === ">" || stripped === "❯") continue;
    if (/^[>❯]\s/.test(stripped)) continue; // user prompt echo (ASCII > or U+276F ❯)
    // Thinking-status lines: "* Baked for 3m", "✽ Warping…", "· Slithering…",
    // "● Thinking ⎿ …". Match any short line that starts with a non-letter
    // glyph (or the Thinking bullet) and contains an ellipsis / the word
    // "thinking". Catches the full set of whimsical verbs Claude Code
    // rotates through without enumerating them.
    if (/^[^A-Za-z0-9]\s*\S+.*(?:…|thinking)/i.test(stripped)) continue;
    if (/^[●•⏺]\s*Thinking\b/i.test(stripped)) continue;
    // Tool call header: "● Edit(foo.ts)" → speak "editing file".
    // Non-tool lines ("● That works, thanks!") get passed through.
    const toolHeader = stripped.match(/^[●•⏺]\s*(.+)/);
    if (toolHeader) {
      kept.push(summarizeToolCall(toolHeader[1]));
      continue;
    }
    // Sometimes the bullet and the tool name land on separate lines
    // ("●\nEdit(file.tsx)") — catch the bare "ToolName(args)" form too.
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(stripped)) {
      kept.push(summarizeToolCall(stripped));
      continue;
    }
    if (looksLikeCode(rawLine)) continue;
    kept.push(stripped.replace(/\s+/g, " "));
  }
  return { text: kept.join(". "), scopeHead };
}

// Minimal shape of the non-standard Web Speech API we need. Declared
// locally so TS doesn't fight us over the lack of lib.dom coverage.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives?: number;
  onresult:
    | ((event: {
        resultIndex: number;
        results: {
          isFinal: boolean;
          0: { transcript: string; confidence: number };
        }[];
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

/**
 * Full-fidelity Claude CLI terminal, streamed from the dashboard server's
 * per-project PTY session. xterm.js renders ANSI escape codes, handles
 * keyboard input, and the WebSocket moves bytes both ways.
 *
 * The xterm library is large and only works in the browser — we import it
 * dynamically on mount to keep the SSR bundle small.
 */
export default function TerminalPane({
  projectId,
  canManage,
  fullscreen = false,
  onToggleFullscreen,
}: {
  projectId: string;
  canManage: boolean;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<unknown>(null); // xterm Terminal instance
  const fitRef = useRef<unknown>(null); // FitAddon instance
  const wsRef = useRef<WebSocket | null>(null);
  // Called after every incoming PTY chunk so the jump-to-bottom pill can
  // bump its unread count even when xterm doesn't fire onScroll (viewport
  // parked in scrollback while new lines append).
  const scrollSyncRef = useRef<(() => void) | null>(null);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>("…");
  // Height of the space the on-screen keyboard currently occupies. Used as
  // padding-bottom on the pane so the xterm host shrinks above the keyboard
  // on iOS versions that ignore `interactive-widget=resizes-content`.
  const [kbInset, setKbInset] = useState(0);
  // Jump-to-bottom state. `scrolledUp` drives button visibility; `unread` is
  // the number of new scrollback lines added since the user scrolled away,
  // measured as the delta in buffer.baseY from the point of scroll-up.
  const [scrolledUp, setScrolledUp] = useState(false);
  const [unread, setUnread] = useState(0);
  const scrollUpBaseYRef = useRef(0);
  // Voice dictation. The Web Speech API is prefixed on Safari/iOS as
  // `webkitSpeechRecognition`; we feature-detect rather than type-import it.
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  // TTS support: when dictation is on, we also read Claude's replies out
  // loud. `listeningRef` mirrors the state for use inside long-lived
  // callbacks (xterm onData, ws onmessage) without stale closures.
  // `submitLineRef` records the buffer position where the user's prompt
  // went in; that's the starting line we want to read back after idle.
  const listeningRef = useRef(false);
  const submitLineRef = useRef<number | null>(null);
  const ttsIdleTimerRef = useRef<number | null>(null);
  // Streaming TTS state. `spokenCharsRef` is the char offset into the
  // current cleaned reply that has already been queued to speak — we keep
  // appending new sentences as Claude's output grows instead of waiting
  // for full idle. `ttsFinalTimerRef` is the longer debounce that declares
  // the reply finished and flushes any trailing text without punctuation.
  // `lastSpeechTokenRef` holds an opaque marker for the most recently
  // queued chunk so its end-callback can re-open the mic only if nothing
  // newer has been queued since.
  // `spokenByScopeRef` records how far we've already spoken *per `●`
  // bullet* (keyed by the first 80 chars of that line). The TUI often
  // flips the newest bullet between thinking indicators and the real
  // reply mid-stream; keying by bullet identity prevents re-speaking
  // the reply every time it becomes "last" again.
  const spokenByScopeRef = useRef<Map<string, number>>(new Map());
  const ttsFinalTimerRef = useRef<number | null>(null);
  const replyCompleteRef = useRef(false);
  const lastSpeechTokenRef = useRef<object | null>(null);
  // Kokoro audio pipeline. A single reusable <audio> element (mounted
  // hidden below) plays WAV blobs fetched from /api/tts in FIFO order.
  // `ttsQueueRef` holds chunks whose audio has finished downloading but
  // hasn't started yet; `ttsCurrentRef` is whatever is playing now.
  // `ttsFetchChainRef` serializes fetches so blobs land in submission
  // order regardless of network jitter. `ttsPrimedRef` tracks whether
  // we've unlocked iOS autoplay via a user gesture.
  type TtsChunk = {
    url: string;
    token: object;
    onEnd: () => void;
    onErr: (e: unknown) => void;
  };
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const ttsQueueRef = useRef<TtsChunk[]>([]);
  const ttsCurrentRef = useRef<TtsChunk | null>(null);
  // Serial fetch chain so blobs land at the sidecar one at a time and
  // don't pile up behind the ORT inference lock. Parallelizing chunks
  // made the perceived latency *worse* — at 3–5 chunks per reply the
  // sidecar serialized them anyway while contention slowed each synth.
  const ttsFetchChainRef = useRef<Promise<void>>(Promise.resolve());
  const ttsPrimedRef = useRef(false);
  // Bumped on every ttsCancel(). Fetches check it before pushing their
  // resolved blob into the queue — stale WAVs from the previous turn
  // would otherwise play FIFO behind the new one.
  const ttsGenRef = useRef(0);
  // Every in-flight /api/tts fetch registers its AbortController here so
  // ttsCancel() can interrupt the network leg too, not just drop the
  // eventual blob. Saves the server from synthesizing discarded audio.
  const ttsInFlightRef = useRef<Set<AbortController>>(new Set());
  // Shared voice-session awareness. When a Telegram call is live the
  // phone is voicing the assistant's reply — this pane's TTS must go
  // completely silent, even if a turn was already mid-synthesis. The
  // server-side /api/tts returns 204 once the channel flips, but
  // that only covers *new* fetches: blobs already in `ttsQueueRef`
  // or actively playing in the audio element need to be torn down
  // on the same tick as the channel change, which is what the
  // useEffect below does.
  const voice = useVoiceChannel();
  const telegramActiveRef = useRef(false);

  function ttsPlayNext() {
    const el = audioElRef.current;
    if (!el || ttsCurrentRef.current) return;
    const next = ttsQueueRef.current.shift();
    if (!next) return;
    ttsCurrentRef.current = next;
    el.src = next.url;
    el.play().catch((err) => {
      logTts(`play threw: ${String(err).slice(0, 60)}`);
      const cur = ttsCurrentRef.current;
      ttsCurrentRef.current = null;
      try {
        URL.revokeObjectURL(next.url);
      } catch {
        /* ignore */
      }
      if (cur) cur.onErr(err);
      ttsPlayNext();
    });
  }

  function ttsCancel() {
    for (const item of ttsQueueRef.current) {
      try {
        URL.revokeObjectURL(item.url);
      } catch {
        /* ignore */
      }
    }
    ttsQueueRef.current = [];
    const el = audioElRef.current;
    const cur = ttsCurrentRef.current;
    ttsCurrentRef.current = null;
    if (el) {
      try {
        el.pause();
      } catch {
        /* ignore */
      }
      if (el.src) {
        try {
          URL.revokeObjectURL(el.src);
        } catch {
          /* ignore */
        }
        el.removeAttribute("src");
        try {
          el.load();
        } catch {
          /* ignore */
        }
      }
    }
    if (cur) {
      try {
        URL.revokeObjectURL(cur.url);
      } catch {
        /* ignore */
      }
    }
    lastSpeechTokenRef.current = null;
    ttsGenRef.current += 1;
    for (const ctrl of ttsInFlightRef.current) {
      try {
        ctrl.abort();
      } catch {
        /* ignore */
      }
    }
    ttsInFlightRef.current.clear();
  }

  // Hard-stop when a Telegram call takes over the shared audio
  // channel. ttsCancel revokes every queued blob URL, aborts in-
  // flight fetches, pauses the element, and removes its src.
  // We also stop the SpeechRecognition mic: the phone is the
  // authoritative input while the call is live, and letting Web
  // Speech keep running here would pipe laptop-room audio straight
  // into the project terminal. On the telegram → null edge the
  // normal onend restart loop re-arms the mic (gated on
  // telegramActiveRef so it won't fire until the call has actually
  // ended).
  useEffect(() => {
    const onTelegram = voice.channel === "telegram";
    const wasOnTelegram = telegramActiveRef.current;
    telegramActiveRef.current = onTelegram;
    if (onTelegram && !wasOnTelegram) {
      ttsCancel();
      if (recRestartTimerRef.current) {
        window.clearTimeout(recRestartTimerRef.current);
        recRestartTimerRef.current = null;
      }
      try {
        recognitionRef.current?.stop();
      } catch {
        /* already stopping */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.channel]);

  function ttsSpeaking() {
    return ttsCurrentRef.current !== null;
  }
  function ttsPending() {
    return ttsQueueRef.current.length > 0;
  }

  // Unlock iOS autoplay by kicking the shared <audio> element inside a
  // user gesture. Safe to call repeatedly — after the first play() inside
  // a gesture, Safari lets us mutate .src and .play() at will.
  function ttsPrime() {
    if (ttsPrimedRef.current) return;
    const el = audioElRef.current;
    if (!el) return;
    ttsPrimedRef.current = true;
    // 44-byte WAV header with zero data samples → instantly "ends",
    // never produces audible output.
    el.src =
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
    el.play().catch(() => {
      /* primer rejection is fine on desktop — no gesture required there */
    });
  }
  // iOS Safari's webkitSpeechRecognition ends itself after every phrase, even
  // with `continuous = true`. `wantListeningRef` records whether the user
  // still wants mic-mode on, so an auto-end can restart the session without
  // flipping the `listening` UI state (which would also tear down the TTS
  // marker and cancel any pending reply-read).
  const wantListeningRef = useRef(false);
  const recRestartTimerRef = useRef<number | null>(null);
  // TTS output is independent of the mic. When enabled we read Claude's
  // replies even for keyboard-typed prompts. Seeded from localStorage so
  // the preference survives across reloads.
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const ttsEnabledRef = useRef(false);
  useEffect(() => {
    ttsEnabledRef.current = ttsEnabled;
    try {
      localStorage.setItem("amaso:ttsEnabled", ttsEnabled ? "1" : "0");
    } catch {
      /* storage disabled */
    }
  }, [ttsEnabled]);
  useEffect(() => {
    try {
      if (localStorage.getItem("amaso:ttsEnabled") === "1") setTtsEnabled(true);
    } catch {
      /* storage disabled */
    }
  }, []);
  // True while TTS is speaking (or about to). Blocks the recognition
  // auto-restart loop so iOS's shared audio session can fully release
  // from "recording" to "playback". Without this, speak() fires onerror.
  const ttsActiveRef = useRef(false);
  // Active language for both STT (recognition) and TTS (reply-read). Follows
  // Claude's reply — if the model answers in English, the next mic restart
  // picks up en-US, which also flips subsequent TTS output. Seeded from
  // navigator.language so the first session matches the user's device. The
  // ref is the source of truth inside long-lived callbacks; `activeLang`
  // mirrors it for the UI indicator chip.
  const currentLangRef = useRef<"nl-NL" | "en-US">("nl-NL");
  const [activeLang, setActiveLang] = useState<"nl-NL" | "en-US">("nl-NL");
  function setLang(next: "nl-NL" | "en-US") {
    if (currentLangRef.current === next) return;
    currentLangRef.current = next;
    setActiveLang(next);
  }
  // Rolling TTS debug log. Shows the last ~15 events (arm, flush, enqueue,
  // start, end, err, reopen) with millisecond deltas so we can trace the
  // full pipeline on-device without a dev console. Also console.log'd with
  // a [TTS] prefix for desktop debugging.
  type TtsLogEntry = { t: number; msg: string };
  const [ttsLog, setTtsLog] = useState<TtsLogEntry[]>([]);
  const ttsLogRef = useRef<TtsLogEntry[]>([]);
  const ttsLogStartRef = useRef<number>(0);
  function logTts(msg: string) {
    const now = Date.now();
    if (ttsLogRef.current.length === 0) ttsLogStartRef.current = now;
    const entry = { t: now - ttsLogStartRef.current, msg };
    ttsLogRef.current = [...ttsLogRef.current, entry].slice(-15);
    setTtsLog(ttsLogRef.current);
    try {
      console.log(`[TTS +${entry.t}ms] ${msg}`);
    } catch {
      /* ignore */
    }
  }
  function setTtsDebug(msg: string) {
    logTts(msg);
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const SR =
      (window as unknown as { SpeechRecognition?: unknown })
        .SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: unknown })
        .webkitSpeechRecognition;
    setVoiceSupported(Boolean(SR));
    // Seed the active language from the browser so the first mic session
    // doesn't start in Dutch for an English-configured device.
    const browserLang = (navigator.language || "nl-NL").toLowerCase();
    setLang(browserLang.startsWith("en") ? "en-US" : "nl-NL");
  }, []);

  // Keep the ref in sync with listening state, and stop any pending speech
  // when the user disables dictation mid-utterance.
  useEffect(() => {
    listeningRef.current = listening;
    // Only tear down the TTS pipeline if the user also has TTS-only mode
    // off — otherwise disabling the mic would silence keyboard-triggered
    // reads too.
    if (!listening && !ttsEnabledRef.current) {
      ttsCancel();
      if (ttsIdleTimerRef.current) {
        window.clearTimeout(ttsIdleTimerRef.current);
        ttsIdleTimerRef.current = null;
      }
      submitLineRef.current = null;
    }
  }, [listening]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;
    let rafId: number | null = null;
    function update() {
      // rAF-throttle: iOS fires `resize` ~60×/s during the keyboard
      // animation; each change would cascade into a fit + PTY-resize and
      // Claude can't keep up with a rerender per frame.
      if (rafId != null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        // window.innerHeight is the layout viewport; vv.height is the
        // visual viewport (keyboard subtracted). Their difference is the
        // keyboard height. On browsers that already shrink the layout
        // viewport this stays 0, so the fix is a no-op there.
        const inset = Math.max(
          0,
          window.innerHeight - vv!.height - vv!.offsetTop,
        );
        setKbInset(inset);
      });
    }
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      if (rafId != null) window.cancelAnimationFrame(rafId);
    };
  }, []);
  // The ResizeObserver inside the xterm mount effect already handles
  // fit+PTY-resize when the host shrinks on keyboard open — no extra
  // scrollToBottom here, because snapping to the bottom before Claude
  // has had a chance to repaint the new grid shows empty rows.
  // Tracks whether we've already issued the implicit "start" for the current
  // WebSocket connection, so a slow status round-trip doesn't make us spam
  // duplicate start messages.
  const autoStartedRef = useRef(false);

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempts = 0;
    const touchAbort = new AbortController();
    autoStartedRef.current = false;
    // Remember the last opened project so the PWA share-target flow
    // can bounce the user straight back into its terminal after iOS
    // hands us a screenshot.
    try {
      localStorage.setItem("amaso:lastProject", projectId);
    } catch {
      /* storage disabled */
    }
    // Touch devices get a different focus model: xterm would normally
    // refocus its hidden textarea on every tap, which pops the mobile
    // keyboard even when the user just wants to scroll. We suppress
    // that and expose a dedicated "Toetsenbord" button instead.
    const isTouch =
      typeof window !== "undefined" &&
      window.matchMedia("(pointer: coarse)").matches;

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);

      if (disposed || !hostRef.current) return;

      const term = new Terminal({
        // Claude CLI draws its own prompt cursor (`▌`), so on touch the
        // xterm cursor is just visual noise — especially because Claude
        // occasionally parks the logical cursor on an unrelated row and
        // it shows up as a bright green block above the keyboard.
        cursorBlink: !isTouch,
        fontSize: 13,
        fontFamily:
          'ui-monospace, "JetBrains Mono", Menlo, Consolas, "Courier New", monospace',
        theme: {
          background: "#0b0d10",
          foreground: "#e6e8eb",
          cursor: isTouch ? "rgba(0,0,0,0)" : "#ff6b3d",
          cursorAccent: isTouch ? "rgba(0,0,0,0)" : "#0b0d10",
          selectionBackground: "#2d3440",
        },
        allowProposedApi: true,
        scrollback: 10_000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon());
      term.open(hostRef.current);
      fit.fit();
      if (!isTouch) term.focus();

      termRef.current = term;
      fitRef.current = fit;

      // Track "am I viewing scrollback or live?" so we can show the
      // jump-to-bottom pill. xterm fires `onScroll` both on user scroll
      // and on content-pushed scroll, which is exactly the signal we want.
      function syncScrollState() {
        try {
          const buf = (
            term as unknown as {
              buffer: {
                active: { viewportY: number; baseY: number };
              };
            }
          ).buffer.active;
          if (buf.viewportY >= buf.baseY) {
            setScrolledUp(false);
            setUnread(0);
            scrollUpBaseYRef.current = buf.baseY;
          } else {
            setScrolledUp((wasUp) => {
              if (!wasUp) scrollUpBaseYRef.current = buf.baseY;
              return true;
            });
            setUnread(Math.max(0, buf.baseY - scrollUpBaseYRef.current));
          }
        } catch {
          /* xterm internals can race during teardown */
        }
      }
      (term as unknown as { onScroll: (cb: () => void) => void }).onScroll(
        syncScrollState,
      );
      // Also refresh after every inbound write — xterm only fires onScroll
      // when the viewport moves, but `baseY` grows silently when content
      // appends while the user is parked in scrollback.
      scrollSyncRef.current = syncScrollState;

      // Block xterm's built-in tap-to-focus on touch devices. xterm
      // listens on pointerdown / mousedown on its viewport to focus
      // the helper textarea; stopping propagation in the capture phase
      // on the wrapping host means those handlers never see the event.
      if (isTouch) {
        const stopFocusTap = (e: Event) => {
          const pt = (e as PointerEvent).pointerType;
          if (pt == null || pt === "touch") e.stopPropagation();
        };
        hostRef.current?.addEventListener("pointerdown", stopFocusTap, {
          capture: true,
          signal: touchAbort.signal,
        });
        hostRef.current?.addEventListener("mousedown", stopFocusTap, {
          capture: true,
          signal: touchAbort.signal,
        });
      }

      // Single-finger vertical drag → scrollback navigation. xterm's
      // canvas doesn't surface the scrollback to native touch gestures,
      // so on mobile the user can only see whatever is currently in the
      // visible grid. We translate drag delta to term.scrollLines(),
      // resetting the origin each frame so the gesture feels 1:1.
      // Horizontal drags and multi-touch are ignored — those are for
      // selection / text input and xterm handles them itself.
      const touchHost = hostRef.current;
      let touchStartY: number | null = null;
      let touchStartX = 0;
      let scrolling = false;
      touchHost?.addEventListener(
        "touchstart",
        (e) => {
          if (e.touches.length !== 1) {
            touchStartY = null;
            return;
          }
          touchStartY = e.touches[0].clientY;
          touchStartX = e.touches[0].clientX;
          scrolling = false;
        },
        { passive: true, signal: touchAbort.signal },
      );
      touchHost?.addEventListener(
        "touchmove",
        (e) => {
          if (touchStartY == null || e.touches.length !== 1) return;
          const t = e.touches[0];
          const dy = t.clientY - touchStartY;
          const dx = t.clientX - touchStartX;
          if (!scrolling) {
            if (Math.abs(dy) < 10) return;
            if (Math.abs(dy) <= Math.abs(dx)) return;
            scrolling = true;
            // Dismiss the on-screen keyboard the moment we're sure this
            // is a scroll gesture — otherwise it hovers over the output
            // and eats half the viewport.
            const active = document.activeElement;
            if (active instanceof HTMLElement) active.blur();
          }
          e.preventDefault();
          const rowH =
            touchHost && term.rows > 0
              ? touchHost.clientHeight / term.rows
              : 18;
          const lines = Math.trunc(-dy / rowH);
          if (lines !== 0) {
            term.scrollLines(lines);
            touchStartY = t.clientY;
          }
        },
        { passive: false, signal: touchAbort.signal },
      );
      const endTouch = () => {
        touchStartY = null;
        scrolling = false;
      };
      touchHost?.addEventListener("touchend", endTouch, {
        passive: true,
        signal: touchAbort.signal,
      });
      touchHost?.addEventListener("touchcancel", endTouch, {
        passive: true,
        signal: touchAbort.signal,
      });

      // --- Image ingress (paste, drop, PWA share target) ---------------
      // Three separate paths feed the same pipeline: upload the image
      // to the server → get back an absolute on-disk path → type that
      // path into the PTY so Claude can Read it. No prompt is submitted
      // automatically; the user adds their question and hits Enter.
      function sendImagePath(absPath: string) {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        // Trailing space keeps the cursor separated from whatever the
        // user types next. No Enter — they usually want to add context.
        ws.send(JSON.stringify({ type: "input", data: `${absPath} ` }));
      }
      async function uploadAndPaste(file: File) {
        try {
          const fd = new FormData();
          fd.append("file", file, file.name || "image.png");
          const res = await fetch(
            `/api/terminal/upload?projectId=${encodeURIComponent(projectId)}`,
            { method: "POST", body: fd },
          );
          if (!res.ok) {
            term.write(
              `\r\n\x1b[33m(upload failed: ${res.status})\x1b[0m\r\n`,
            );
            return;
          }
          const { path: abs } = (await res.json()) as { path?: string };
          if (abs) sendImagePath(abs);
        } catch {
          term.write("\r\n\x1b[33m(upload failed)\x1b[0m\r\n");
        }
      }
      function extractImages(list: FileList | File[] | null | undefined): File[] {
        if (!list) return [];
        const out: File[] = [];
        for (const f of Array.from(list)) {
          if (f instanceof File && f.size > 0 && f.type.startsWith("image/")) {
            out.push(f);
          }
        }
        return out;
      }
      // Paste: iOS long-press → Paste on the xterm textarea delivers
      // the image as a `File` entry on clipboardData. Capture-phase so
      // we run before xterm's own paste handler (which would otherwise
      // treat the empty clipboard text as a real paste).
      hostRef.current?.addEventListener(
        "paste",
        (e) => {
          const cd = (e as ClipboardEvent).clipboardData;
          const files: File[] = [];
          if (cd?.files && cd.files.length > 0) {
            files.push(...extractImages(cd.files));
          }
          if (files.length === 0 && cd?.items) {
            for (const it of Array.from(cd.items)) {
              if (it.kind === "file") {
                const f = it.getAsFile();
                if (f && f.type.startsWith("image/")) files.push(f);
              }
            }
          }
          if (files.length === 0) return;
          e.preventDefault();
          e.stopPropagation();
          for (const f of files) void uploadAndPaste(f);
        },
        { capture: true, signal: touchAbort.signal },
      );
      // Drop: drag from Photos (iOS 15+) or desktop file managers.
      // Dragover must preventDefault or the browser refuses the drop.
      hostRef.current?.addEventListener(
        "dragover",
        (e) => {
          if ((e as DragEvent).dataTransfer?.types?.includes("Files")) {
            e.preventDefault();
          }
        },
        { signal: touchAbort.signal },
      );
      hostRef.current?.addEventListener(
        "drop",
        (e) => {
          const files = extractImages(
            (e as DragEvent).dataTransfer?.files ?? null,
          );
          if (files.length === 0) return;
          e.preventDefault();
          e.stopPropagation();
          for (const f of files) void uploadAndPaste(f);
        },
        { signal: touchAbort.signal },
      );
      // When the hidden xterm textarea is focused (user tapped "Typen"
      // or long-pressed Paste), snap the xterm viewport to its newest
      // row. Without this the user sees whatever part of the scrollback
      // was on screen before — the current prompt could easily be
      // hidden above the freshly-opened keyboard.
      const xtermTextarea = (term as unknown as { textarea?: HTMLTextAreaElement })
        .textarea;
      // On iOS the helper textarea's native caret bleeds through as a
      // blinking vertical line above the keyboard (Claude draws its own
      // `▌`, so there's nothing useful to show). Hide it on touch.
      if (isTouch && xtermTextarea) {
        xtermTextarea.style.caretColor = "transparent";
      }
      xtermTextarea?.addEventListener(
        "focus",
        () => {
          try {
            term.scrollToBottom();
          } catch {
            /* xterm internals race; safe to ignore */
          }
          // Note: we used to also call `scrollIntoView({ block: 'end' })`
          // here as an iOS fallback, but combined with the visualViewport
          // padding-bottom it occasionally scrolled xterm's internal DOM
          // and left the prompt row off-screen.
        },
        { signal: touchAbort.signal },
      );

      // Share-target hand-off: ShareIngress stashed the on-disk path of
      // the iOS-shared screenshot in sessionStorage. Consume it once the
      // WS is live — before then `sendImagePath` is a no-op.
      function consumePendingShare() {
        try {
          const pending = sessionStorage.getItem("amaso:terminal-share");
          if (!pending) return;
          sessionStorage.removeItem("amaso:terminal-share");
          sendImagePath(pending);
        } catch {
          /* storage disabled */
        }
      }

      // Resize observer → keep the PTY in sync with the rendered grid.
      // The keyboard-open path does NOT resize the grid (see the transform
      // wrapper below); it only kicks in for real size changes like device
      // rotation or the browser window resizing on desktop.
      resizeObserver = new ResizeObserver(() => {
        try {
          fit.fit();
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "resize",
                cols: term.cols,
                rows: term.rows,
              }),
            );
          }
        } catch {
          /* resize can race with mount */
        }
      });
      resizeObserver.observe(hostRef.current);

      // xterm input always reads from the *current* socket on wsRef. Using
      // wsRef instead of a captured local means typing keeps working after
      // an auto-reconnect, instead of silently sending into a closed socket.
      term.onData((data: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
        // When TTS-mode is active (mic or standalone), track the buffer
        // position on each Enter so we know where Claude's reply starts.
        if (
          (listeningRef.current || ttsEnabledRef.current) &&
          (data.includes("\r") || data.includes("\n"))
        ) {
          markSubmitMarker();
          ttsCancel();
        }
      });

      function connect() {
        if (disposed) return;
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(
          `${proto}//${window.location.host}/api/terminal?projectId=${encodeURIComponent(projectId)}`,
        );
        wsRef.current = ws;

        ws.onopen = () => {
          reconnectAttempts = 0;
          // Re-arm auto-start so a freshly-reconnected client still spawns the
          // CLI if the server is between sessions.
          autoStartedRef.current = false;
          ws.send(
            JSON.stringify({
              type: "resize",
              cols: term.cols,
              rows: term.rows,
            }),
          );
          setStatus("connected");
          // Focus on (re)connect — if the user was waiting around for the
          // socket to come back, they almost certainly want to type again.
          // Skip on touch: that would silently pop the mobile keyboard
          // on every reconnect, which happens often during dev.
          if (!isTouch) term.focus();
          // Hand off any screenshot that arrived via the PWA share
          // target while we were still setting up the socket.
          consumePendingShare();
        };
        ws.onclose = () => {
          if (disposed) return;
          setStatus("reconnecting…");
          // Exponential backoff capped at 10s. Keeps trying forever — the
          // dashboard restarts during dev hot-reloads, and we don't want the
          // user to have to reload the page every time.
          reconnectAttempts += 1;
          const delay = Math.min(10_000, 500 * 2 ** (reconnectAttempts - 1));
          reconnectTimer = window.setTimeout(connect, delay);
        };
        ws.onerror = () => {
          // Don't set "error" status — onclose will fire next and trigger the
          // reconnect path with a clearer "reconnecting…" label.
        };

        ws.onmessage = (e) => {
          let msg: {
            type: string;
            data?: string;
            running?: boolean;
            exitCode?: number;
            message?: string;
          };
          try {
            msg = JSON.parse(e.data);
          } catch {
            return;
          }
          if (msg.type === "data" && typeof msg.data === "string") {
            term.write(msg.data, () => scrollSyncRef.current?.());
            // While dictation is active, stream speech as soon as Claude
            // emits complete sentences (300ms debounce), and run a longer
            // debounce (1200ms) to declare the reply done and flush any
            // trailing fragment without terminal punctuation.
            if (
              (listeningRef.current || ttsEnabledRef.current) &&
              submitLineRef.current != null
            ) {
              // Don't reset the partial timer on every chunk — if Claude
              // streams faster than the debounce, the timer never fires
              // and speech is stuck until end-of-reply. Instead, let it
              // fire every 200ms of streaming; each firing picks up
              // whatever new sentences have landed since last flush.
              if (ttsIdleTimerRef.current == null) {
                ttsIdleTimerRef.current = window.setTimeout(() => {
                  ttsIdleTimerRef.current = null;
                  logTts("flush:partial");
                  streamFlushSpeech(false);
                }, 60);
              }
              if (ttsFinalTimerRef.current) {
                window.clearTimeout(ttsFinalTimerRef.current);
              }
              ttsFinalTimerRef.current = window.setTimeout(() => {
                ttsFinalTimerRef.current = null;
                logTts("flush:final");
                streamFlushSpeech(true);
              }, 1200);
            }
          } else if (msg.type === "status") {
            const r = Boolean(msg.running);
            setRunning(r);
            setStatus(r ? "running" : "stopped");
            // Auto-spawn the session so the user never has to click "Start" —
            // the only legitimate reasons to be in `!running` here are:
            //   - first connection ever for this project
            //   - the previous process exited (crash / explicit kill)
            // In both cases we want the CLI back up immediately. Guard with a
            // ref so we don't loop if the server briefly reports stopped after
            // a Restart click.
            if (!r && canManage && !autoStartedRef.current) {
              autoStartedRef.current = true;
              ws.send(
                JSON.stringify({
                  type: "start",
                  cols: term.cols,
                  rows: term.rows,
                }),
              );
            }
          } else if (msg.type === "exit") {
            term.write(
              `\r\n\x1b[31m(claude exited code=${msg.exitCode ?? "?"})\x1b[0m\r\n`,
            );
            setRunning(false);
            setStatus("exited");
            // Auto-respawn after a crash/exit. Without this the user has no UI
            // affordance to bring it back since we removed the Start button.
            // Small delay so the exit banner is visible and we don't tight-loop
            // if Claude immediately fails again.
            if (canManage) {
              autoStartedRef.current = false;
              setTimeout(() => {
                if (disposed) return;
                if (ws.readyState !== WebSocket.OPEN) return;
                if (autoStartedRef.current) return;
                autoStartedRef.current = true;
                ws.send(
                  JSON.stringify({
                    type: "start",
                    cols: term.cols,
                    rows: term.rows,
                  }),
                );
              }, 1200);
            }
          } else if (msg.type === "error" && msg.message) {
            term.write(`\r\n\x1b[31mError: ${msg.message}\x1b[0m\r\n`);
          }
        };
      }

      connect();
    })();

    // Refocus the terminal whenever the user clicks anywhere in the pane.
    // xterm needs focus to receive keystrokes; clicking the toolbar or the
    // page chrome can steal it, leaving the terminal looking interactive but
    // ignoring keypresses (the "needs a refresh to type again" symptom).
    const host = hostRef.current;
    function refocus() {
      // Never auto-focus on touch — see isTouch comment above. Desktop
      // still wants this so a stray click on the toolbar doesn't leave
      // the terminal unresponsive to keypresses.
      if (isTouch) return;
      const term = termRef.current as { focus?: () => void } | null;
      term?.focus?.();
    }
    function onVisibilityChange() {
      if (document.visibilityState === "visible") refocus();
    }
    if (!isTouch) host?.addEventListener("pointerdown", refocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", refocus);

    return () => {
      disposed = true;
      touchAbort.abort();
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      resizeObserver?.disconnect();
      if (!isTouch) host?.removeEventListener("pointerdown", refocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", refocus);
      wsRef.current?.close();
      const term = termRef.current as { dispose?: () => void } | null;
      term?.dispose?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  function sendControl(type: "start" | "stop") {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const term = termRef.current as { cols: number; rows: number } | null;
    ws.send(
      JSON.stringify({
        type,
        cols: term?.cols ?? 100,
        rows: term?.rows ?? 30,
      }),
    );
  }

  function restart() {
    // Allow the post-stop status message to retrigger the auto-start path.
    autoStartedRef.current = false;
    sendControl("stop");
    setTimeout(() => sendControl("start"), 400);
  }

  function openKeyboard() {
    const term = termRef.current as {
      focus?: () => void;
      scrollToBottom?: () => void;
    } | null;
    term?.focus?.();
    term?.scrollToBottom?.();
  }

  function jumpToBottom() {
    const term = termRef.current as { scrollToBottom?: () => void } | null;
    term?.scrollToBottom?.();
    setScrolledUp(false);
    setUnread(0);
  }

  /** Record where Claude's reply will start, measured in absolute buffer
   *  lines. Using `active.length` — the current total row count — so we
   *  read back only the rows appended *after* submission, regardless of
   *  where the cursor happens to be when the CLI redraws its input box. */
  function markSubmitMarker() {
    const term = termRef.current as {
      buffer?: {
        active?: {
          length: number;
          getLine: (
            y: number,
          ) => { translateToString: (trimRight: boolean) => string } | undefined;
        };
      };
    } | null;
    const active = term?.buffer?.active;
    if (!active) return;
    submitLineRef.current = active.length;
    // Seed spokenChars to whatever is *already visible* right now — the
    // previous reply's `●` bullet may still be the newest in the buffer
    // while Claude hasn't streamed the new turn's bullet yet. Without
    // this, the first partial flush would re-speak the old reply because
    // cleanForSpeech still scopes to the stale bullet.
    const rows: string[] = [];
    for (let y = Math.max(0, active.length - 400); y < active.length; y++) {
      const line = active.getLine(y);
      if (line) rows.push(line.translateToString(true));
    }
    // Seed the current scope's offset to its full visible length so
    // the first flush doesn't re-read whatever `●` bullet is already
    // on screen (typically the previous turn's reply).
    const seeded = cleanForSpeech(rows.join("\n"));
    if (seeded.scopeHead) {
      spokenByScopeRef.current.set(seeded.scopeHead, seeded.text.length);
    }
    replyCompleteRef.current = false;
    lastSpeechTokenRef.current = null;
    ttsActiveRef.current = true;
    // Fire a tiny priming fetch so Kokoro's ORT session is hot by the
    // time Claude's actual reply begins streaming. The /api/tts result
    // is discarded — all we want is the sidecar lock and graph warm.
    // Skip priming while a Telegram call holds the audio: the server
    // would return 204 anyway, and hitting it here just wastes a
    // round-trip on every submit.
    if (
      (ttsEnabledRef.current || listeningRef.current) &&
      !telegramActiveRef.current
    ) {
      fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
        cache: "no-store",
      }).catch(() => {
        /* best effort */
      });
    }
    ttsLogRef.current = [];
    ttsLogStartRef.current = Date.now();
    setTtsLog([]);
    logTts(
      `submit marker=${active.length} seed=${seeded.text.length} scope="${seeded.scopeHead.slice(0, 30)}"`,
    );
  }

  /** Re-arm mic-listening once the TTS queue has fully drained. Shared by
   *  the streaming and final-flush paths so both hand control back to the
   *  recognizer the same way. */
  function reopenMic() {
    logTts("reopen mic");
    ttsActiveRef.current = false;
    if (wantListeningRef.current && !recognitionRef.current) {
      // iOS Safari shares one audio session between playback and
      // record; a too-quick flip from TTS-ended to mic-start produces
      // silent recognition sessions that fire no events. 600ms is the
      // empirical floor that survives the transition.
      window.setTimeout(() => {
        if (wantListeningRef.current && !recognitionRef.current) {
          startRecognition();
        }
      }, 600);
    }
  }

  /** Queue a single utterance via a serial fetch chain. Kokoro's ORT
   *  session is single-threaded anyway, so firing fetches in parallel
   *  just queued them at the sidecar's synth_lock and starved whichever
   *  request happened to be first. One-at-a-time keeps the latency of
   *  each chunk predictable. */
  function enqueueUtter(text: string) {
    if (typeof window === "undefined") return;
    // Telegram call has the audio — no local synthesis, not even a
    // queued one. The phone is already voicing the reply.
    if (telegramActiveRef.current) return;
    const lang = detectSpeechLang(text);
    setLang(lang);
    const token = {};
    lastSpeechTokenRef.current = token;
    const gen = ttsGenRef.current;
    const controller = new AbortController();
    logTts(
      `enqueue ${lang === "nl-NL" ? "NL" : "EN"} ${text.length}c: "${text.slice(0, 60)}"`,
    );
    ttsFetchChainRef.current = ttsFetchChainRef.current.then(async () => {
      if (gen !== ttsGenRef.current) {
        logTts("enqueue dropped (stale before fetch)");
        return;
      }
      ttsInFlightRef.current.add(controller);
      try {
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, speed: 1.05 }),
          signal: controller.signal,
        });
        if (gen !== ttsGenRef.current) {
          logTts("enqueue dropped (stale after fetch)");
          return;
        }
        // 204 = server-side mute (Telegram call holds the channel).
        // Treat it as a silent no-op, not a failure: don't reopen the
        // mic, don't log an error — the phone is producing the audio
        // and the channel edge already fired ttsCancel.
        if (r.status === 204) {
          return;
        }
        if (!r.ok) {
          logTts(`tts http ${r.status}`);
          if (lastSpeechTokenRef.current === token) lastSpeechTokenRef.current = null;
          if (replyCompleteRef.current) reopenMic();
          return;
        }
        const blob = await r.blob();
        if (gen !== ttsGenRef.current) {
          logTts("enqueue dropped (stale after blob)");
          return;
        }
        const url = URL.createObjectURL(blob);
        ttsQueueRef.current.push({
          url,
          token,
          onEnd: () => {
            logTts("utter end");
            if (lastSpeechTokenRef.current !== token) return;
            lastSpeechTokenRef.current = null;
            if (replyCompleteRef.current) reopenMic();
          },
          onErr: (e) => {
            logTts(`utter err: ${String(e).slice(0, 60)}`);
            if (lastSpeechTokenRef.current === token) lastSpeechTokenRef.current = null;
            if (replyCompleteRef.current) reopenMic();
          },
        });
        ttsPlayNext();
      } catch (err) {
        const aborted = (err as { name?: string } | null)?.name === "AbortError";
        if (!aborted) logTts(`tts fetch threw: ${String(err).slice(0, 60)}`);
        if (lastSpeechTokenRef.current === token) lastSpeechTokenRef.current = null;
        if (replyCompleteRef.current && !aborted) reopenMic();
      } finally {
        ttsInFlightRef.current.delete(controller);
      }
    });
  }

  /** Pull the latest cleaned reply text from the xterm buffer, queue any
   *  newly-completed sentences, and — when `final` — flush whatever's left
   *  even if it has no terminal punctuation. Best-effort: Claude's output
   *  isn't a structured protocol, so we lean on heuristics that survive
   *  the usual redraws (box-drawing chars, status pulses, accept-edits). */
  function streamFlushSpeech(final: boolean) {
    if (typeof window === "undefined") return;
    const term = termRef.current as {
      buffer?: {
        active?: {
          length: number;
          getLine: (
            y: number,
          ) => { translateToString: (trimRight: boolean) => string } | undefined;
        };
      };
    } | null;
    const active = term?.buffer?.active;
    const submitAt = submitLineRef.current;
    if (!active || submitAt == null) {
      logTts(`skip: active=${!!active} submitAt=${submitAt}`);
      return;
    }
    // Claude Code runs its TUI on the alternate screen, so after Enter
    // the buffer length frequently doesn't grow — new text rewrites
    // existing rows in place. Read the last N rows of the buffer and let
    // cleanForSpeech's own "last ● bullet" scoping pick out the current
    // assistant turn. Cap the range so 10k-line scrollback doesn't
    // produce minute-long Kokoro synths.
    const SCAN_LINES = 400;
    const scanFrom = Math.max(0, active.length - SCAN_LINES);
    const lines: string[] = [];
    for (let y = scanFrom; y < active.length; y++) {
      const line = active.getLine(y);
      if (!line) continue;
      lines.push(line.translateToString(true));
    }
    const { text: cleaned, scopeHead } = cleanForSpeech(lines.join("\n"));
    if (!scopeHead) {
      logTts("no scope bullet in buffer");
      return;
    }
    const offset = spokenByScopeRef.current.get(scopeHead) ?? 0;
    logTts(
      `buf len=${active.length} submit=${submitAt} scope="${scopeHead.slice(0, 24)}" cleaned=${cleaned.length}c off=${offset} "${cleaned.slice(offset, offset + 40)}"`,
    );
    if (cleaned.length > offset) {
      const tail = cleaned.slice(offset);
      const isFirstChunk = offset === 0;
      let chunkEnd = -1;
      if (final) {
        chunkEnd = tail.length;
      } else {
        // Speak up to the last clause boundary — anything past it may
        // still be incomplete and needs the next chunk to land. Comma /
        // semicolon / colon / em-dash are included so the first chunk
        // ships before Claude finishes a full sentence.
        const boundary = /[.!?,;:—–](\s|$)/g;
        let m: RegExpExecArray | null;
        let last = -1;
        while ((m = boundary.exec(tail)) !== null) last = m.index + 1;
        chunkEnd = last;
        // For the very first chunk of a scope, ship as soon as ~10
        // chars are available — the user's single biggest latency
        // complaint is the wait before any audio starts. Prefer a word
        // boundary, but if none exists fall back to the full tail so
        // Kokoro gets something to chew on immediately.
        if (chunkEnd <= 0 && isFirstChunk && tail.length >= 10) {
          const wordEnd = /\S\s(?=\S)/g;
          let wm: RegExpExecArray | null;
          let wLast = -1;
          while ((wm = wordEnd.exec(tail)) !== null) wLast = wm.index + 1;
          chunkEnd = wLast > 0 ? wLast : tail.length;
        }
      }
      if (chunkEnd > 0) {
        const chunk = tail.slice(0, chunkEnd).trim();
        const newOffset = offset + chunkEnd;
        spokenByScopeRef.current.set(scopeHead, newOffset);
        if (chunk) {
          enqueueUtter(chunk);
        } else {
          logTts("chunk empty after trim");
        }
      } else {
        logTts(final ? "no tail on final" : "no boundary yet");
      }
    } else {
      logTts("no new cleaned text");
    }
    if (final) {
      replyCompleteRef.current = true;
      submitLineRef.current = null;
      // Nothing left speaking → release the mic immediately. Otherwise
      // the last utterance's onend will do it.
      if (!lastSpeechTokenRef.current && !ttsSpeaking() && !ttsPending()) {
        logTts("final: nothing queued, reopen mic");
        reopenMic();
      } else {
        logTts(
          `final: wait for drain speaking=${ttsSpeaking()} pending=${ttsPending()} last=${!!lastSpeechTokenRef.current}`,
        );
      }
    }
  }

  function startRecognition() {
    // Telegram holds the audio — the call owns the mic. Let the
    // call-end effect re-arm us once the phone drops.
    if (telegramActiveRef.current) {
      logTts("mic start skipped: telegram call active");
      return;
    }
    const SR =
      (
        window as unknown as {
          SpeechRecognition?: new () => SpeechRecognitionLike;
        }
      ).SpeechRecognition ??
      (
        window as unknown as {
          webkitSpeechRecognition?: new () => SpeechRecognitionLike;
        }
      ).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = currentLangRef.current;
    rec.continuous = true;
    rec.interimResults = false;
    logTts(`mic start lang=${rec.lang}`);
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res.isFinal) continue;
        const alt = res[0];
        const text = alt.transcript.trim();
        if (!text) continue;
        // Drop very short, low-confidence fragments — that's where "vijf"
        // gets mangled into "Psycho". We only trust short phrases if the
        // recognizer was confident; longer phrases are usually fine even
        // with moderate confidence because context helps disambiguate.
        const confidence = typeof alt.confidence === "number" ? alt.confidence : 1;
        if (text.length < 12 && confidence > 0 && confidence < 0.5) continue;
        // Drop results captured while TTS is active — the mic should be
        // stopped anyway, but if iOS leaked an in-flight transcript we
        // don't want it feeding our own voice back into the CLI.
        if (ttsActiveRef.current) {
          logTts(`mic drop (tts active): "${text.slice(0, 40)}"`);
          continue;
        }
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          logTts("mic drop (ws not open)");
          continue;
        }
        logTts(`mic result: "${text.slice(0, 40)}"`);
        // Stop any reply that was being read out — the user is about to
        // ask something new and we don't want Claude's previous answer
        // bleeding over the new prompt.
        ttsCancel();
        // Append \r so each dictated phrase auto-submits (hands-free).
        ws.send(JSON.stringify({ type: "input", data: text + "\r" }));
        markSubmitMarker();
        // Shut the mic down the instant the user finishes speaking. The
        // onend restart loop is gated on ttsActiveRef (set by markSubmitMarker),
        // so it will stay off until Claude's reply has finished speaking.
        try {
          rec.stop();
        } catch {
          /* already stopping */
        }
      }
    };
    rec.onend = () => {
      recognitionRef.current = null;
      logTts(
        `mic end want=${wantListeningRef.current} ttsActive=${ttsActiveRef.current}`,
      );
      // iOS ends the session after every phrase even in continuous mode.
      // If the user still wants to listen, quietly start a fresh session
      // instead of tearing down the TTS pipeline.
      if (wantListeningRef.current) {
        // Don't re-arm while a Telegram call holds the audio. The
        // channel edge effect stopped us deliberately; bouncing back
        // would re-open the laptop mic for the duration of the call.
        if (telegramActiveRef.current) {
          logTts("mic restart skipped: telegram call active");
          return;
        }
        if (recRestartTimerRef.current) {
          window.clearTimeout(recRestartTimerRef.current);
        }
        recRestartTimerRef.current = window.setTimeout(() => {
          recRestartTimerRef.current = null;
          // Skip restart while TTS owns the audio session — the TTS onend
          // handler will re-arm the mic once playback finishes. Also skip
          // if Telegram took over in the meantime.
          if (
            wantListeningRef.current &&
            !recognitionRef.current &&
            !ttsActiveRef.current &&
            !telegramActiveRef.current
          ) {
            startRecognition();
          } else {
            logTts(
              `mic restart skipped: want=${wantListeningRef.current} rec=${!!recognitionRef.current} ttsActive=${ttsActiveRef.current} telegram=${telegramActiveRef.current}`,
            );
          }
        }, 600);
      } else {
        setListening(false);
      }
    };
    // Use a plain function so we can introspect the event param even
    // though our SpeechRecognitionLike shim declares the callback as
    // zero-arg. The Web Speech API actually passes an event with an
    // `error` string.
    rec.onerror = function onRecErr(this: unknown, ev?: { error?: string }) {
      const code = ev?.error ?? "?";
      logTts(`mic error: ${code}`);
      recognitionRef.current = null;
      // `no-speech` and `aborted` are benign — the user just paused or
      // we stopped the mic ourselves. Let the onend restart loop handle
      // those. Fatal errors (mic permission, device busy) kill the
      // session so the user doesn't get stuck in a restart loop.
      if (code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture") {
        wantListeningRef.current = false;
        setListening(false);
      }
    } as unknown as () => void;
    try {
      rec.start();
      recognitionRef.current = rec;
      setListening(true);
    } catch {
      /* already started */
    }
  }

  function toggleVoice() {
    if (listening) {
      wantListeningRef.current = false;
      if (recRestartTimerRef.current) {
        window.clearTimeout(recRestartTimerRef.current);
        recRestartTimerRef.current = null;
      }
      try {
        recognitionRef.current?.stop();
      } catch {
        /* already stopping */
      }
      return;
    }
    // iOS Safari (incl. PWA) gates HTMLAudio playback behind a user
    // gesture: the first play() call has to originate from a tap, or
    // later timer-driven Audio.play() calls silently fail. Kick the
    // shared audio element with a zero-sample WAV while we're still
    // inside the mic-button click to unlock the engine for the session.
    ttsPrime();
    wantListeningRef.current = true;
    startRecognition();
  }

  // Hook the shared audio element to the queue. `ended` advances to the
  // next chunk; `error` logs and advances so one bad blob doesn't stall
  // the pipeline. React attaches the ref before useEffect runs, so
  // audioElRef.current is always present here.
  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;
    function handleEnded() {
      const cur = ttsCurrentRef.current;
      ttsCurrentRef.current = null;
      if (cur) {
        try {
          URL.revokeObjectURL(cur.url);
        } catch {
          /* ignore */
        }
        cur.onEnd();
      }
      ttsPlayNext();
    }
    function handleError(ev: Event) {
      const cur = ttsCurrentRef.current;
      ttsCurrentRef.current = null;
      if (cur) {
        try {
          URL.revokeObjectURL(cur.url);
        } catch {
          /* ignore */
        }
        cur.onErr(ev);
      }
      ttsPlayNext();
    }
    el.addEventListener("ended", handleEnded);
    el.addEventListener("error", handleError);
    return () => {
      el.removeEventListener("ended", handleEnded);
      el.removeEventListener("error", handleError);
    };
  }, []);

  // Stop any ongoing recognition when the pane unmounts (e.g. user navigates
  // away mid-dictation). Also cancel any queued TTS and drop the idle timer
  // so nothing speaks after the terminal is already gone.
  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      if (recRestartTimerRef.current) {
        window.clearTimeout(recRestartTimerRef.current);
        recRestartTimerRef.current = null;
      }
      try {
        recognitionRef.current?.stop();
      } catch {
        /* ignore */
      }
      ttsCancel();
      if (ttsIdleTimerRef.current) {
        window.clearTimeout(ttsIdleTimerRef.current);
        ttsIdleTimerRef.current = null;
      }
      if (ttsFinalTimerRef.current) {
        window.clearTimeout(ttsFinalTimerRef.current);
        ttsFinalTimerRef.current = null;
      }
    };
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-neutral-950">
      <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-950/80 px-3 py-1 text-xs sm:py-2">
        <span
          className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] ${
            running
              ? "border-orange-700/60 bg-orange-900/40 text-orange-200"
              : "border-neutral-700 bg-neutral-900 text-neutral-400"
          }`}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              running ? "bg-orange-400" : "bg-neutral-500"
            }`}
          />
          claude · {status}
        </span>
        {(listening || ttsEnabled) && ttsLog.length > 0 && (
          <span
            className="max-w-[60%] truncate rounded border border-neutral-800 bg-neutral-900/80 px-2 py-0.5 text-[10px] text-neutral-400"
            title={ttsLog
              .slice(-10)
              .map((e) => `+${e.t}ms ${e.msg}`)
              .join("\n")}
          >
            tts: {ttsLog[ttsLog.length - 1]?.msg ?? ""}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {/* Coarse-pointer-only keyboard trigger. xterm no longer
           * auto-focuses on tap (that was popping the OS keyboard on
           * every scroll), so mobile users get this explicit button. */}
          <button
            type="button"
            onClick={openKeyboard}
            className="flex items-center gap-1 rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:border-neutral-700 [@media(pointer:fine)]:hidden"
            title="Open toetsenbord"
            aria-label="Open toetsenbord"
          >
            <Keyboard className="h-3 w-3" /> Typen
          </button>
          <button
            type="button"
            onClick={() => {
              const next = !ttsEnabled;
              setTtsEnabled(next);
              // Tapping the speaker counts as a user gesture — unlock
              // iOS HTMLAudio autoplay now so the first timer-driven
              // Kokoro chunk actually plays once the model answers.
              if (next) {
                ttsPrime();
              } else {
                ttsCancel();
              }
            }}
            className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] ${
              ttsEnabled
                ? "border-orange-500/60 bg-orange-900/40 text-orange-100"
                : "border-neutral-800 text-neutral-300 hover:border-neutral-700"
            }`}
            title={ttsEnabled ? "Stop voorlezen" : "Lees antwoorden voor"}
            aria-label={ttsEnabled ? "Stop voorlezen" : "Lees antwoorden voor"}
          >
            {ttsEnabled ? (
              <Volume2 className="h-3 w-3" />
            ) : (
              <VolumeX className="h-3 w-3" />
            )}
          </button>
          {voiceSupported && (
            <button
              type="button"
              onClick={toggleVoice}
              className={`flex items-center gap-1 rounded border px-2 py-1 text-[11px] ${
                listening
                  ? "animate-pulse border-red-500/60 bg-red-900/40 text-red-100"
                  : "border-neutral-800 text-neutral-300 hover:border-neutral-700"
              }`}
              title={
                listening
                  ? `Stop dicteren (${activeLang === "nl-NL" ? "NL" : "EN"})`
                  : `Dicteer (${activeLang === "nl-NL" ? "NL" : "EN"})`
              }
              aria-label={listening ? "Stop dicteren" : "Dicteer"}
            >
              {listening ? (
                <MicOff className="h-3 w-3" />
              ) : (
                <Mic className="h-3 w-3" />
              )}
              <span className="text-[9px] font-semibold tracking-wider opacity-80">
                {activeLang === "nl-NL" ? "NL" : "EN"}
              </span>
            </button>
          )}
          {canManage && running && (
            <>
              <button
                type="button"
                onClick={restart}
                className="flex items-center gap-1 rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:border-neutral-700"
                title="Herstart de Claude sessie voor dit project"
              >
                <RotateCcw className="h-3 w-3" /> Restart
              </button>
              <button
                type="button"
                onClick={() => sendControl("stop")}
                className="flex items-center gap-1 rounded border border-red-700/50 bg-red-900/30 px-2 py-1 text-[11px] text-red-200 hover:bg-red-900/50"
              >
                <Square className="h-3 w-3" /> Stop
              </button>
            </>
          )}
          {onToggleFullscreen && (
            <button
              type="button"
              onClick={onToggleFullscreen}
              className="flex min-h-[28px] min-w-[28px] items-center justify-center rounded border border-neutral-800 text-neutral-300 hover:border-neutral-700"
              title={fullscreen ? "Verlaat fullscreen" : "Fullscreen terminal"}
              aria-label={fullscreen ? "Verlaat fullscreen" : "Fullscreen terminal"}
            >
              {fullscreen ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </button>
          )}
        </div>
      </div>
      {/* Clip wrapper: xterm's grid size is driven by this box. When the
       * iOS keyboard opens we translate the inner host UP by kbInset —
       * the xterm dimensions don't change, so Claude CLI gets no SIGWINCH
       * and can't be interrupted mid-redraw. The keyboard simply covers
       * the bottom portion of the stable terminal, and Claude's prompt
       * (drawn at the grid's last row) remains visible just above it. */}
      <div className="relative flex-1 overflow-hidden">
        <div
          ref={hostRef}
          className="absolute inset-0 px-2 py-2"
          style={
            kbInset > 0 ? { transform: `translateY(-${kbInset}px)` } : undefined
          }
        />
        {scrolledUp && (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 rounded-full bg-orange-600 px-3 py-1.5 text-xs font-medium text-white shadow-lg shadow-black/40 hover:bg-orange-500"
            title="Spring naar beneden"
            aria-label="Spring naar beneden"
            style={kbInset > 0 ? { bottom: kbInset + 12 } : undefined}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            {unread > 0 && <span>{unread > 99 ? "99+" : unread}</span>}
          </button>
        )}
      </div>
      {/* Shared sink for Kokoro playback. Single element so iOS only
       * needs one gesture-unlock (see ttsPrime). preload="auto" keeps
       * the decoder warm between chunks. */}
      <audio ref={audioElRef} preload="auto" className="hidden" />
    </div>
  );
}
