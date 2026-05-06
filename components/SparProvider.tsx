"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SparContext,
  type Attachment,
  type Dispatch,
  type Msg,
  type Role,
  type SparConversationSummary,
  type SparUser,
  type ToolStep,
  MAX_TRANSCRIPT,
} from "./SparContext";
import { useVoiceChannel } from "./useVoiceChannel";
import { useThinkingFiller } from "./useThinkingFiller";
import { useTtsFillerContent } from "./useTtsFillerContent";
import { useAmbientPad } from "./useAmbientPad";
import { awaitFillerHandoff, isAnyFillerAudible, onFillerAudibleChange, subscribeFillerAudible } from "@/lib/filler-handoff";
import { trackAction } from "./UserTracker";
import { useMediaPlayer } from "./useMediaPlayer";
import { useChime } from "./useChime";
import { useToneCue } from "./useToneCue";
import { readSignoffWord } from "@/lib/tts-signoff";

const TRANSCRIPT_KEY_PREFIX = "spar:transcript:v1:";
const AUTOPILOT_KEY_PREFIX = "spar:autopilot:v1:";
const SENTENCE_BOUNDARY = /[.!?,;:—–](\s|$)/g;
// Persisted TTS preference for the text-chat experience. The
// in-call audio path always speaks regardless of this flag — see
// the (ttsMuted && !inCall) gates below — so this only governs the
// "I'm typing, please don't read it back to me" toggle the user
// drives from the media drawer.
const TTS_MUTED_STORAGE_KEY = "spar:ttsMuted:v1";

function readTtsMutedPref(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(TTS_MUTED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

interface SpeechRecognitionResultList {
  length: number;
  [i: number]: {
    isFinal: boolean;
    0: { transcript: string; confidence: number };
  };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((e: { resultIndex: number; results: SpeechRecognitionResultList }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
  // abort() drops any audio buffered since start() and does NOT emit a
  // final result — different from stop(), which flushes the buffer and
  // can deliver one last `onresult`. Used on TTS/filler echo-kill paths
  // so the speaker bleed already in SR's pipeline doesn't surface as a
  // bogus user turn.
  abort: () => void;
}

// ---------------------------------------------------------------------------
// Active-call persistence
// ---------------------------------------------------------------------------
// Survives page reload, dev-server restart, navigation, AND tab close.
// On mount the resume effect reads this record, cross-checks server-side
// session state, and either re-enters the call or clears the record if it
// turns out to be stale (call ended during the gap, telegram took over,
// heartbeat is too old to trust).
//
// Heartbeat: while a spar call is in progress we bump `lastHeartbeat` every
// 30 s. On reload, a record older than the staleness window is dropped on
// the floor — that catches the "tab was closed mid-call days ago" case.
// Telegram records are heartbeat-bumped by the channel-observer effect
// (the 100 ms voice poll fires on every render anyway, which is more than
// frequent enough).
const ACTIVE_CALL_STORAGE_KEY = "spar:activeCall";
const ACTIVE_CALL_HEARTBEAT_MS = 30_000;
const ACTIVE_CALL_STALENESS_MS = 5 * 60_000;

type ActiveCallType = "spar" | "telegram";
interface ActiveCallRecord {
  type: ActiveCallType;
  startedAt: number;
  lastHeartbeat: number;
}

function readActiveCallRecord(): ActiveCallRecord | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ACTIVE_CALL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ActiveCallRecord>;
    if (
      (parsed?.type !== "spar" && parsed?.type !== "telegram") ||
      typeof parsed.startedAt !== "number" ||
      typeof parsed.lastHeartbeat !== "number"
    ) {
      return null;
    }
    return parsed as ActiveCallRecord;
  } catch {
    return null;
  }
}

function writeActiveCallRecord(rec: ActiveCallRecord): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_CALL_STORAGE_KEY, JSON.stringify(rec));
  } catch {
    /* quota / private browsing — soft-fail, in-memory state still works */
  }
}

function clearActiveCallRecord(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(ACTIVE_CALL_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function bumpActiveCallHeartbeat(expectedType?: ActiveCallType): void {
  const rec = readActiveCallRecord();
  if (!rec) return;
  if (expectedType && rec.type !== expectedType) return;
  rec.lastHeartbeat = Date.now();
  writeActiveCallRecord(rec);
}

export default function SparProvider({
  currentUser,
  canManageOthers,
  initialHeartbeat,
  children,
}: {
  currentUser: SparUser;
  canManageOthers: boolean;
  initialHeartbeat: string;
  children: React.ReactNode;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const pendingAttachmentsRef = useRef<Attachment[]>([]);
  pendingAttachmentsRef.current = pendingAttachments;
  const [busy, setBusy] = useState(false);
  const [inCall, setInCall] = useState(false);
  const [callStartedAt, setCallStartedAt] = useState<number | null>(null);
  const [listening, setListening] = useState(false);
  const [ttsMuted, setTtsMuted] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [autopilot, setAutopilot] = useState(false);
  const autopilotRef = useRef(false);
  const [heartbeat, setHeartbeat] = useState(initialHeartbeat);
  const [heartbeatDirty, setHeartbeatDirty] = useState(false);
  const [savingHeartbeat, setSavingHeartbeat] = useState(false);
  const [speakingUserId, setSpeakingUserId] = useState<number>(currentUser.id);
  const [ttsIdle, setTtsIdle] = useState(true);
  const ttsIdleRef = useRef(true);
  // Direct "the <audio> element is literally emitting sound RIGHT
  // NOW" flag, bound to its play / pause / ended events. We use
  // this as the primary signal for YouTube ducking because the
  // pending-fetch + queue-drain accounting that drives ttsIdle has
  // more moving parts (and ends up with multi-hop React latency
  // before the YT iframe sees it). This one flips the frame the
  // browser actually starts outputting audio samples.
  const [ttsAudible, setTtsAudible] = useState(false);
  // Mirrors `isAnyFillerAudible()` — flips true while any filler source
  // (YouTube, news, fun-facts, ambient pad) is producing sound. We mute
  // the laptop mic on this signal too so the filler audio doesn't bleed
  // back in as user input. Subscribed once below; the ref version is
  // read by the recognition guards that run outside the React cycle.
  const [fillerAudible, setFillerAudible] = useState(false);
  const fillerAudibleRef = useRef(false);
  // Post-TTS tail window. Stays true for ~450 ms after `ttsAudible`
  // falls to false. Filler gates AND-in `!ttsTailSettling` so they
  // can't snap back on between the audio element's `ended` event and
  // the mic-arming setTimeout actually opening the mic. Without this
  // the user hears a ~split-second clip of news / fun-fact filler
  // right after the assistant stops speaking — and the open mic then
  // catches it as input, looping back into a transcript. The mic-arm
  // path waits ~1200 ms; 450 ms covers the audible-blip window
  // without holding music off long enough to feel laggy.
  const [ttsTailSettling, setTtsTailSettling] = useState(false);
  const ttsTailTimerRef = useRef<number | null>(null);
  // Mirror of ttsTailSettling for non-React callers (the post-acquire
  // guard inside `acquireMicStream`). The state already drives the
  // consolidated mic-gate effect; the ref lets the async getUserMedia
  // resolution check the latest value without going stale on a closure
  // captured before the edge.
  const ttsTailSettlingRef = useRef(false);
  useEffect(() => {
    ttsTailSettlingRef.current = ttsTailSettling;
  }, [ttsTailSettling]);
  // Voice-activity flag, driven by the SpeechRecognition result
  // stream (not by whether the mic happens to be open). Flips true
  // on any recognised interim or final text, decays back to false
  // ~800 ms after the last result. The idle-silence timer uses
  // this — the `listening` flag means "mic is hot", not "user is
  // actually speaking", so gating the timer on `listening` would
  // prevent it from ever firing while the mic is open.
  const [vadActive, setVadActive] = useState(false);
  const vadDecayRef = useRef<number | null>(null);
  const [callSeconds, setCallSeconds] = useState(0);
  const [interimText, setInterimText] = useState("");
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);

  const nextIdRef = useRef(1);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ttsQueueRef = useRef<string[]>([]);
  const ttsPlayingRef = useRef(false);
  const ttsMutedRef = useRef(false);
  // Set by flushSpokenText(final=true) when a turn produced spoken
  // audio. The TTS pipeline fires one extra clip (the configured
  // sign-off word) once every real chunk has finished playing. Lives
  // entirely in the audio layer — the AI never sees this word.
  const signoffArmedRef = useRef(false);
  const signoffInFlightRef = useRef(false);
  // Mirrors `inCall` for ref-based audio gates (speakChunk runs
  // outside the React render cycle and needs the latest value
  // without having to re-bind on every state change).
  const inCallRef = useRef(false);
  const micMutedRef = useRef(false);
  // Pre-acquired MediaStream with echoCancellation / noiseSuppression /
  // autoGainControl all enabled. Kept alive for the whole call so the
  // browser's AEC stays engaged on the default input device while
  // SpeechRecognition runs alongside. SR has its own internal mic path
  // and does NOT accept MediaStream constraints, but opening a
  // constrained stream first makes Chrome initialise the audio input
  // device in communications / AEC mode; SR then shares that device
  // configuration. Main win is reducing bleed from the YouTube iframe's
  // audio (which plays to the system output mix and gets sampled back
  // into the mic) — AEC cancels whatever's on the local output path.
  const micStreamRef = useRef<MediaStream | null>(null);
  // Set when a Telegram call takes over the shared voice session.
  // While true, browser TTS is suppressed entirely — the assistant's
  // voice is going through the phone instead, and we don't want the
  // laptop speakers talking over the call.
  const telegramActiveRef = useRef(false);
  const ttsFetchChainRef = useRef<Promise<void>>(Promise.resolve());
  const ttsGenRef = useRef(0);
  const spokenCharsRef = useRef(0);
  const ttsPendingRef = useRef(0);
  const recognitionRef = useRef<{ stop: () => void; abort: () => void } | null>(null);
  const wantListeningRef = useRef(false);
  const restartTimerRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<Msg[]>([]);

  useEffect(() => {
    ttsMutedRef.current = ttsMuted;
  }, [ttsMuted]);
  useEffect(() => {
    inCallRef.current = inCall;
  }, [inCall]);
  // Hydrate from localStorage on mount. Done in an effect (rather
  // than a lazy useState init) so SSR matches the initial client
  // render, then we sync the saved preference on the client tick.
  useEffect(() => {
    setTtsMuted(readTtsMutedPref());
  }, []);
  // Persist the preference. Removing the key when false keeps the
  // storage clean and lets future migrations distinguish "never
  // toggled" from "explicitly un-muted".
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (ttsMuted) {
        window.localStorage.setItem(TTS_MUTED_STORAGE_KEY, "1");
      } else {
        window.localStorage.removeItem(TTS_MUTED_STORAGE_KEY);
      }
    } catch {
      /* quota / private browsing — non-fatal */
    }
  }, [ttsMuted]);
  useEffect(() => {
    autopilotRef.current = autopilot;
  }, [autopilot]);
  useEffect(() => {
    micMutedRef.current = micMuted;
  }, [micMuted]);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Shared voice-session channel — drives the hard mute on the
  // browser TTS path. While `voice.channel === "telegram"`, anything
  // that would have been spoken aloud on this tab routes through the
  // phone instead and must stay silent here. The transition edge is
  // the one that matters most: if TTS is mid-playback when the call
  // connects, we need to kill it *immediately* so the user doesn't
  // get a word-and-a-half of local speaker bleed into the call.
  const voice = useVoiceChannel();
  // Filler mode lives in telegram-voice/filler-config.json (single
  // source of truth with the Python Telegram worker); it's piggy-
  // backed on the voice-session poll.
  //
  //   "news"     → pre-rendered news clips (Kokoro + RSS)
  //   "youtube"  → user-selected music / podcast / video audio
  //   "quiet"    → ambient chime only, no spoken content
  //   "fun-facts"/"calendar" → dashboard-native TTS content
  // (Silencing the assistant entirely lives on the per-client TTS
  //  toggle in SparContext, not on this filler mode.)
  const mode = voice.fillerMode;
  const ytVideoId = voice.youtube.videoId;
  const ytSelected = ytVideoId !== null && voice.youtube.status !== "idle";
  const wantsYoutube = mode === "youtube" && ytSelected;
  // TTS-content modes — handled by useTtsFillerContent (separate
  // <audio> element, fetches /api/spar/filler-content). Distinct
  // from `wantsNews` because news currently flows through the
  // pre-rendered WAV pool path.
  const wantsTtsContent = mode === "fun-facts" || mode === "calendar";

  // ---- Filler-audio decision -------------------------------------------
  //
  // YouTube music: simple, no timers, no delays. Plays whenever the user
  // has a video selected and nobody is talking. Three checks:
  //   1. video selected             — `wantsYoutube` (mode is youtube AND
  //                                    a videoId is set AND status is not
  //                                    "idle"). Server can also flip this
  //                                    to status="paused" to hold silence.
  //   2. not on a Telegram call     — `voice.channel !== "telegram"`.
  //                                   Phone owns audio there; the Python
  //                                   worker handles filler on its side.
  //   3. nobody talking             — assistant TTS not playing AND user
  //                                   not speaking (VAD inactive).
  //
  // History: an earlier version had a 7 s "idle silence" cooldown timer
  // before music would resume. Re-render races kept the timer in
  // active=false permanently. The simplification removes the timer
  // entirely — if the conditions hold, music plays immediately. Do not
  // re-introduce any timer / setTimeout / "wait N ms before playing" gate
  // here — they all bring the same race back.
  //
  // VAD nuance: brief user speech sets `vadActive` and that flips
  // `nobodyTalking` to false, which would normally stop the player.
  // To avoid the ~100–200 ms re-buffer on every utterance gap, the
  // YouTube hook treats its `ducked` prop as a fast mute (instant
  // mute + 500 ms fade-in on release) — see `ytMusicDucked` below. The
  // hook keeps playback running through a duck, so the active flag
  // dropping briefly during VAD is acceptable: it's the duck path that
  // does the real work for short speech.
  //
  // News and hum still ride a separate gate (`fillerShouldPlay`). They
  // are conversational fillers tied to "the assistant is thinking",
  // not background loops, so they keep their own thinking-only trigger.
  const fillerOnTelegram = voice.channel === "telegram";
  const ttsQuiet = !ttsAudible && !ttsTailSettling && ttsIdle;
  const nobodyTalking = ttsQuiet && !vadActive;
  // Hard pause for the local mic-listening window. VAD ducking only
  // mutes for the ~hundreds of ms the user is actively speaking, but
  // the mic is hot the whole time recognition is running — between
  // utterances filler audio still bleeds into the captured stream and
  // produces hallucinated transcripts. Pausing on the rising edge of
  // `listening` (and resuming when it ends) eliminates that bleed
  // entirely. Manual pause survives because the inner `serverStatus
  // === "playing"` check stays in the gate.
  const micOpenForVoiceInput = listening && !micMuted;
  // Post-TTS settle window. The mic-arming effect (search for the
  // ~1200 ms setTimeout that calls startRecognition) deliberately
  // waits about a second between TTS going idle and opening the mic
  // so the your-turn chime has room to land. During that gap
  // `ttsQuiet` is true (so `nobodyTalking` is true) but `listening`
  // is still false — and the `!micOpenForVoiceInput` gate alone lets
  // news / YouTube filler kick back on for that second before the
  // mic finally opens and re-suppresses it. Treat the gap as if the
  // mic were already open. Conditions match the mic-arm effect's own
  // gating so we cover exactly the same window: in a voice call,
  // mic not muted, not on Telegram, assistant no longer streaming,
  // mic not yet listening.
  const micArmingSoon =
    inCall &&
    !micMuted &&
    !fillerOnTelegram &&
    !busy &&
    !listening;
  const micActiveOrArming = micOpenForVoiceInput || micArmingSoon;
  const ytMusicShouldPlay =
    wantsYoutube &&
    voice.youtube.status === "playing" &&
    !fillerOnTelegram &&
    nobodyTalking &&
    !micActiveOrArming;
  // News/hum: only while the assistant is thinking. No idle trigger.
  const fillerShouldPlay = busy && !fillerOnTelegram && ttsQuiet;
  // Kept for the legacy debug block below — semantically equivalent to
  // the conditions that fully stop YouTube music (telegram or TTS).
  const hardCutoff = fillerOnTelegram || !ttsQuiet;
  // Transient mute overlay driven by the SpeechRecognition result
  // stream. When the user is speaking, YT audio re-captured by the
  // mic bleeds into the recogniser; ducking at the source (instant
  // mute, 500 ms fade-in on release) removes the contamination the
  // browser AEC failed to cancel. This is deliberately separate
  // from ytMusicShouldPlay — the player stays in its PLAYING state
  // through a brief VAD burst, so the 800 ms decay costs zero
  // re-buffer on release. Only consulted while ytMusicShouldPlay
  // is already true; the hook ignores it otherwise.
  const ytMusicDucked = vadActive;

  // Single source of truth for everything client-side that touches
  // the media player: nowPlaying mirror, queue, volume, controls, the
  // mount-time localStorage restore, and the iframe driver. The
  // server (lib/youtube-state.ts via voice-session poll) stays
  // authoritative across devices; this hook owns the client side.
  const {
    nowPlaying: youtubeNowPlaying,
    queue: youtubeQueue,
    volume: youtubeVolume,
    setVolume: setYoutubeVolume,
    play: youtubePlay,
    pause: youtubePause,
    stop: youtubeStop,
    skip: youtubeSkip,
    enqueue: youtubeEnqueue,
    clearQueue: youtubeClearQueue,
    removeFromQueue: youtubeRemoveFromQueue,
    reorderQueue: youtubeReorderQueue,
    ytRestoring,
  } = useMediaPlayer({ voice, ytMusicShouldPlay, ytMusicDucked });

  // Two reasons to play news: mode is explicitly "news", OR mode is
  // "youtube" but no video is selected (safe fallback).
  //
  // IMPORTANT: during the ~100–500 ms window right after a page
  // refresh, the server's in-memory YouTube state has been wiped but
  // `mode` (from filler-config.json on disk) still says "youtube".
  // Without the `ytRestoring` guard, that window fires the fallback
  // and the user hears a news headline for a second before YT
  // resumes — which consistently reads as "it defaults back to
  // headlines every time I refresh". The guard (managed inside
  // useMediaPlayer) holds the fallback back until the restore POST
  // completes (or 4 s times out).
  const wantsNews =
    mode === "news" ||
    (mode === "youtube" && !ytSelected && !ytRestoring);

  // News plays continuously in the background, exactly like YouTube
  // — gated by the same "nobody talking + not on Telegram" predicate
  // (ttsQuiet && !vadActive). Previously this was tied to `busy`
  // (thinking-only), which made the pause/skip controls feel broken:
  // the user would pause, the assistant would stop thinking, the gate
  // would flip false, then on the next thinking window the gate would
  // flip true again — the pausedRef survived but the UX read as
  // "the player ignores me." Mirroring the YouTube gate makes news a
  // first-class background mode. Other filler kinds (fun-facts,
  // calendar) keep their thinking-only gating below — those are
  // *conversational* fillers, not background loops.
  const newsShouldPlay =
    wantsNews && !fillerOnTelegram && nobodyTalking && !micActiveOrArming;

  // ---- [FILLER-DEBUG] CHANGE-ONLY LOGGING (TEMP — remove once stable) --
  // Fires only when an input flips, so the timeline of "what changed and
  // what did the filler do about it" is grep-friendly:
  //     grep '[FILLER-DEBUG]' in DevTools.
  // Tracks: video selection, server status, mode, telegram channel,
  // user talking (VAD), TTS playing, TTS idle, thinking (busy),
  // hardCutoff, the play/pause decision and the duck flag — every
  // signal that can stop the music.
  const ytDebugRef = useRef<{
    videoId: string | null;
    selected: boolean;
    onTelegram: boolean;
    talking: boolean;
    ttsAudible: boolean;
    ttsIdle: boolean;
    busy: boolean;
    status: string | null;
    mode: string;
    hardCutoff: boolean;
    shouldPlay: boolean;
    ducked: boolean;
    initialized: boolean;
  }>({
    videoId: null,
    selected: false,
    onTelegram: false,
    talking: false,
    ttsAudible: false,
    ttsIdle: true,
    busy: false,
    status: null,
    mode: "news",
    hardCutoff: false,
    shouldPlay: false,
    ducked: false,
    initialized: false,
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const prev = ytDebugRef.current;
    const talking = vadActive;
    const status = voice.youtube.status ?? null;
    const next = {
      videoId: ytVideoId,
      selected: ytSelected,
      onTelegram: fillerOnTelegram,
      talking,
      ttsAudible,
      ttsIdle,
      busy,
      status,
      mode,
      hardCutoff,
      shouldPlay: ytMusicShouldPlay,
      ducked: ytMusicDucked,
      initialized: true,
    };

    // First mount — log a baseline so the rest of the trail makes sense.
    if (!prev.initialized) {
      console.log("[FILLER-DEBUG] init", {
        videoId: next.videoId,
        selected: next.selected,
        status: next.status,
        mode: next.mode,
        onTelegram: next.onTelegram,
        talking: next.talking,
        ttsAudible: next.ttsAudible,
        ttsIdle: next.ttsIdle,
        busy: next.busy,
        hardCutoff: next.hardCutoff,
        shouldPlay: next.shouldPlay,
        ducked: next.ducked,
      });
      ytDebugRef.current = next;
      return;
    }

    if (prev.videoId !== next.videoId) {
      console.log("[FILLER-DEBUG] selection change", {
        from: prev.videoId,
        to: next.videoId,
        title: voice.youtube.title,
      });
    }
    if (prev.status !== next.status) {
      console.log("[FILLER-DEBUG] server status change", {
        from: prev.status,
        to: next.status,
        videoId: next.videoId,
      });
    }
    if (prev.mode !== next.mode) {
      console.log("[FILLER-DEBUG] mode change", { from: prev.mode, to: next.mode });
    }
    if (prev.onTelegram !== next.onTelegram) {
      console.log("[FILLER-DEBUG] telegram channel change", {
        onTelegram: next.onTelegram,
        channel: voice.channel,
      });
    }
    if (prev.talking !== next.talking) {
      console.log("[FILLER-DEBUG] user talking change (VAD)", {
        talking: next.talking,
        listening,
      });
    }
    if (prev.ttsAudible !== next.ttsAudible) {
      console.log("[FILLER-DEBUG] tts audible change", {
        ttsAudible: next.ttsAudible,
        ttsIdle: next.ttsIdle,
      });
    }
    if (prev.ttsIdle !== next.ttsIdle) {
      console.log("[FILLER-DEBUG] tts idle change", {
        ttsIdle: next.ttsIdle,
        ttsAudible: next.ttsAudible,
      });
    }
    if (prev.busy !== next.busy) {
      console.log("[FILLER-DEBUG] thinking change", { busy: next.busy });
    }
    if (prev.hardCutoff !== next.hardCutoff) {
      console.log("[FILLER-DEBUG] hardCutoff change", {
        hardCutoff: next.hardCutoff,
        because: {
          ttsAudible: next.ttsAudible,
          ttsBusy: !next.ttsIdle,
          onTelegram: next.onTelegram,
        },
      });
    }
    if (prev.shouldPlay !== next.shouldPlay) {
      // The 3 active conditions, spelled out, so a regression is
      // obvious from the log alone.
      console.log("[FILLER-DEBUG] DECISION shouldPlay → " + next.shouldPlay, {
        videoSelected: next.selected,
        notOnTelegram: !next.onTelegram,
        nobodyTalking: !next.talking && next.ttsIdle && !next.ttsAudible,
        thinking: next.busy,
        status: next.status,
        mode: next.mode,
        ytRestoring,
      });
    }
    if (prev.ducked !== next.ducked) {
      console.log("[FILLER-DEBUG] DECISION ducked → " + next.ducked, {
        talking: next.talking,
        shouldPlay: next.shouldPlay,
      });
    }
    ytDebugRef.current = next;
  }, [
    ytVideoId,
    ytSelected,
    voice.channel,
    voice.youtube.status,
    voice.youtube.title,
    vadActive,
    listening,
    ttsAudible,
    ttsIdle,
    busy,
    mode,
    hardCutoff,
    ytMusicShouldPlay,
    ytMusicDucked,
    fillerOnTelegram,
    ytRestoring,
  ]);
  // ---- end [FILLER-DEBUG] ----------------------------------------------

  // News clips — driven by `newsShouldPlay`, which is the same
  // continuous-background predicate YouTube uses. News has no
  // ducking affordance of its own (the WAV pool's gain envelope is
  // a fade, not an instant mute), so it continues to fully stop
  // during user speech and restart after the 800 ms decay — the
  // `!vadActive` clause is baked into `nobodyTalking`.
  const {
    hasContent: fillerHasContent,
    currentClip: newsCurrentClip,
    upcoming: newsUpcomingRaw,
    paused: newsPaused,
    pause: newsPause,
    resume: newsResume,
    skip: newsSkip,
  } = useThinkingFiller(newsShouldPlay);
  const newsUpcoming = useMemo(
    () =>
      newsUpcomingRaw.map((c) => ({
        id: c.id,
        title: c.title,
        source: c.source,
      })),
    [newsUpcomingRaw],
  );
  // The fallback gate: news will pick up automatically once YouTube
  // goes idle (no track selected) — see `wantsNews` above. Used by
  // the queue UI to show "News" as the upcoming entry after the
  // last YouTube track. Kept conservative: only true when there is
  // actual news content to play AND we're in a config that would
  // hand off to news.
  const newsUpNextAfterYoutube =
    fillerHasContent &&
    (mode === "youtube" || mode === "news") &&
    !wantsTtsContent;

  // TTS-spoken filler content (fun-facts, calendar). Owns its own
  // <audio> element and fetch chain — see useTtsFillerContent for
  // the lifecycle. `realStarted` is the no-overlap signal: when
  // SparProvider's main TTS pipeline starts emitting audible audio,
  // hard-fade the filler. `active` is the soft signal: lets the
  // current item finish naturally before we stop chaining.
  useTtsFillerContent({
    active:
      fillerShouldPlay &&
      !vadActive &&
      wantsTtsContent,
    realStarted: ttsAudible,
  });

  // Warm ambient pad — synthesised low drone that fills the silence
  // when nothing else is speaking during a thinking window. Layers
  // *under* chimes/hum (which are event-y) but explicitly NOT under
  // any spoken filler (news WAVs or TTS facts/calendar) so we never
  // muddy actual content with a drone.
  //
  // Gating is the strict intersection of:
  //   - in an active call (idle dashboard stays silent)
  //   - assistant thinking + nobody talking + not on Telegram
  //     (matches `fillerShouldPlay`)
  //   - VAD inactive
  //   - no spoken filler is currently playing
  const newsSpeaking = wantsNews && fillerHasContent;
  const ttsContentSpeaking = wantsTtsContent;
  useAmbientPad(false);

  // Unified "what's audible right now" status — drives the always-
  // visible mini-player. Priority order:
  //   1. Telegram call holds the audio channel — phone is the speaker.
  //      Telegram comes BEFORE youtube selection because while the call
  //      is live the iframe is paused and music isn't audible to anyone:
  //      the user wants to see the live call phase, not a frozen
  //      "now playing" tile.
  //   2. YouTube selection — user explicitly chose music; show its card
  //      with controls regardless of whether the iframe happens to be
  //      in a thinking window or paused between turns.
  //   3. Spar TTS is actually emitting — the assistant is talking.
  //   4. News filler is the active background mode and there's content
  //      to play. Mirrors the YouTube branch: the card stays visible
  //      with full transport controls regardless of whether the WAV
  //      pool happens to be paused (TTS / VAD / between clips). Sits
  //      ABOVE the VAD-listening branch so a brief user utterance
  //      doesn't strip the play / pause / skip buttons.
  //   5. User VAD is hot — they're speaking right now (no news track).
  //   6. Just thinking, no audible filler.
  //   7. Idle.
  // Conditions mirror the actual hook gates above so the indicator
  // can't drift from what the user hears.
  //
  // Telegram phase — derived from the shared voice-session turn stream
  // because the phone leg doesn't push frame-level mic/TTS flags into
  // the dashboard. Heuristics match the downstream effectiveBusy /
  // effectiveListening / effectiveTtsIdle derivation later in this file
  // (kept in lockstep so the indicator and the chime cues agree):
  //   - thinking : last turn is the user's, ≤ 30 s old (assistant is
  //                generating the reply).
  //   - speaking : last turn is the assistant's and recent enough that
  //                Telegram is probably still playing it back. Heuristic
  //                ~50 ms per char, clamped 1.5–15 s.
  //   - listening: default — phone mic is open, nobody mid-turn.
  const fillerNow = useMemo<import("./SparContext").FillerNow>(() => {
    if (voice.channel === "telegram") {
      const lastTurn =
        voice.turns.length > 0 ? voice.turns[voice.turns.length - 1] : null;
      const now = Date.now();
      let phase: "listening" | "thinking" | "speaking" = "listening";
      if (lastTurn) {
        const age = now - lastTurn.at;
        if (lastTurn.role === "user" && age < 30_000) {
          phase = "thinking";
        } else if (
          lastTurn.role === "assistant" &&
          age < Math.max(1_500, Math.min(15_000, lastTurn.text.length * 50))
        ) {
          phase = "speaking";
        }
      }
      return { kind: "telegram", phase };
    }
    if (voice.youtube.videoId) {
      return {
        kind: "youtube",
        videoId: voice.youtube.videoId,
        title: voice.youtube.title,
        thumbnailUrl: voice.youtube.thumbnailUrl,
        status: voice.youtube.status === "playing" ? "playing" : "paused",
      };
    }
    if (ttsAudible || !ttsIdle) return { kind: "speaking" };
    // News surfaces whenever the user has opted into news mode and
    // there's content to play — same shape as the YouTube branch
    // above. Sits ABOVE the listening branch on purpose: VAD-driven
    // pauses are handled by the playback gate (newsShouldPlay), but
    // the card itself should stay mounted with its transport buttons
    // visible the whole time.
    if (wantsNews && fillerHasContent) {
      return {
        kind: "news",
        clipId: newsCurrentClip?.id ?? null,
        title: newsCurrentClip?.title ?? null,
        source: newsCurrentClip?.source ?? null,
        paused: newsPaused,
      };
    }
    if (listening && vadActive) return { kind: "listening" };
    if (busy) return { kind: "thinking" };
    return { kind: "idle" };
  }, [
    voice.youtube.videoId,
    voice.youtube.title,
    voice.youtube.thumbnailUrl,
    voice.youtube.status,
    voice.channel,
    voice.turns,
    ttsAudible,
    ttsIdle,
    listening,
    vadActive,
    wantsNews,
    fillerHasContent,
    newsCurrentClip,
    newsPaused,
    busy,
  ]);
  // "Mic is open" chime — shares the same WAV the Python service
  // plays into Telegram calls so the user hears an identical cue on
  // either channel. Preloaded at mount so firing it later is
  // zero-latency; fails silent if telegram-voice has never baked the
  // file into ./sounds/.
  // `?v=` cache-bust matches `_SOUND_RECIPE_VERSION` in the Python
  // service — the sounds route marks WAV responses `immutable`, so
  // bumping the query string is how we force a refetch after the
  // your-turn chime's bell recipe changes.
  const playYourTurnChime = useChime("/api/telegram/sounds/your_turn.wav?v=2");
  // One-shot "assistant is thinking" cue that mirrors the WAV the
  // Python worker plays into Telegram calls (same file, same
  // acoustic signature). `?v=3` matches the bumped
  // _SOUND_RECIPE_VERSION in service.py.
  const playThinkingStartChime = useChime(
    "/api/telegram/sounds/thinking_start.wav?v=3",
  );
  // "Message sent" confirmation chime — short warm descending pair
  // that fires the moment a user-typed message hits the wire. Plays
  // on both dashboard and Telegram so the user gets the same
  // submit-acknowledged feedback regardless of where they're voicing.
  const playMessageSentChime = useChime(
    "/api/telegram/sounds/message_sent.wav?v=1",
  );
  // Mic-close cue — synthesised at runtime instead of fetched as a WAV
  // so the cue lands sample-accurate on the falling edge of `listening`
  // (no fetch / decode / element-priming latency). Soft descending
  // bell-pair, deliberately quieter and lower-pitched than the
  // your-turn cue so the open vs close cues read as opposites without
  // the user having to think about which one is which:
  //   - your_turn.wav is bright (D6 ≈ 1175 Hz, 0.35 s ring)
  //   - mic-close is duller (E5 → A4, ~120 ms each, no ring)
  // Telegram path still routes through the Python service's own audio
  // (laptop is silenced during phone calls per the call-mode policy),
  // so the call sites below gate on `!voice.channel === "telegram"`.
  const playMicCloseTone = useToneCue({
    notes: [
      // Two soft taps descending — minor third with a 60 ms beat.
      { freq: 659.25, offsetMs: 0, decayMs: 110, velocity: 1.0 }, // E5
      { freq: 440.0, offsetMs: 60, decayMs: 130, velocity: 0.85 }, // A4
    ],
    peak: 0.12,
  });
  const prevBusyRef = useRef(false);
  useEffect(() => {
    // Fire once on the busy rising edge during a dashboard call.
    // Telegram-driven thinking is handled by a separate effect below
    // because raw `busy` doesn't flip there — `effectiveBusy` does.
    const wasBusy = prevBusyRef.current;
    prevBusyRef.current = busy;
    if (!busy || wasBusy) return;
    if (voice.channel === "telegram") return;
    playThinkingStartChime();
  }, [busy, voice.channel, playThinkingStartChime]);

  // Mic-close cue: fires once on the FALLING edge of `listening`. The
  // mic closes for a few different reasons (final result delivered,
  // micMuted toggled, busy taking over, endCall), and the user has
  // asked for a single audible "mic stopped" confirmation in all of
  // them — so the trigger is the unified state edge, not each cause.
  //
  // Gated against Telegram because the laptop stays silent while the
  // phone owns the audio leg (Python service voices its own cues into
  // the call). Also skipped on the very first transition from initial
  // false → false (no-op edge) by tracking the prior value in a ref.
  const prevListeningRef = useRef(false);
  useEffect(() => {
    const wasListening = prevListeningRef.current;
    prevListeningRef.current = listening;
    if (!wasListening || listening) return;
    if (voice.channel === "telegram") return;
    playMicCloseTone();
  }, [listening, voice.channel, playMicCloseTone]);
  useEffect(() => {
    const onTelegram = voice.channel === "telegram";
    const wasOnTelegram = telegramActiveRef.current;
    telegramActiveRef.current = onTelegram;
    if (onTelegram && !wasOnTelegram) {
      // Audio hand-off (remarks #70/#72/#112): finish the *currently
      // audible* utterance on dashboard, then go silent. The phone
      // will hear the full reply via /speak (spar route's finally
      // block) and YouTube/news/hum cut over via the existing
      // hardCutoff path, so this is the only handler that has to
      // reconcile the in-flight TTS queue.
      //
      // Three moves, in order:
      //
      //   1. Bump ttsGenRef so any /api/tts POST currently in-flight
      //      gets its result discarded when it returns (speakChunk
      //      checks the gen before queueing the blob). Without this,
      //      a request that left the dashboard 50 ms before the
      //      acquire would still queue and play.
      //
      //   2. Drop and revoke the queued blobs that haven't started
      //      playing yet. The earlier fix kept these so "the current
      //      utterance finishes" — but a multi-paragraph reply can
      //      have 4–6 sentences queued ahead of the playhead, and
      //      letting them all play out while the phone re-speaks the
      //      whole reply stacks audio for many seconds. Drop them.
      //
      //   3. Do NOT pause the audio element. Whatever blob is mid-
      //      playback finishes naturally — that's the "current
      //      utterance" the user is hearing right now, and cutting
      //      it mid-syllable feels like the phone "stole" the audio
      //      instead of taking over from it. When `ended` fires the
      //      queue is empty so playNextTts is a no-op and dashboard
      //      goes silent.
      //
      // `interimText` and the typed draft are left intact so the
      // user can see what they were saying before the phone took
      // over — useful context if they want to repeat or rephrase.
      // The recognizer below is what stops capturing more.
      ttsGenRef.current += 1;
      for (const url of ttsQueueRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }
      ttsQueueRef.current = [];
      ttsPendingRef.current = 0;
      if (restartTimerRef.current) {
        window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
      try {
        // Phone owns the mic now — let Web Speech go quiet so we
        // don't double-capture room audio. The re-arm effect below
        // is gated on telegramActiveRef and won't kick the
        // recognizer back on until the call ends.
        recognitionRef.current?.stop();
      } catch {
        /* already stopping */
      }
    }
    // On the telegram → null edge the normal re-arm effect takes
    // over (inCall && !busy && ttsIdle && !micMuted && !telegram),
    // so nothing to do here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.channel]);

  // While the call is on Telegram, mirror new turns from the shared
  // voice-session into this transcript so the user can read along on
  // the dashboard even while speaking on the phone. The session is
  // authoritative during a Telegram call — sendMessage is gated by
  // the 204 from /api/spar so nothing writes locally — which means
  // we can safely replace tail segments with whatever the poll says.
  //
  // We only touch the trailing turns past the current message count
  // plus the known number of "pre-call" messages, so we never rewrite
  // history the user already saw.
  useEffect(() => {
    if (voice.channel !== "telegram") return;
    if (voice.turns.length === 0) return;
    setMessages((prev) => {
      const telegramTurns = voice.turns.filter((t) => t.channel === "telegram");
      if (telegramTurns.length === 0) return prev;
      // How many of the current local messages are already covered by
      // the shared session? We match from the newest backwards by
      // (role, text) — messages content is the same modulo trim.
      const already = new Set<string>();
      for (const m of prev) already.add(`${m.role}${m.content.trim()}`);
      const next = prev.slice();
      let changed = false;
      for (const t of telegramTurns) {
        const key = `${t.role}${t.text.trim()}`;
        if (already.has(key)) continue;
        next.push({
          id: nextIdRef.current++,
          role: t.role,
          content: t.text,
        });
        already.add(key);
        changed = true;
      }
      if (!changed) return prev;
      return next.slice(-MAX_TRANSCRIPT);
    });
  }, [voice.channel, voice.turns, voice.turnCount]);

  // Server-side persistence is the new source of truth for spar
  // transcripts: every turn is written to spar_messages so reloads,
  // device switches, and the new sidebar thread list all read from
  // the same row set. The legacy localStorage cache stays as a
  // first-paint cache (so the chat doesn't flash empty while the
  // hydration GET races) but the server's response always wins.
  const transcriptKey = `${TRANSCRIPT_KEY_PREFIX}${currentUser.id}`;
  const transcriptLoadedRef = useRef(false);
  const [conversations, setConversations] = useState<SparConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<number | null>(null);
  const activeConversationIdRef = useRef<number | null>(null);
  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);
  const [loadingConversation, setLoadingConversation] = useState(false);

  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/spar/conversations", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { conversations?: SparConversationSummary[] };
      if (Array.isArray(body.conversations)) {
        setConversations(body.conversations);
      }
    } catch {
      /* network blip — sidebar keeps last-known state */
    }
  }, []);

  type ServerStep = {
    id?: string;
    name?: string;
    label?: string;
    detail?: string;
    source?: string | null;
    status?: "running" | "ok" | "error";
    summary?: string;
  };
  const hydrateMessages = useCallback(
    async (id: number) => {
      setLoadingConversation(true);
      try {
        const res = await fetch(`/api/spar/conversations/${id}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const body = (await res.json()) as {
          conversation?: {
            id: number;
            title: string | null;
            createdAt: number;
            updatedAt: number;
            driftNotice: string | null;
          };
          messages?: Array<{
            id: number;
            role: "user" | "assistant" | "system";
            content: string;
            toolCalls: unknown | null;
            createdAt: number;
          }>;
        };
        // Server is the source of truth for drift state when we
        // switch threads — sync the sidebar row so the chat banner
        // re-paints without waiting on the next WS broadcast.
        if (body.conversation) {
          const conv = body.conversation;
          setConversations((prev) => {
            const exists = prev.some((c) => c.id === conv.id);
            if (!exists) return prev;
            return prev.map((c) =>
              c.id === conv.id
                ? {
                    ...c,
                    title: conv.title,
                    driftNotice: conv.driftNotice,
                    updatedAt: conv.updatedAt,
                  }
                : c,
            );
          });
        }
        const incoming = Array.isArray(body.messages) ? body.messages : [];
        const next: Msg[] = [];
        let nextLocalId = 1;
        for (const m of incoming) {
          if (m.role !== "user" && m.role !== "assistant") continue;
          const role: Role = m.role;
          let steps: ToolStep[] | undefined;
          let sources: string[] | undefined;
          if (role === "assistant" && Array.isArray(m.toolCalls)) {
            const arr = m.toolCalls as ServerStep[];
            steps = arr
              .filter(
                (s): s is { id: string; label: string } & ServerStep =>
                  !!s && typeof s.id === "string" && typeof s.label === "string",
              )
              .map((s, idx) => ({
                id: s.id,
                label: s.label,
                detail: typeof s.detail === "string" ? s.detail : "",
                status:
                  s.status === "running"
                    ? ("ok" as const)
                    : ((s.status ?? "ok") as "ok" | "error"),
                summary: typeof s.summary === "string" ? s.summary : "",
                startedAt: m.createdAt - (arr.length - idx) * 10,
                completedAt: m.createdAt,
              }));
            const seen = new Set<string>();
            const collected: string[] = [];
            for (const s of arr) {
              if (s && typeof s.source === "string" && s.source && !seen.has(s.source)) {
                collected.push(s.source);
                seen.add(s.source);
              }
            }
            sources = collected.length > 0 ? collected : undefined;
          }
          next.push({
            id: nextLocalId++,
            role,
            content: m.content,
            persistedId: m.id,
            ...(role === "assistant" ? { completedAt: m.createdAt } : {}),
            ...(steps ? { steps } : {}),
            ...(sources ? { sources } : {}),
          });
        }
        nextIdRef.current = nextLocalId;
        setMessages(next.slice(-MAX_TRANSCRIPT));
        setActiveConversationId(id);

        // Catch unanswered auto-report nudges left behind by a
        // crash, network blip, or tab that was closed before the
        // response landed. We walk the loaded history backwards: if
        // the trailing user message is tagged auto_report and there's
        // no assistant turn after it in the persisted thread, queue
        // it up for response. Stops at the first assistant message
        // (older auto-reports already got their reply).
        for (let i = incoming.length - 1; i >= 0; i--) {
          const m = incoming[i];
          if (m.role === "assistant" && (m.content ?? "").trim().length > 0) break;
          if (m.role === "user" && isAutoReportTag(m.toolCalls)) {
            enqueueAutoReport({ messageId: m.id, conversationId: id });
            break;
          }
        }
      } finally {
        setLoadingConversation(false);
      }
    },
    [],
  );

  // First-paint cache: read the local snapshot synchronously so the
  // text-mode chat list isn't blank while the conversation list GET
  // is in flight. Anything older than the server's reply gets
  // overwritten by hydrateMessages below.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(transcriptKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Msg[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          const capped = parsed.slice(-MAX_TRANSCRIPT);
          const maxId = capped.reduce((m, x) => Math.max(m, x.id), 0);
          nextIdRef.current = maxId + 1;
          setMessages(capped);
        }
      }
    } catch {
      /* ignore corrupt storage */
    } finally {
      transcriptLoadedRef.current = true;
    }
    // Server-side hydration: pull the user's conversation list and
    // load whichever one was most recently touched. This wins over
    // the localStorage cache the moment it returns.
    void (async () => {
      try {
        const res = await fetch("/api/spar/conversations", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as {
          conversations?: SparConversationSummary[];
        };
        const list = Array.isArray(body.conversations) ? body.conversations : [];
        setConversations(list);
        if (list.length > 0) {
          await hydrateMessages(list[0].id);
        }
      } catch {
        /* offline — caller stays on the localStorage snapshot */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!transcriptLoadedRef.current) return;
    try {
      const capped = messages.slice(-MAX_TRANSCRIPT);
      window.localStorage.setItem(transcriptKey, JSON.stringify(capped));
    } catch {
      /* quota / private mode — tolerate */
    }
  }, [messages, transcriptKey]);

  const selectConversation = useCallback(
    async (id: number) => {
      if (activeConversationIdRef.current === id) return;
      await hydrateMessages(id);
    },
    [hydrateMessages],
  );

  const newConversation = useCallback(() => {
    setMessages([]);
    setActiveConversationId(null);
    nextIdRef.current = 1;
    try {
      window.localStorage.removeItem(transcriptKey);
    } catch {
      /* ignore */
    }
  }, [transcriptKey]);

  const deleteConversationApi = useCallback(
    async (id: number) => {
      try {
        const res = await fetch(`/api/spar/conversations/${id}`, {
          method: "DELETE",
        });
        if (!res.ok) return;
      } catch {
        return;
      }
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeConversationIdRef.current === id) {
        setMessages([]);
        setActiveConversationId(null);
        try {
          window.localStorage.removeItem(transcriptKey);
        } catch {
          /* ignore */
        }
      }
    },
    [transcriptKey],
  );

  // Optimistically clear the active conversation's drift notice and
  // tell the server to forget it. The server's response broadcasts a
  // spar:conversation event so sibling tabs converge on the cleared
  // state too.
  const dismissDriftNotice = useCallback(async () => {
    const id = activeConversationIdRef.current;
    if (id == null) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, driftNotice: null } : c)),
    );
    try {
      await fetch(`/api/spar/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ driftNotice: null }),
      });
    } catch {
      /* network blip — server will reconcile on next broadcast */
    }
  }, []);

  // Autopilot is stored server-side (autopilot_users table) so the
  // 5-min cron in lib/autopilot.ts keeps draining open remarks even
  // when no browser tab is open. We still mirror the last-known value
  // in localStorage so the toggle paints instantly on next mount
  // instead of flickering off → on after the GET resolves.
  const autopilotKey = `${AUTOPILOT_KEY_PREFIX}${currentUser.id}`;
  const autopilotLoadedRef = useRef(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(autopilotKey);
      if (raw === "1") setAutopilot(true);
    } catch {
      /* ignore */
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/spar/autopilot", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { enabled?: boolean };
        if (cancelled) return;
        if (typeof body.enabled === "boolean") setAutopilot(body.enabled);
      } catch {
        /* network blip — keep whatever localStorage gave us */
      } finally {
        autopilotLoadedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!autopilotLoadedRef.current) return;
    try {
      window.localStorage.setItem(autopilotKey, autopilot ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [autopilot, autopilotKey]);

  // Mirror of the saved autopilot directive (north star). The
  // sidebar owns editing; SparProvider only reads it so the
  // completion-path prompt can fold it into the autonomous-loop
  // block. Refetched whenever the sidebar saves (sidebar fires a
  // `spar:autopilot-directive-changed` window event after a
  // successful POST) so the loop sees the new directive on the very
  // next dispatch completion without a page reload.
  const autopilotDirectiveRef = useRef<string>("");
  useEffect(() => {
    let cancelled = false;
    const fetchDirective = async () => {
      try {
        const res = await fetch("/api/spar/autopilot/directive", {
          cache: "no-store",
        });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { directive?: string };
        autopilotDirectiveRef.current =
          typeof json.directive === "string" ? json.directive : "";
      } catch {
        /* network blip — keep whatever we had */
      }
    };
    void fetchDirective();
    const handler = () => {
      void fetchDirective();
    };
    window.addEventListener("spar:autopilot-directive-changed", handler);
    return () => {
      cancelled = true;
      window.removeEventListener(
        "spar:autopilot-directive-changed",
        handler,
      );
    };
  }, []);

  const toggleAutopilot = useCallback(() => {
    setAutopilot((prev) => {
      const next = !prev;
      // Optimistic flip; on a network failure we revert so the UI
      // doesn't lie about the cron's actual state.
      void (async () => {
        try {
          const res = await fetch("/api/spar/autopilot", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: next }),
          });
          if (!res.ok) throw new Error(`status ${res.status}`);
        } catch (err) {
          console.warn("[autopilot] toggle persist failed:", err);
          setAutopilot(prev);
        }
      })();
      return next;
    });
  }, []);

  const appendNotice = useCallback((content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: nextIdRef.current++, role: "assistant", content },
    ]);
  }, []);

  const clearTranscript = useCallback(() => {
    setMessages([]);
    setActiveConversationId(null);
    nextIdRef.current = 1;
    try {
      window.localStorage.removeItem(transcriptKey);
    } catch {
      /* ignore */
    }
  }, [transcriptKey]);

  // Call duration timer.
  useEffect(() => {
    if (!inCall || callStartedAt == null) {
      setCallSeconds(0);
      return;
    }
    const tick = () => setCallSeconds(Math.floor((Date.now() - callStartedAt) / 1000));
    tick();
    const iv = window.setInterval(tick, 500);
    return () => window.clearInterval(iv);
  }, [inCall, callStartedAt]);

  // Poll the dispatch queue so the user sees what spar has proposed or
  // just sent into a project terminal. Voice still drives confirm/cancel;
  // this banner is a safety mirror, not an interactive control.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await fetch("/api/spar/dispatches", { cache: "no-store" });
        if (!r.ok || cancelled) return;
        const json = (await r.json()) as { dispatches: Dispatch[] };
        if (!cancelled) setDispatches(json.dispatches);
      } catch {
        /* ignore transient errors */
      }
    };
    void load();
    const iv = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, []);

  const lastDispatch = useMemo(
    () =>
      dispatches
        .slice()
        .sort((a, b) => b.confirmedAt - a.confirmedAt)[0] ?? null,
    [dispatches],
  );

  const callTimeLabel = useMemo(() => {
    const m = Math.floor(callSeconds / 60)
      .toString()
      .padStart(2, "0");
    const s = (callSeconds % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }, [callSeconds]);

  function newMsg(role: Role, content = ""): Msg {
    return {
      id: nextIdRef.current++,
      role,
      content,
      ...(role === "assistant" ? { startedAt: Date.now() } : {}),
    };
  }

  function ensureAnalyser() {
    if (analyserRef.current) {
      audioCtxRef.current?.resume().catch(() => {
        /* ignore */
      });
      return;
    }
    const el = audioElRef.current;
    if (!el) return;
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AC) return;
    try {
      const ac = new AC();
      const src = ac.createMediaElementSource(el);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.72;
      src.connect(analyser);
      analyser.connect(ac.destination);
      ac.resume().catch(() => {
        /* ignore — will retry on next ttsPrime */
      });
      audioCtxRef.current = ac;
      analyserRef.current = analyser;
    } catch {
      /* createMediaElementSource can only be called once per element;
         any rerun after HMR or React 18 strict-mode double-mount will
         throw. The first setup wins — subsequent calls no-op. */
    }
  }

  function ttsPrime() {
    const el = audioElRef.current;
    if (!el) return;
    ensureAnalyser();
    el.src =
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=";
    el.play().catch(() => {
      /* desktop may reject priming; harmless */
    });
  }

  function checkTtsIdle() {
    if (
      ttsPendingRef.current === 0 &&
      ttsQueueRef.current.length === 0 &&
      !ttsPlayingRef.current
    ) {
      ttsIdleRef.current = true;
      setTtsIdle(true);
    }
    maybeFireSignoff();
  }

  function maybeFireSignoff() {
    if (!signoffArmedRef.current) return;
    if (signoffInFlightRef.current) return;
    if (ttsPendingRef.current !== 0) return;
    if (ttsQueueRef.current.length !== 0) return;
    if (ttsPlayingRef.current) return;
    const word = readSignoffWord().trim();
    signoffArmedRef.current = false;
    if (!word) return;
    signoffInFlightRef.current = true;
    speakChunk(word);
  }

  function ttsCancel() {
    ttsGenRef.current += 1;
    for (const url of ttsQueueRef.current) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* ignore */
      }
    }
    ttsQueueRef.current = [];
    const el = audioElRef.current;
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
      }
    }
    ttsPlayingRef.current = false;
    ttsPendingRef.current = 0;
    signoffArmedRef.current = false;
    signoffInFlightRef.current = false;
    ttsIdleRef.current = true;
    setTtsIdle(true);
  }

  function playNextTts() {
    if (ttsPlayingRef.current) return;
    const el = audioElRef.current;
    if (!el) return;
    const url = ttsQueueRef.current.shift();
    if (!url) return;
    ttsPlayingRef.current = true;
    el.src = url;
    // Filler → answer handoff. awaitFillerHandoff is a no-op when
    // nothing is audible (the within-turn case — chunk N+1 doesn't
    // insert a breath mid-sentence). When filler IS audible, it
    // triggers every registered stop handler, waits for them all to
    // report silent, and then waits an extra ~150 ms breath before
    // resolving — which is exactly when we want el.play() to fire.
    const myGen = ttsGenRef.current;
    void awaitFillerHandoff(150).then(() => {
      // ttsCancel bumps the generation; if that happened while we
      // were waiting, this URL is dead — drop it and reset state.
      if (myGen !== ttsGenRef.current) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
        ttsPlayingRef.current = false;
        return;
      }
      el.play().catch(() => {
        ttsPlayingRef.current = false;
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
        playNextTts();
      });
    });
  }

  useEffect(() => {
    const el = audioElRef.current;
    if (!el) return;
    function onEnded() {
      const url = el?.src;
      if (url && url.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
      }
      ttsPlayingRef.current = false;
      // Audio element just stopped — flip audible false so YT
      // duck gate releases. onPause also covers this, but ended
      // doesn't always fire a separate pause event on every
      // browser, so we duplicate the signal to be sure.
      //
      // Set tail-settling synchronously in the SAME render as the
      // ttsAudible flip. Without this, the consolidated mic-gate
      // effect runs first with ttsAudible=false / tailSettling=false
      // and re-acquires the mic for one render — long enough for
      // macOS to flash the orange capture indicator. Pinning
      // tailSettling=true here keeps shouldSilence true through the
      // transition; the tail-settling effect will then schedule the
      // 450 ms timer normally.
      setTtsTailSettling(true);
      setTtsAudible(false);
      playNextTts();
      maybeFireSignoff();
      // If nothing more is queued, fully release the audio element so
      // iOS Safari stops treating it as the active audio session.
      // Without this, the next SpeechRecognition.start() call never
      // produces audio on iPhone.
      if (
        el &&
        ttsQueueRef.current.length === 0 &&
        !ttsPlayingRef.current &&
        ttsPendingRef.current === 0
      ) {
        try {
          el.pause();
          el.removeAttribute("src");
          el.load();
        } catch {
          /* ignore */
        }
      }
      checkTtsIdle();
    }
    function onError() {
      ttsPlayingRef.current = false;
      // Same synchronous tail-pin as onEnded — close the
      // ttsAudible→false race that briefly re-acquires the mic.
      setTtsTailSettling(true);
      setTtsAudible(false);
      playNextTts();
      checkTtsIdle();
    }
    // play / pause / playing fire on the actual audio output edges.
    // `play` fires as soon as play() is called; `playing` fires when
    // the browser is ready to output samples. We listen to BOTH so
    // the duck triggers at the earliest edge (play, even before
    // buffering finishes) — we want YT muted the moment TTS is
    // queued for output, not after its first sample.
    function onPlay() {
      console.info("[YT-FILLER] tts onPlay → duck");
      setTtsAudible(true);
    }
    function onPlaying() {
      // Redundant with onPlay but harmless; some browsers skip play
      // and only fire playing.
      setTtsAudible(true);
    }
    function onPause() {
      console.info("[YT-FILLER] tts onPause → release duck");
      // Same synchronous tail-pin as onEnded — close the
      // ttsAudible→false race that briefly re-acquires the mic.
      setTtsTailSettling(true);
      setTtsAudible(false);
    }
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    el.addEventListener("play", onPlay);
    el.addEventListener("playing", onPlaying);
    el.addEventListener("pause", onPause);
    return () => {
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("pause", onPause);
    };
  }, []);

  function speakChunk(text: string) {
    // Mute is text-chat only — when the user is actively in a call
    // we always speak regardless of the persisted preference. The
    // call leg owns the audio output, so respecting the mute there
    // would silence the assistant mid-conversation.
    if (ttsMutedRef.current && !inCallRef.current) return;
    // Shared session moved to Telegram → the phone call is voicing
    // the reply. Skipping here prevents the laptop from echoing it
    // 200 ms later (the call's audio path is longer than the local
    // one, so they'd collide rather than stack cleanly).
    if (telegramActiveRef.current) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const gen = ttsGenRef.current;
    ttsPendingRef.current += 1;
    ttsIdleRef.current = false;
    setTtsIdle(false);
    ttsFetchChainRef.current = ttsFetchChainRef.current.then(async () => {
      if (gen !== ttsGenRef.current) return;
      try {
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed, speed: 1.05 }),
        });
        if (!r.ok || gen !== ttsGenRef.current) return;
        // 204 = server-side mute (usually because a Telegram call is
        // voicing this reply). Don't queue an empty blob.
        if (r.status === 204) return;
        const blob = await r.blob();
        if (gen !== ttsGenRef.current || blob.size === 0) return;
        const url = URL.createObjectURL(blob);
        ttsQueueRef.current.push(url);
        playNextTts();
      } catch {
        /* fetch failed — stay silent rather than throw */
      } finally {
        ttsPendingRef.current = Math.max(0, ttsPendingRef.current - 1);
        checkTtsIdle();
      }
    });
  }

  function flushSpokenText(fullText: string, final: boolean) {
    // Same call-aware gate as speakChunk. Marking the cursor as
    // fully consumed prevents a later un-mute from suddenly
    // back-speaking the entire reply.
    if (ttsMutedRef.current && !inCallRef.current) {
      spokenCharsRef.current = fullText.length;
      return;
    }
    const offset = spokenCharsRef.current;
    if (fullText.length <= offset) return;
    const tail = fullText.slice(offset);
    let chunkEnd = -1;
    if (final) {
      chunkEnd = tail.length;
    } else {
      let m: RegExpExecArray | null;
      let last = -1;
      while ((m = SENTENCE_BOUNDARY.exec(tail)) !== null) last = m.index + 1;
      chunkEnd = last;
      if (chunkEnd <= 0 && offset === 0 && tail.length >= 15) {
        const wordEnd = /\S\s(?=\S)/g;
        let wm: RegExpExecArray | null;
        let wLast = -1;
        while ((wm = wordEnd.exec(tail)) !== null) wLast = wm.index + 1;
        chunkEnd = wLast > 0 ? wLast : tail.length;
      }
    }
    if (chunkEnd > 0) {
      const chunk = tail.slice(0, chunkEnd);
      spokenCharsRef.current += chunkEnd;
      speakChunk(chunk);
    }
    if (final && spokenCharsRef.current > 0) {
      signoffArmedRef.current = true;
      maybeFireSignoff();
    }
  }

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

  const addAttachments = useCallback((files: File[]) => {
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        console.warn(`[spar] skipping ${file.name}: exceeds 10 MB`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const att: Attachment = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          dataUrl: reader.result as string,
        };
        setPendingAttachments((prev) => [...prev, att]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clearAttachments = useCallback(() => {
    setPendingAttachments([]);
  }, []);

  const sendMessage = useCallback(
    async (raw: string, opts?: { kickoff?: boolean }) => {
      const text = raw.trim();
      if (!opts?.kickoff && !text && !pendingAttachmentsRef.current.length) return;
      if (busyRef.current) return;
      ttsCancel();
      spokenCharsRef.current = 0;
      setBusy(true);
      // Acknowledge the submit with a brief warm chime — fires for
      // real user turns only (kickoff has no user message). Suppressed
      // while a Telegram call holds the audio leg: the dashboard stays
      // silent during a phone call, and the Python worker plays its
      // own confirmation through the phone speaker.
      if (!opts?.kickoff && text && !telegramActiveRef.current) {
        playMessageSentChime();
      }
      const snapshotAttachments = pendingAttachmentsRef.current.length > 0 ? [...pendingAttachmentsRef.current] : undefined;
      if (snapshotAttachments) setPendingAttachments([]);
      const userMsg = opts?.kickoff
        ? null
        : { ...newMsg("user", text), attachments: snapshotAttachments };
      const assistantMsg = newMsg("assistant", "");
      setMessages((prev) =>
        userMsg ? [...prev, userMsg, assistantMsg] : [...prev, assistantMsg],
      );
      const priorHistory = userMsg
        ? [...messagesRef.current, userMsg]
        : messagesRef.current;
      try {
        // Network blips and TLS resets used to surface as
        // "[stream dropped: ...]" right in the chat. Retry up to 3
        // times silently — the user only sees a friendly message if
        // every attempt fails. Two rules keep retries safe:
        //   1. HTTP errors (4xx/5xx) are NOT retried. The server
        //      already retries the CLI 3x before responding (see
        //      lib/spar-claude retry loop in app/api/spar/route.ts),
        //      so a non-OK status here is deterministic.
        //   2. We track "have any *visible* tokens been streamed?" by
        //      stripping the ZWSP keepalive (server flushes one
        //      immediately to keep Cloudflare from closing the
        //      origin). A drop after only ZWSPs is still safe to
        //      retry. A drop after real content is NOT — the server
        //      regenerates from scratch and the user would see
        //      duplicated tokens. In that case we keep the partial
        //      reply and stop, no error suffix.
        const RETRY_DELAYS_MS = [0, 500, 1500];
        let realChunksEmitted = false;
        let httpFailureText: string | null = null;
        let allAttemptsFailed = false;
        // Visible assistant text accumulated across all turns of the
        // agentic loop. The wire is NDJSON now — one JSON event per
        // line — so we can't just decode().concat the raw bytes; we
        // line-buffer inside the read loop and route by event type.
        let accumulatedText = "";
        let accumulatedSteps: ToolStep[] = [];
        // Sources consulted to build this assistant reply. Seeded by
        // the server's first `sources` event (always-injected baseline),
        // then appended by each read-shape tool_use that carries a
        // `source` field. Deduped on insert.
        let accumulatedSources: string[] = [];
        let serverError: string | null = null;

        for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
          if (RETRY_DELAYS_MS[attempt] > 0) {
            await new Promise<void>((r) =>
              setTimeout(r, RETRY_DELAYS_MS[attempt]),
            );
            // Reset between attempts — only reachable when no real
            // content was emitted, so this is just keepalive bytes.
            accumulatedText = "";
            accumulatedSteps = [];
            accumulatedSources = [];
            serverError = null;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, content: "", steps: [], sources: [] }
                  : m,
              ),
            );
          }

          let r: Response;
          try {
            r = await fetch("/api/spar", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                autopilot: autopilotRef.current,
                conversationId: activeConversationIdRef.current,
                messages: priorHistory
                  .slice(-MAX_TRANSCRIPT)
                  .map((m) => ({ role: m.role, content: m.content })),
                attachments: snapshotAttachments?.map((a) => ({
                  name: a.name,
                  type: a.type,
                  dataUrl: a.dataUrl,
                })),
              }),
            });
          } catch (err) {
            if (attempt < RETRY_DELAYS_MS.length - 1) {
              console.warn(
                `[spar] fetch failed (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length}); retrying:`,
                err instanceof Error ? err.message : String(err),
              );
              continue;
            }
            allAttemptsFailed = true;
            break;
          }

          if (!r.ok || !r.body) {
            httpFailureText = await r.text().catch(() => "spar failed");
            break;
          }

          const reader = r.body.getReader();
          const decoder = new TextDecoder();
          let streamFailed = false;
          let lineBuf = "";
          // Apply a single batched setMessages per network read instead
          // of per event — events arrive in tight bursts (assistant turn
          // emits text + tool_use back-to-back) and one render per burst
          // is plenty smooth.
          const applyEvent = (evt: Record<string, unknown>) => {
            const t = evt.t;
            if (t === "ping") return;
            if (t === "conversation" && typeof evt.id === "number") {
              // Server lazily created or confirmed the active row.
              // Pin client-side state to it so subsequent retries and
              // the next turn target the same conversation.
              if (activeConversationIdRef.current !== evt.id) {
                activeConversationIdRef.current = evt.id;
                setActiveConversationId(evt.id);
              }
              return;
            }
            if (t === "text" && typeof evt.v === "string") {
              accumulatedText += evt.v;
              return;
            }
            if (t === "sources" && Array.isArray(evt.v)) {
              // Seed (or top up) the baseline sources from the server.
              // Server emits this once per turn, before tools fire.
              const seen = new Set(accumulatedSources);
              for (const s of evt.v as unknown[]) {
                if (typeof s === "string" && s && !seen.has(s)) {
                  accumulatedSources = [...accumulatedSources, s];
                  seen.add(s);
                }
              }
              return;
            }
            if (
              t === "tool_use" &&
              typeof evt.id === "string" &&
              typeof evt.label === "string"
            ) {
              const detail =
                typeof evt.detail === "string" ? evt.detail : "";
              accumulatedSteps = [
                ...accumulatedSteps,
                {
                  id: evt.id,
                  label: evt.label,
                  detail,
                  status: "running",
                  startedAt: Date.now(),
                },
              ];
              // Tool calls that read a source contribute to the
              // sources strip too. Action tools (write/dispatch/send)
              // arrive without a `source` field and don't show up.
              if (typeof evt.source === "string" && evt.source) {
                if (!accumulatedSources.includes(evt.source)) {
                  accumulatedSources = [...accumulatedSources, evt.source];
                }
              }
              return;
            }
            if (t === "tool_result" && typeof evt.id === "string") {
              const ok = evt.ok !== false;
              const summary =
                typeof evt.summary === "string" ? evt.summary : "";
              accumulatedSteps = accumulatedSteps.map((step) =>
                step.id === evt.id
                  ? {
                      ...step,
                      status: ok ? "ok" : "error",
                      summary,
                      completedAt: Date.now(),
                    }
                  : step,
              );
              return;
            }
            if (t === "error" && typeof evt.v === "string") {
              serverError = evt.v;
              return;
            }
          };
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              lineBuf += decoder.decode(value, { stream: true });
              let nl: number;
              let touched = false;
              while ((nl = lineBuf.indexOf("\n")) !== -1) {
                const line = lineBuf.slice(0, nl).trim();
                lineBuf = lineBuf.slice(nl + 1);
                if (!line) continue;
                let evt: unknown;
                try {
                  evt = JSON.parse(line);
                } catch {
                  // Tolerate a malformed line (e.g. proxy injected
                  // some HTML mid-stream) — drop it and keep going.
                  continue;
                }
                if (!evt || typeof evt !== "object") continue;
                const before = realChunksEmitted;
                applyEvent(evt as Record<string, unknown>);
                touched = true;
                // Anything beyond a ping counts as real content for
                // retry-safety — we won't retry once the user has seen
                // text or a tool step.
                if (
                  !before &&
                  (evt as { t?: string }).t &&
                  (evt as { t?: string }).t !== "ping" &&
                  (evt as { t?: string }).t !== "conversation"
                ) {
                  realChunksEmitted = true;
                }
              }
              if (!touched) continue;
              const soFarText = accumulatedText;
              const soFarSteps = accumulatedSteps;
              const soFarSources = accumulatedSources;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? {
                        ...m,
                        content: soFarText,
                        steps: soFarSteps,
                        sources: soFarSources,
                      }
                    : m,
                ),
              );
              flushSpokenText(soFarText, false);
            }
            // Drain any final partial line (no trailing newline).
            const tail = lineBuf.trim();
            lineBuf = "";
            if (tail) {
              try {
                const evt = JSON.parse(tail);
                if (evt && typeof evt === "object") {
                  applyEvent(evt as Record<string, unknown>);
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsg.id
                        ? {
                            ...m,
                            content: accumulatedText,
                            steps: accumulatedSteps,
                            sources: accumulatedSources,
                          }
                        : m,
                    ),
                  );
                }
              } catch {
                /* ignore — tail wasn't a complete JSON line */
              }
            }
          } catch (err) {
            streamFailed = true;
            if (realChunksEmitted) {
              // Mid-stream drop after visible content — keep what we
              // have, no retry (would duplicate), no error suffix.
              break;
            }
            if (attempt < RETRY_DELAYS_MS.length - 1) {
              console.warn(
                `[spar] stream dropped (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length}); retrying:`,
                err instanceof Error ? err.message : String(err),
              );
              continue;
            }
            allAttemptsFailed = true;
            break;
          }

          if (!streamFailed) break;
        }

        const finalContent = httpFailureText
          ? `[error: ${httpFailureText.slice(0, 200)}]`
          : allAttemptsFailed
            ? "Connection lost after 3 attempts — please try again."
            : serverError
              ? accumulatedText
                ? accumulatedText + `\n[error: ${serverError}]`
                : `[error: ${serverError}]`
              : accumulatedText;

        const completedAt = Date.now();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  content: finalContent,
                  completedAt,
                  steps: accumulatedSteps,
                  sources: accumulatedSources,
                }
              : m,
          ),
        );
        flushSpokenText(finalContent, true);
        // Fire-and-forget: feed the turn into the learning pipeline so
        // the user-profile store on the server gets updated. Skipped
        // for kickoff (no user turn yet) and for error replies (we'd
        // be teaching the extractor to store error strings, which is
        // noise). Never awaited — the POST returns 202 immediately and
        // extraction runs in the background.
        const replyForLearn = finalContent.replace(/​/g, "").trim();
        const looksLikeError =
          replyForLearn.startsWith("[error:") ||
          replyForLearn.startsWith("[network:") ||
          replyForLearn.startsWith("[stream dropped:") ||
          replyForLearn.startsWith("Connection lost");
        if (!opts?.kickoff && text && replyForLearn && !looksLikeError) {
          void fetch("/api/knowledge/learn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userText: text,
              assistantText: replyForLearn,
              // Server-side detectCorrectionLike sniffs the user text
              // for correction-shaped phrasing and bumps confidence
              // accordingly — single source of truth, no client/
              // server drift.
            }),
            cache: "no-store",
          }).catch(() => {
            /* learning is best-effort; a failed POST just means we
               miss one turn of memory updates. */
          });
        }
      } finally {
        setBusy(false);
        // Refresh the sidebar list so the new title (if the server
        // just back-filled one from the user's first message) and
        // the bumped updated_at re-sort the threads. Fire-and-forget.
        void refreshConversations();
      }
    },
    [playMessageSentChime, refreshConversations],
  );

  // Server-driven assistant turn. Used by the dispatch-completion
  // auto-reporter and any future event-driven path where the spar
  // should speak up without the user having said anything. The
  // directive is fed to /api/spar as the latest user-role turn
  // (prefixed `[system]`) so Claude's existing tool loop runs
  // unchanged — but the dashboard renders no user bubble for it,
  // and the route skips writing it to the shared voice session.
  //
  // Mirrors the streaming + retry behaviour of sendMessage (line-
  // buffered NDJSON, ZWSP-aware retry safety, fade-in to ttsIdle)
  // minus the user-side ergonomics: no chime, no attachments, no
  // learning-pipeline POST, no kickoff branch. Returns early if the
  // assistant is already mid-reply — the queueCompletion path will
  // re-arm and try again once busy clears.
  const sendSystemInjection = useCallback(
    async (visibleUserPrompt: string, systemAddon?: string) => {
      const trimmed = visibleUserPrompt.trim();
      if (!trimmed) return;
      if (busyRef.current) return;
      ttsCancel();
      spokenCharsRef.current = 0;
      setBusy(true);
      // Render the auto-report as a regular user-typed bubble. The visible
      // prompt is a clean, conversational sentence ("Updates on X — what
      // happened?") that blends into the transcript exactly like a turn the
      // operator typed themselves. The transcript-only assistant turn the
      // old design produced confused the chat (a reply with no question);
      // this version reads as a normal user → assistant pair.
      //
      // Optional `systemAddon` (e.g. the autopilot prompt block) still
      // travels through the route's `systemInjection` field — it carries
      // operational rules we don't want to render in the user's bubble.
      // Tag the bubble as auto-generated so the renderer can show an
      // "Auto-report" badge above it — visually distinguishes work the
      // system kicked off from work the operator typed. Session-only;
      // see Msg.isAutoReport in SparContext for the persistence note.
      const userMsg: Msg = { ...newMsg("user", trimmed), isAutoReport: true };
      const assistantMsg = newMsg("assistant", "");
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      // History includes the freshly-inserted user turn so the route's
      // persistence path stores it as a real user message and Claude
      // sees it as the latest user prompt.
      const priorHistory = [...messagesRef.current, userMsg];
      const systemInjectionField = systemAddon?.trim() || undefined;
      try {
        const RETRY_DELAYS_MS = [0, 500, 1500];
        let realChunksEmitted = false;
        let httpFailureText: string | null = null;
        let allAttemptsFailed = false;
        let accumulatedText = "";
        let accumulatedSteps: ToolStep[] = [];
        // Sources consulted to build this assistant reply. Seeded by
        // the server's first `sources` event (always-injected baseline),
        // then appended by each read-shape tool_use that carries a
        // `source` field. Deduped on insert.
        let accumulatedSources: string[] = [];
        let serverError: string | null = null;

        for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
          if (RETRY_DELAYS_MS[attempt] > 0) {
            await new Promise<void>((r) =>
              setTimeout(r, RETRY_DELAYS_MS[attempt]),
            );
            accumulatedText = "";
            accumulatedSteps = [];
            accumulatedSources = [];
            serverError = null;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, content: "", steps: [], sources: [] }
                  : m,
              ),
            );
          }

          let r: Response;
          try {
            r = await fetch("/api/spar", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                autopilot: autopilotRef.current,
                conversationId: activeConversationIdRef.current,
                messages: priorHistory
                  .slice(-MAX_TRANSCRIPT)
                  .map((m) => ({ role: m.role, content: m.content })),
                ...(systemInjectionField
                  ? { systemInjection: systemInjectionField }
                  : {}),
              }),
            });
          } catch (err) {
            if (attempt < RETRY_DELAYS_MS.length - 1) {
              console.warn(
                `[spar] system-injection fetch failed (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length}); retrying:`,
                err instanceof Error ? err.message : String(err),
              );
              continue;
            }
            allAttemptsFailed = true;
            break;
          }

          if (!r.ok || !r.body) {
            httpFailureText = await r.text().catch(() => "spar failed");
            break;
          }

          const reader = r.body.getReader();
          const decoder = new TextDecoder();
          let streamFailed = false;
          let lineBuf = "";
          const applyEvent = (evt: Record<string, unknown>) => {
            const t = evt.t;
            if (t === "ping") return;
            if (t === "text" && typeof evt.v === "string") {
              accumulatedText += evt.v;
              return;
            }
            if (t === "sources" && Array.isArray(evt.v)) {
              // Seed (or top up) the baseline sources from the server.
              // Server emits this once per turn, before tools fire.
              const seen = new Set(accumulatedSources);
              for (const s of evt.v as unknown[]) {
                if (typeof s === "string" && s && !seen.has(s)) {
                  accumulatedSources = [...accumulatedSources, s];
                  seen.add(s);
                }
              }
              return;
            }
            if (
              t === "tool_use" &&
              typeof evt.id === "string" &&
              typeof evt.label === "string"
            ) {
              const detail =
                typeof evt.detail === "string" ? evt.detail : "";
              accumulatedSteps = [
                ...accumulatedSteps,
                {
                  id: evt.id,
                  label: evt.label,
                  detail,
                  status: "running",
                  startedAt: Date.now(),
                },
              ];
              // Tool calls that read a source contribute to the
              // sources strip too. Action tools (write/dispatch/send)
              // arrive without a `source` field and don't show up.
              if (typeof evt.source === "string" && evt.source) {
                if (!accumulatedSources.includes(evt.source)) {
                  accumulatedSources = [...accumulatedSources, evt.source];
                }
              }
              return;
            }
            if (t === "tool_result" && typeof evt.id === "string") {
              const ok = evt.ok !== false;
              const summary =
                typeof evt.summary === "string" ? evt.summary : "";
              accumulatedSteps = accumulatedSteps.map((step) =>
                step.id === evt.id
                  ? {
                      ...step,
                      status: ok ? "ok" : "error",
                      summary,
                      completedAt: Date.now(),
                    }
                  : step,
              );
              return;
            }
            if (t === "error" && typeof evt.v === "string") {
              serverError = evt.v;
              return;
            }
          };
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              lineBuf += decoder.decode(value, { stream: true });
              let nl: number;
              let touched = false;
              while ((nl = lineBuf.indexOf("\n")) !== -1) {
                const line = lineBuf.slice(0, nl).trim();
                lineBuf = lineBuf.slice(nl + 1);
                if (!line) continue;
                let evt: unknown;
                try {
                  evt = JSON.parse(line);
                } catch {
                  continue;
                }
                if (!evt || typeof evt !== "object") continue;
                const before = realChunksEmitted;
                applyEvent(evt as Record<string, unknown>);
                touched = true;
                if (
                  !before &&
                  (evt as { t?: string }).t &&
                  (evt as { t?: string }).t !== "ping"
                ) {
                  realChunksEmitted = true;
                }
              }
              if (!touched) continue;
              const soFarText = accumulatedText;
              const soFarSteps = accumulatedSteps;
              const soFarSources = accumulatedSources;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? {
                        ...m,
                        content: soFarText,
                        steps: soFarSteps,
                        sources: soFarSources,
                      }
                    : m,
                ),
              );
              flushSpokenText(soFarText, false);
            }
            const tail = lineBuf.trim();
            lineBuf = "";
            if (tail) {
              try {
                const evt = JSON.parse(tail);
                if (evt && typeof evt === "object") {
                  applyEvent(evt as Record<string, unknown>);
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsg.id
                        ? {
                            ...m,
                            content: accumulatedText,
                            steps: accumulatedSteps,
                            sources: accumulatedSources,
                          }
                        : m,
                    ),
                  );
                }
              } catch {
                /* ignore */
              }
            }
          } catch (err) {
            streamFailed = true;
            if (realChunksEmitted) break;
            if (attempt < RETRY_DELAYS_MS.length - 1) {
              console.warn(
                `[spar] system-injection stream dropped (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length}); retrying:`,
                err instanceof Error ? err.message : String(err),
              );
              continue;
            }
            allAttemptsFailed = true;
            break;
          }

          if (!streamFailed) break;
        }

        const finalContent = httpFailureText
          ? `[error: ${httpFailureText.slice(0, 200)}]`
          : allAttemptsFailed
            ? "Connection lost after 3 attempts — please try again."
            : serverError
              ? accumulatedText
                ? accumulatedText + `\n[error: ${serverError}]`
                : `[error: ${serverError}]`
              : accumulatedText;

        const completedAt = Date.now();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  content: finalContent,
                  completedAt,
                  steps: accumulatedSteps,
                  sources: accumulatedSources,
                }
              : m,
          ),
        );
        flushSpokenText(finalContent, true);
      } finally {
        setBusy(false);
      }
    },
    // No deps from the closure — everything we read is via refs or
    // module-stable functions. Matches sendMessage's pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Auto-report when a dispatched task finishes. Two paths feed this:
  //
  //   1. WS push (`dispatch_completed` event from lib/ws.ts) — fires
  //      within ~ms of the project's Claude session going idle. This
  //      is the primary path and carries projectName so the directive
  //      reads naturally ("the task on Badkamerstijl just finished").
  //
  //   2. Polling fallback over /api/spar/dispatches (existing). Catches
  //      tabs that connected AFTER the WS broadcast fired (e.g. user
  //      switched tabs back, browser was throttled). Only the projectId
  //      is available on this path.
  //
  // `reportedCompletionsRef` is shared between both so a dispatch is
  // only summarised once, no matter which path saw it first. We don't
  // gate on `inCall` anymore — the user wants to know when work
  // finishes regardless of whether they're in a voice session, and
  // sendSystemInjection produces a transcript-only assistant turn
  // when the call is offline (no audio talked-over).
  const reportedCompletionsRef = useRef<Set<string>>(new Set());

  // Buffer for completions arriving over the WS bus so a burst
  // (multiple projects finishing within seconds) becomes one combined
  // summary turn instead of N spammy ones.
  type PendingCompletion = {
    projectId: string;
    projectName: string;
    dispatchId: string;
    /** Stage 3: which session for the project completed. Optional —
     *  legacy single-session dispatches omit it from the WS payload
     *  and the auto-report falls back to project-only phrasing.
     *  Carried alongside `sessionOrdinal` so the visible bubble can
     *  say "amaso-portfolio #2" instead of just "amaso-portfolio". */
    sessionId?: string;
    sessionOrdinal?: number;
  };
  const pendingCompletionsRef = useRef<PendingCompletion[]>([]);
  const completionFlushTimerRef = useRef<number | null>(null);
  // Coalescing window. 3s is long enough to bundle near-simultaneous
  // finishes (two dispatches submitted in the same turn) and short
  // enough that the user doesn't notice a delay on a single completion.
  const COMPLETION_BATCH_MS = 3_000;
  // Re-arm interval while the conversation is mid-exchange. We keep
  // checking for an idle gap rather than racing the user's reply.
  const COMPLETION_DEFER_MS = 1_500;

  /**
   * Returns the visible user-bubble text for an auto-report. Reads like
   * something the operator might type, so it blends into the chat
   * naturally. The technical instruction (use read_terminal_scrollback,
   * etc.) is implicit — the spar system prompt already documents the
   * tool, so Claude knows to invoke it when asked about a project.
   * Project IDs travel inline so disambiguation works for multi-project
   * batches even when projectName is missing.
   */
  function buildCompletionPrompt(items: PendingCompletion[]): string {
    if (items.length === 0) return "";
    const label = (it: PendingCompletion): string => {
      const base = it.projectName;
      const idHint =
        it.projectName === it.projectId ? "" : ` (${it.projectId})`;
      const sess =
        it.sessionOrdinal && it.sessionOrdinal > 0
          ? ` session #${it.sessionOrdinal}`
          : "";
      return `${base}${sess}${idHint}`;
    };
    if (items.length === 1) {
      return `Update on ${label(items[0])} — what happened?`;
    }
    const list = items.map(label).join(", ");
    return `Updates on ${list} — what happened on each?`;
  }

  /**
   * Read-only constraint travelled alongside the auto-report's visible
   * prompt. Auto-report is a *report*, not an action: Claude is allowed
   * to inspect terminal output via `read_terminal_scrollback` and
   * summarise it, but must NEVER dispatch new work or send anything
   * back into a terminal — that path was creating runaway loops where
   * each completion fired a fresh dispatch and the loop never ended.
   */
  function buildCompletionSystemAddon(): string | undefined {
    return (
      `[AUTO-REPORT — READ ONLY]\n` +
      `A dispatched task just finished. Read the terminal scrollback ` +
      `with read_terminal_scrollback if you need detail, then summarise ` +
      `what happened in 1-2 sentences for the user.\n\n` +
      `Hard constraints:\n` +
      `- DO NOT call dispatch_to_project. No new terminal work.\n` +
      `- DO NOT send keys, prompts, or any text into any terminal.\n` +
      `- DO NOT create remarks, projects, or queue follow-up tasks.\n` +
      `- This is a passive status report. Read, summarise, stop.`
    );
  }

  function flushPendingCompletions() {
    completionFlushTimerRef.current = null;
    const queue = pendingCompletionsRef.current;
    if (queue.length === 0) return;
    // Defer if the assistant is mid-stream OR TTS is still speaking.
    // The user is in the middle of a turn; a second stream would race
    // the active one. Re-arm a short retry instead of dropping the
    // queue — the buffered ids stay pending and flush as soon as the
    // current exchange settles.
    if (busyRef.current || !ttsIdleRef.current) {
      completionFlushTimerRef.current = window.setTimeout(
        flushPendingCompletions,
        COMPLETION_DEFER_MS,
      );
      return;
    }
    // Drain the buffer atomically — if a new completion arrives while
    // the spar API call is in-flight, it'll re-arm a fresh timer and
    // flush in the next batch.
    const items = queue.slice();
    pendingCompletionsRef.current = [];
    for (const it of items) reportedCompletionsRef.current.add(it.dispatchId);
    const visiblePrompt = buildCompletionPrompt(items);
    if (visiblePrompt) {
      void sendSystemInjection(visiblePrompt, buildCompletionSystemAddon());
    }
  }

  function queueCompletion(item: PendingCompletion) {
    if (reportedCompletionsRef.current.has(item.dispatchId)) return;
    // Dedupe within the buffer too (shouldn't happen — server fires
    // once per dispatch — but a cheap guard against reconnect storms).
    if (
      pendingCompletionsRef.current.some((p) => p.dispatchId === item.dispatchId)
    ) {
      return;
    }
    pendingCompletionsRef.current.push(item);
    if (completionFlushTimerRef.current !== null) {
      window.clearTimeout(completionFlushTimerRef.current);
    }
    completionFlushTimerRef.current = window.setTimeout(
      flushPendingCompletions,
      COMPLETION_BATCH_MS,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Auto-report responder.
  //
  // Server-side terminal-idle.fireIdle drops a synthetic user message
  // ("check output of terminal for X") into the latest spar conversation
  // and tags it with `toolCalls: { kind: "auto_report" }`. THIS code
  // path turns that tag into an assistant response — same shape as if
  // the user had typed the message and hit send.
  //
  // Hard guards (the previous client-driven auto-report was disabled
  // because the model could call dispatch_to_project, the completion
  // would re-fire auto-report, and the loop never terminated):
  //
  //   1. Server-side: /api/spar receives `readOnlyMode: true`, which
  //      strips dispatch_to_project / send_keys_to_project / start_/
  //      stop_terminal / create_/delete_project / deploy_project from
  //      the model's allowed tools. Even if the system directive is
  //      ignored, the tools simply aren't there.
  //   2. Per-message single-fire: processedAutoReportsRef holds every
  //      message id we've already responded to, persisted to
  //      localStorage so the guard survives reload.
  //   3. Cross-tab claim via localStorage TTL — first tab to write
  //      `amaso.spar.autoReport.claim.<id>` owns the response for 60s.
  //   4. Already-answered check: if the conversation has any assistant
  //      message AFTER the auto-report user msg (server restart mid-
  //      response, sibling tab beat us, etc.), skip and mark processed.
  //
  // Queue: in-memory ref of pending {messageId, conversationId} pairs,
  // mirrored to localStorage on every mutation. Items survive page
  // reload, network blip, or being received while the assistant was
  // busy on something else — the queue drains on idle.
  const AUTO_REPORT_QUEUE_KEY = "amaso.spar.autoReport.queue";
  const AUTO_REPORT_PROCESSED_KEY = "amaso.spar.autoReport.processed";
  const AUTO_REPORT_CLAIM_PREFIX = "amaso.spar.autoReport.claim.";
  const AUTO_REPORT_CLAIM_TTL_MS = 60_000;
  const AUTO_REPORT_MAX_PROCESSED = 500;

  type AutoReportEntry = { messageId: number; conversationId: number };
  const autoReportQueueRef = useRef<AutoReportEntry[]>([]);
  const processedAutoReportsRef = useRef<Set<number>>(new Set());
  const autoReportFlushTimerRef = useRef<number | null>(null);

  function isAutoReportTag(tc: unknown): boolean {
    return (
      !!tc &&
      typeof tc === "object" &&
      !Array.isArray(tc) &&
      (tc as Record<string, unknown>).kind === "auto_report"
    );
  }

  function persistAutoReportQueue() {
    try {
      window.localStorage.setItem(
        AUTO_REPORT_QUEUE_KEY,
        JSON.stringify(autoReportQueueRef.current),
      );
    } catch {
      /* localStorage may be full / disabled — non-fatal */
    }
  }

  function persistProcessedAutoReports() {
    try {
      let arr = Array.from(processedAutoReportsRef.current);
      if (arr.length > AUTO_REPORT_MAX_PROCESSED) {
        arr = arr.slice(-AUTO_REPORT_MAX_PROCESSED);
        processedAutoReportsRef.current = new Set(arr);
      }
      window.localStorage.setItem(
        AUTO_REPORT_PROCESSED_KEY,
        JSON.stringify(arr),
      );
    } catch {
      /* ignore */
    }
  }

  function tryClaimAutoReport(messageId: number): boolean {
    const key = AUTO_REPORT_CLAIM_PREFIX + messageId;
    const now = Date.now();
    try {
      const existing = window.localStorage.getItem(key);
      if (existing) {
        const expiresAt = Number(existing);
        if (Number.isFinite(expiresAt) && expiresAt > now) return false;
      }
      window.localStorage.setItem(key, String(now + AUTO_REPORT_CLAIM_TTL_MS));
      return true;
    } catch {
      // localStorage unavailable — fail open so the response still
      // fires. Worst case is two tabs respond when both have storage
      // disabled, which never happens in practice.
      return true;
    }
  }

  function releaseAutoReportClaim(messageId: number) {
    try {
      window.localStorage.removeItem(AUTO_REPORT_CLAIM_PREFIX + messageId);
    } catch {
      /* ignore */
    }
  }

  function enqueueAutoReport(entry: AutoReportEntry) {
    if (processedAutoReportsRef.current.has(entry.messageId)) return;
    const q = autoReportQueueRef.current;
    if (q.some((x) => x.messageId === entry.messageId)) return;
    q.push(entry);
    persistAutoReportQueue();
    scheduleAutoReportFlush();
  }

  function dequeueAutoReport(messageId: number) {
    const q = autoReportQueueRef.current;
    const next = q.filter((x) => x.messageId !== messageId);
    if (next.length !== q.length) {
      autoReportQueueRef.current = next;
      persistAutoReportQueue();
    }
  }

  function scheduleAutoReportFlush() {
    if (autoReportFlushTimerRef.current !== null) return;
    // 50 ms gives React a tick to flush the setMessages from the WS
    // broadcast or the hydrate path so messagesRef.current contains
    // the auto-report user message before respondToAutoReport scans it.
    autoReportFlushTimerRef.current = window.setTimeout(() => {
      autoReportFlushTimerRef.current = null;
      flushAutoReportQueue();
    }, 50);
  }

  function flushAutoReportQueue() {
    if (busyRef.current) {
      // Try again shortly — the queue is persisted, so even a hard
      // reload couldn't lose it. We just wait for the user's current
      // turn to finish.
      autoReportFlushTimerRef.current = window.setTimeout(() => {
        autoReportFlushTimerRef.current = null;
        flushAutoReportQueue();
      }, 1500);
      return;
    }
    const q = autoReportQueueRef.current;
    if (q.length === 0) return;
    const next = q[0];
    void respondToAutoReport(next.messageId, next.conversationId);
  }

  const respondToAutoReport = useCallback(
    async (messageId: number, conversationId: number) => {
      if (processedAutoReportsRef.current.has(messageId)) {
        dequeueAutoReport(messageId);
        return;
      }
      if (busyRef.current) {
        // Already mid-turn. Leave in queue; flushAutoReportQueue retries.
        return;
      }
      // Only the tab that has this conversation active answers — keeps
      // priorHistory honest and lets the other tabs sit out without
      // needing to reach into the DB.
      if (activeConversationIdRef.current !== conversationId) return;

      const target = messagesRef.current.find(
        (m) => m.persistedId === messageId,
      );
      if (!target) {
        // Broadcast hasn't been applied to local state yet. Re-arm.
        autoReportFlushTimerRef.current = window.setTimeout(() => {
          autoReportFlushTimerRef.current = null;
          flushAutoReportQueue();
        }, 200);
        return;
      }

      // Already answered? Skip.
      const idx = messagesRef.current.indexOf(target);
      const hasFollowup = messagesRef.current
        .slice(idx + 1)
        .some((m) => m.role === "assistant" && m.content.trim().length > 0);
      if (hasFollowup) {
        processedAutoReportsRef.current.add(messageId);
        persistProcessedAutoReports();
        dequeueAutoReport(messageId);
        return;
      }

      // Cross-tab race protection. If another tab claimed first, bail
      // — they'll write the assistant reply, the WS broadcast will
      // surface it here, and our hasFollowup check stops the next
      // attempt. Fall through means we own this nudge.
      if (!tryClaimAutoReport(messageId)) return;

      const directive =
        "[AUTO-REPORT — READ ONLY]\n" +
        "A dispatched terminal task just finished. The user message above " +
        "(\"check output of terminal for …\") is a synthetic nudge — " +
        "respond as if they typed it themselves. Read the terminal " +
        "scrollback with read_terminal_scrollback if you need detail, " +
        "then summarise what happened in 1-2 sentences.\n\n" +
        "Hard constraints:\n" +
        "- DO NOT call dispatch_to_project. No new terminal work.\n" +
        "- DO NOT send keys, prompts, or any text into any terminal.\n" +
        "- DO NOT create remarks, projects, or queue follow-up tasks.\n" +
        "- This is a passive status report. Read, summarise, stop.";

      ttsCancel();
      spokenCharsRef.current = 0;
      setBusy(true);
      const assistantMsg = newMsg("assistant", "");
      setMessages((prev) => [...prev, assistantMsg]);

      const priorHistory = messagesRef.current
        .slice(-MAX_TRANSCRIPT)
        .map((m) => ({ role: m.role, content: m.content }));

      let accumulatedText = "";
      let accumulatedSteps: ToolStep[] = [];
      let accumulatedSources: string[] = [];
      let serverError: string | null = null;
      let httpFailureText: string | null = null;
      let allAttemptsFailed = false;
      let realChunksEmitted = false;

      const RETRY_DELAYS_MS = [0, 500, 1500];

      try {
        for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
          if (RETRY_DELAYS_MS[attempt] > 0) {
            await new Promise<void>((r) =>
              setTimeout(r, RETRY_DELAYS_MS[attempt]),
            );
            accumulatedText = "";
            accumulatedSteps = [];
            accumulatedSources = [];
            serverError = null;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, content: "", steps: [], sources: [] }
                  : m,
              ),
            );
          }

          let r: Response;
          try {
            r = await fetch("/api/spar", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                autopilot: false,
                conversationId,
                messages: priorHistory,
                systemInjection: directive,
                skipPersistLastUser: true,
                readOnlyMode: true,
              }),
            });
          } catch (err) {
            if (attempt < RETRY_DELAYS_MS.length - 1) {
              console.warn(
                `[auto-report] fetch failed (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length}); retrying:`,
                err instanceof Error ? err.message : String(err),
              );
              continue;
            }
            allAttemptsFailed = true;
            break;
          }

          if (!r.ok || !r.body) {
            httpFailureText = await r.text().catch(() => "spar failed");
            break;
          }

          const reader = r.body.getReader();
          const decoder = new TextDecoder();
          let lineBuf = "";
          let streamFailed = false;

          const applyEvent = (evt: Record<string, unknown>) => {
            const t = evt.t;
            if (t === "ping") return;
            if (t === "text" && typeof evt.v === "string") {
              accumulatedText += evt.v;
              return;
            }
            if (t === "sources" && Array.isArray(evt.v)) {
              const seen = new Set(accumulatedSources);
              for (const s of evt.v as unknown[]) {
                if (typeof s === "string" && s && !seen.has(s)) {
                  accumulatedSources = [...accumulatedSources, s];
                  seen.add(s);
                }
              }
              return;
            }
            if (
              t === "tool_use" &&
              typeof evt.id === "string" &&
              typeof evt.label === "string"
            ) {
              const detail =
                typeof evt.detail === "string" ? evt.detail : "";
              accumulatedSteps = [
                ...accumulatedSteps,
                {
                  id: evt.id,
                  label: evt.label,
                  detail,
                  status: "running",
                  startedAt: Date.now(),
                },
              ];
              if (typeof evt.source === "string" && evt.source) {
                if (!accumulatedSources.includes(evt.source)) {
                  accumulatedSources = [...accumulatedSources, evt.source];
                }
              }
              return;
            }
            if (t === "tool_result" && typeof evt.id === "string") {
              const ok = evt.ok !== false;
              const summary =
                typeof evt.summary === "string" ? evt.summary : "";
              accumulatedSteps = accumulatedSteps.map((step) =>
                step.id === evt.id
                  ? {
                      ...step,
                      status: ok ? "ok" : "error",
                      summary,
                      completedAt: Date.now(),
                    }
                  : step,
              );
              return;
            }
            if (t === "error" && typeof evt.v === "string") {
              serverError = evt.v;
              return;
            }
          };

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              lineBuf += decoder.decode(value, { stream: true });
              let nl: number;
              let touched = false;
              while ((nl = lineBuf.indexOf("\n")) !== -1) {
                const line = lineBuf.slice(0, nl).trim();
                lineBuf = lineBuf.slice(nl + 1);
                if (!line) continue;
                let evt: unknown;
                try {
                  evt = JSON.parse(line);
                } catch {
                  continue;
                }
                if (!evt || typeof evt !== "object") continue;
                const before = realChunksEmitted;
                applyEvent(evt as Record<string, unknown>);
                touched = true;
                if (
                  !before &&
                  (evt as { t?: string }).t &&
                  (evt as { t?: string }).t !== "ping"
                ) {
                  realChunksEmitted = true;
                }
              }
              if (!touched) continue;
              const soFarText = accumulatedText;
              const soFarSteps = accumulatedSteps;
              const soFarSources = accumulatedSources;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? {
                        ...m,
                        content: soFarText,
                        steps: soFarSteps,
                        sources: soFarSources,
                      }
                    : m,
                ),
              );
              flushSpokenText(soFarText, false);
            }
          } catch (err) {
            streamFailed = true;
            if (realChunksEmitted) break;
            if (attempt < RETRY_DELAYS_MS.length - 1) {
              console.warn(
                `[auto-report] stream dropped (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length}); retrying:`,
                err instanceof Error ? err.message : String(err),
              );
              continue;
            }
            allAttemptsFailed = true;
            break;
          }

          if (!streamFailed) break;
        }

        const finalContent = httpFailureText
          ? `[error: ${httpFailureText.slice(0, 200)}]`
          : allAttemptsFailed
            ? "Connection lost after 3 attempts — please try again."
            : serverError
              ? accumulatedText
                ? accumulatedText + `\n[error: ${serverError}]`
                : `[error: ${serverError}]`
              : accumulatedText;

        const completedAt = Date.now();
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id
              ? {
                  ...m,
                  content: finalContent,
                  completedAt,
                  steps: accumulatedSteps,
                  sources: accumulatedSources,
                }
              : m,
          ),
        );
        flushSpokenText(finalContent, true);
      } finally {
        // Single-fire guard: ALWAYS mark this nudge processed, even on
        // failure. A failed turn shouldn't retry forever — the user
        // can always type "what happened on X?" to re-ask manually.
        processedAutoReportsRef.current.add(messageId);
        persistProcessedAutoReports();
        dequeueAutoReport(messageId);
        releaseAutoReportClaim(messageId);
        setBusy(false);
        // Drain any other pending nudges that piled up while we were busy.
        if (autoReportQueueRef.current.length > 0) {
          scheduleAutoReportFlush();
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Hydrate persistent auto-report state on mount: rehydrate the
  // processed-id set, the pending queue, and run an initial flush.
  // Without this, a user who reloads the dashboard while a nudge was
  // queued mid-turn never gets the response — the queue would be
  // empty and the message would just sit unanswered in the chat.
  useEffect(() => {
    try {
      const rawProcessed = window.localStorage.getItem(
        AUTO_REPORT_PROCESSED_KEY,
      );
      if (rawProcessed) {
        const parsed = JSON.parse(rawProcessed);
        if (Array.isArray(parsed)) {
          processedAutoReportsRef.current = new Set(
            parsed.filter((x): x is number => typeof x === "number"),
          );
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const rawQueue = window.localStorage.getItem(AUTO_REPORT_QUEUE_KEY);
      if (rawQueue) {
        const parsed = JSON.parse(rawQueue);
        if (Array.isArray(parsed)) {
          autoReportQueueRef.current = parsed.filter(
            (x): x is AutoReportEntry =>
              !!x &&
              typeof x === "object" &&
              typeof (x as AutoReportEntry).messageId === "number" &&
              typeof (x as AutoReportEntry).conversationId === "number",
          );
        }
      }
    } catch {
      /* ignore */
    }
    if (autoReportQueueRef.current.length > 0) {
      // Wait a beat for hydrateMessages to fill messagesRef before we
      // try to scan it for the queued messages.
      autoReportFlushTimerRef.current = window.setTimeout(() => {
        autoReportFlushTimerRef.current = null;
        flushAutoReportQueue();
      }, 1000);
    }
    return () => {
      if (autoReportFlushTimerRef.current !== null) {
        window.clearTimeout(autoReportFlushTimerRef.current);
        autoReportFlushTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Apply a cross-device spar:message broadcast. Three cases:
   *
   *   1. Wrong conversation id → bump the sidebar list ordering only.
   *   2. Right conversation, message id already attached to a local
   *      Msg → drop. The other tab is just echoing what we already
   *      have on screen.
   *   3. Right conversation, no matching id locally → either attach
   *      the id to the most recent matching local message (own-tab
   *      echo of an optimistic insert) or append a brand-new bubble
   *      (a sibling tab / phone produced this turn).
   *
   * Heuristic for case 3: walk the local list backwards looking for a
   * persistedId-less message of the same role with the same content;
   * if found, attach. Otherwise insert.
   */
  const handleSparMessageBroadcast = useCallback((rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== "object") return;
    const payload = rawPayload as {
      conversationId?: number;
      message?: {
        id?: number;
        role?: "user" | "assistant" | "system";
        content?: string;
        toolCalls?: unknown;
        createdAt?: number;
      };
    };
    const convId = payload.conversationId;
    const m = payload.message;
    if (typeof convId !== "number" || !m) return;
    if (typeof m.id !== "number" || typeof m.content !== "string") return;
    if (m.role !== "user" && m.role !== "assistant") return;
    const role: Role = m.role;
    const messageId = m.id;
    const content = m.content;
    const createdAt = m.createdAt ?? Date.now();
    const toolCallsRaw = m.toolCalls;

    void refreshConversations();
    if (activeConversationIdRef.current !== convId) return;

    // Detect terminal-completion auto-report nudges (server tags them
    // via toolCalls.kind = "auto_report"). When one lands, we still
    // render the user bubble exactly as if Santi had typed the same
    // message, but we ALSO enqueue an automatic assistant response so
    // the AI processes it without a manual prod. The respondToAutoReport
    // path layers in the read-only guard so this can never re-loop into
    // dispatch_to_project.
    if (role === "user" && isAutoReportTag(toolCallsRaw)) {
      enqueueAutoReport({ messageId, conversationId: convId });
    }

    setMessages((prev) => {
      // Case 2: already attached → no-op.
      if (prev.some((p) => p.persistedId === messageId)) return prev;

      // Case 3a: own-tab optimistic insert. Walk from the end and
      // attach the id to the first matching unmarked message.
      for (let i = prev.length - 1; i >= 0; i--) {
        const candidate = prev[i];
        if (candidate.role !== role) continue;
        if (candidate.persistedId !== undefined) continue;
        if (candidate.content.trim() !== content.trim()) continue;
        const next = prev.slice();
        next[i] = { ...candidate, persistedId: messageId };
        return next;
      }

      // Case 3b: brand-new content from another device. Build the
      // tool-step list out of the persisted snapshot so step cards
      // re-paint identically across tabs.
      let steps: ToolStep[] | undefined;
      let sources: string[] | undefined;
      if (role === "assistant" && Array.isArray(toolCallsRaw)) {
        const arr = toolCallsRaw as Array<{
          id?: string;
          label?: string;
          detail?: string;
          source?: string | null;
          status?: "running" | "ok" | "error";
          summary?: string;
        }>;
        steps = arr
          .filter(
            (s): s is { id: string; label: string } & typeof s =>
              !!s && typeof s.id === "string" && typeof s.label === "string",
          )
          .map((s, idx) => ({
            id: s.id,
            label: s.label,
            detail: typeof s.detail === "string" ? s.detail : "",
            status:
              s.status === "running"
                ? ("ok" as const)
                : ((s.status ?? "ok") as "ok" | "error"),
            summary: typeof s.summary === "string" ? s.summary : "",
            startedAt: createdAt - (arr.length - idx) * 10,
            completedAt: createdAt,
          }));
        const seen = new Set<string>();
        const collected: string[] = [];
        for (const s of arr) {
          if (s && typeof s.source === "string" && s.source && !seen.has(s.source)) {
            collected.push(s.source);
            seen.add(s.source);
          }
        }
        sources = collected.length > 0 ? collected : undefined;
      }
      const newMsg: Msg = {
        id: nextIdRef.current++,
        role,
        content,
        persistedId: messageId,
        ...(role === "assistant" ? { completedAt: createdAt } : {}),
        ...(steps ? { steps } : {}),
        ...(sources ? { sources } : {}),
      };
      return [...prev, newMsg].slice(-MAX_TRANSCRIPT);
    });
  }, [refreshConversations]);

  /**
   * Apply a spar:conversation broadcast (title rename / drift
   * notice update). Updates both the sidebar list and, when the
   * active thread is the target, the chat-level drift banner.
   * Same per-user fan-out semantics as spar:message — the server
   * already filters by user id before sending.
   */
  const handleSparConversationBroadcast = useCallback((rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== "object") return;
    const payload = rawPayload as {
      conversationId?: number;
      title?: string | null;
      driftNotice?: string | null;
      updatedAt?: number;
    };
    const convId = payload.conversationId;
    if (typeof convId !== "number") return;

    setConversations((prev) => {
      let touched = false;
      const next = prev.map((c) => {
        if (c.id !== convId) return c;
        touched = true;
        return {
          ...c,
          ...(typeof payload.title !== "undefined"
            ? { title: payload.title ?? null }
            : {}),
          ...(typeof payload.driftNotice !== "undefined"
            ? { driftNotice: payload.driftNotice ?? null }
            : {}),
          updatedAt: payload.updatedAt ?? c.updatedAt,
        };
      });
      // If this user opened the conversation in another tab and the
      // sidebar list hasn't seen it yet (e.g. created very recently
      // by a fresh /api/spar call elsewhere), refresh the list so
      // the new row pops in.
      if (!touched) {
        void refreshConversations();
        return prev;
      }
      // Resort by updatedAt desc so the renamed thread floats to the
      // top, matching what listConversations would return on a
      // refetch.
      return next.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    });
  }, [refreshConversations]);

  /**
   * Apply a spar:remote_control broadcast. The spar voice assistant
   * (or any caller of /api/spar/remote-control) issues these to drive
   * UI state remotely — toggle autopilot, open/close a sidebar, start
   * a new conversation, set the directive. Each branch:
   *
   *   - mutates whichever piece of local state owns the truth
   *   - dispatches a window CustomEvent for state that lives in
   *     siblings (left sidebar in SparPageShell, right sidebar in
   *     SparFullView)
   *   - flashes a subtle visual cue so the user can see something
   *     happened — body class toggle that the spar layout's CSS
   *     can react to.
   *
   * Server has already mutated the durable side (autopilot table,
   * directive table); the local mutation is just keeping the UI in
   * sync. Unknown actions are dropped silently so the wire format
   * can grow without a coordinated client deploy.
   */
  const handleRemoteControlBroadcast = useCallback((rawPayload: unknown) => {
    if (!rawPayload || typeof rawPayload !== "object") return;
    const wrapper = rawPayload as {
      id?: unknown;
      issuedAt?: unknown;
      payload?: unknown;
    };
    if (
      typeof wrapper.id !== "string" ||
      typeof wrapper.issuedAt !== "number" ||
      !wrapper.payload ||
      typeof wrapper.payload !== "object"
    ) {
      return;
    }
    // Drop replays older than 30s (reconnect storms / queued buffers).
    if (Date.now() - wrapper.issuedAt > 30_000) return;
    const inner = wrapper.payload as { action?: unknown };
    const action = inner.action;
    if (typeof action !== "string") return;

    const flashCue = () => {
      try {
        document.body.classList.add("spar-remote-flash");
        window.setTimeout(() => {
          document.body.classList.remove("spar-remote-flash");
        }, 450);
      } catch {
        /* SSR / DOM gone — non-fatal */
      }
    };

    switch (action) {
      case "toggle_autopilot": {
        const value = (inner as { value?: unknown }).value;
        if (typeof value !== "boolean") return;
        // Server already wrote the autopilot_users row in the route
        // handler — bypass toggleAutopilot's API call (it would
        // double-write) and just sync local state.
        setAutopilot(value);
        flashCue();
        return;
      }
      case "new_conversation": {
        newConversationRef.current?.();
        flashCue();
        return;
      }
      case "set_directive": {
        // Directive lives server-side; AutopilotSidebar refetches
        // when it sees this event, and our own directive ref
        // refetches via the same listener. No local state to set.
        try {
          window.dispatchEvent(
            new CustomEvent("spar:autopilot-directive-changed"),
          );
        } catch {
          /* ignore */
        }
        flashCue();
        return;
      }
      case "open_sidebar":
      case "close_sidebar": {
        const side = (inner as { side?: unknown }).side;
        if (side !== "left" && side !== "right") return;
        try {
          window.dispatchEvent(
            new CustomEvent("spar:remote-sidebar", {
              detail: { side, open: action === "open_sidebar" },
            }),
          );
        } catch {
          /* ignore */
        }
        flashCue();
        return;
      }
      default:
        return;
    }
    // Stable: setAutopilot is a setState (stable identity); the ref
    // wraps newConversation so this callback never goes stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Capture the latest newConversation in a ref so the WS handler
  // (which re-binds only on mount) always calls the current one.
  const newConversationRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    newConversationRef.current = newConversation;
  }, [newConversation]);

  // WS subscriber: connect to the main dashboard sync bus and listen
  // for dispatch_completed events targeted at this user. Reconnects
  // with a fixed 3s backoff (matches ProjectsLiveRefresh). The bus
  // does not replay missed events on connect, so the polling fallback
  // below is what catches completions that fired before this socket
  // came up.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket | null = null;
    let closed = false;
    let reconnectTimer: number | null = null;

    function connect() {
      if (closed) return;
      try {
        ws = new WebSocket(`${proto}//${window.location.host}/api/sync`);
      } catch {
        // URL construction can throw on weird hosts; back off and retry.
        reconnectTimer = window.setTimeout(connect, 3000);
        return;
      }
      ws.addEventListener("message", (e) => {
        let msg: { type?: string } & Record<string, unknown>;
        try {
          msg = JSON.parse(typeof e.data === "string" ? e.data : "");
        } catch {
          return;
        }
        if (msg.type === "spar:message") {
          handleSparMessageBroadcast(msg.payload as unknown);
          return;
        }
        if (msg.type === "spar:conversation") {
          handleSparConversationBroadcast(msg.payload as unknown);
          return;
        }
        if (msg.type === "spar:remote_control") {
          handleRemoteControlBroadcast(msg.payload as unknown);
          return;
        }
        if (msg.type !== "dispatch_completed") return;
        const projectId = typeof msg.projectId === "string" ? msg.projectId : "";
        const projectName =
          typeof msg.projectName === "string" && msg.projectName.trim()
            ? msg.projectName
            : projectId;
        const dispatchId = typeof msg.dispatchId === "string" ? msg.dispatchId : "";
        // Stage 3: optional fields. Pre-Stage-3 dashboards / single-
        // session dispatches omit them; we tolerate either shape.
        const sessionId =
          typeof msg.sessionId === "string" && msg.sessionId
            ? msg.sessionId
            : undefined;
        const sessionOrdinal =
          typeof msg.sessionOrdinal === "number" &&
          Number.isFinite(msg.sessionOrdinal) &&
          msg.sessionOrdinal > 0
            ? msg.sessionOrdinal
            : undefined;
        console.log(
          `[spar-ws] dispatch_completed received project=${projectId} session=${sessionId ?? "<default>"} dispatchId=${dispatchId}`,
        );
        if (!projectId || !dispatchId) {
          console.warn(
            "[spar-ws] dispatch_completed dropped — missing projectId or dispatchId",
          );
          return;
        }
        // Auto-report disabled — was causing infinite dispatch loops.
        // Push notification still fires server-side; the user can ask
        // "what happened?" manually when they want a summary.
        console.log(
          `[spar-ws] dispatch_completed acknowledged project=${projectId} dispatchId=${dispatchId} (auto-report disabled)`,
        );
      });
      ws.addEventListener("close", () => {
        if (closed) return;
        reconnectTimer = window.setTimeout(connect, 3000);
      });
      ws.addEventListener("error", () => {
        // close fires after error — let the close handler reconnect.
      });
    }

    connect();
    return () => {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (completionFlushTimerRef.current !== null) {
        window.clearTimeout(completionFlushTimerRef.current);
        completionFlushTimerRef.current = null;
      }
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    };
    // Subscribe-once on mount; the queueCompletion / flush helpers
    // read refs and never close over stale state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tracks whether we've ever absorbed a dispatches snapshot. The first
  // snapshot — taken at mount, or after the SparProvider has been
  // suspended/throttled by the browser long enough for the WS to drop
  // events — represents historic state, not a fresh in-session
  // completion. Without this gate, every page navigation that triggered
  // a re-evaluation of the polling effect would replay an auto-report
  // for any dispatch that finished within the last 5 minutes — which
  // looks to the operator like "clicking a project triggered a report"
  // because the click and the replay happen back-to-back. Auto-reports
  // should only fire for dispatches that flip from incomplete →
  // complete during the live session.
  const dispatchesSeededRef = useRef(false);

  // Polling fallback. Same guarantees as the WS path but slower —
  // catches events the socket missed (network blip while the tab was
  // foregrounded). Single source of dedupe via reportedCompletionsRef
  // means the WS and polling paths can't double-fire for the same
  // dispatch. The first time this effect runs, we seed reportedCompletionsRef
  // with everything that's already completed so the historic state is
  // treated as "already reported" — only NEW completions during the
  // session will fire.
  // Polling fallback disabled — same reason as the WS path (line 2863):
  // auto-report model turns were dispatching new work into terminals,
  // creating infinite loops. Server-side push notifications still fire
  // when terminals finish; the user can ask "what happened?" manually.
  useEffect(() => {
    if (!dispatchesSeededRef.current) {
      for (const d of dispatches) {
        if (d.completedAt != null) {
          reportedCompletionsRef.current.add(d.id);
        }
      }
      dispatchesSeededRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatches]);

  // Kickoff greeting fires when the user actually starts a call (or types
  // their first message). Running it on mount caused a "Load failed" on
  // iOS Safari because the POST went out before the route was even
  // compiled on the dev server, and there's no state yet to retry into.
  const kickoffFiredRef = useRef(false);
  function maybeKickoff() {
    if (kickoffFiredRef.current) return;
    kickoffFiredRef.current = true;
    void sendMessage("", { kickoff: true });
  }

  function startRecognition() {
    // Belt-and-braces: the call-sites above all gate on telegram, but
    // a future caller forgetting to is the kind of bug that re-opens
    // the laptop mic mid-call and goes unnoticed for weeks. Hard-stop
    // here so there is exactly one place that owns the rule.
    if (telegramActiveRef.current) return;
    if (ttsAudibleRef.current) return;
    if (fillerAudibleRef.current) return;
    const SR =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike })
        .SpeechRecognition ??
      (window as unknown as {
        webkitSpeechRecognition?: new () => SpeechRecognitionLike;
      }).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = "";
      let finalText = "";
      let finalConfSum = 0;
      let finalConfCount = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const alt = res[0];
        if (res.isFinal) {
          finalText += alt.transcript;
          // Chrome populates `confidence` on final results (0..1);
          // other browsers leave it at 0. Treat 0 as "unreported"
          // and skip it in the average so the filter is a no-op
          // there (see CONF_MIN check below).
          if (typeof alt.confidence === "number" && alt.confidence > 0) {
            finalConfSum += alt.confidence;
            finalConfCount += 1;
          }
        } else {
          interim += alt.transcript;
        }
      }
      // VAD tick: any recognised text — REGARDLESS of confidence —
      // flips vadActive. That's intentional: ducking YouTube the
      // instant SR hears *anything* silences the contamination
      // source. A low-confidence result is probably YT echo, but
      // it IS echo, and muting the speaker is what makes the NEXT
      // result come back clean (or absent, if the user isn't
      // actually talking). Decay rearms on every result, so
      // continuous speech pins vadActive true; it relaxes ~800 ms
      // after the last result falls silent.
      if ((interim + finalText).trim()) {
        setVadActive(true);
        if (vadDecayRef.current !== null) {
          window.clearTimeout(vadDecayRef.current);
        }
        vadDecayRef.current = window.setTimeout(() => {
          vadDecayRef.current = null;
          setVadActive(false);
        }, 800);
      }
      // Telegram takes priority: even after rec.stop()/rec.abort() the
      // browser may deliver one more buffered final result, and we must
      // NOT route that into sendMessage — the phone owns the
      // conversation.
      //
      // We also block on ttsAudible / ttsTailSettling / fillerAudible
      // directly. busy and ttsIdle don't perfectly cover the audible
      // window: between TTS chunks ttsIdle can briefly flip true while
      // the speaker is still emitting (and SR's buffer still holds that
      // bleed); the dedicated audio gates close that gap so a buffered
      // echo final lands in the dropped path, not in sendMessage.
      const blocked =
        busyRef.current ||
        !ttsIdleRef.current ||
        ttsAudibleRef.current ||
        ttsTailSettlingRef.current ||
        fillerAudibleRef.current ||
        micMutedRef.current ||
        telegramActiveRef.current;
      const label = blocked && interim.trim() ? `… ${interim.trim()}` : interim.trim();
      setInterimText(label);
      const final = finalText.trim();
      if (!final) return;
      if (blocked) {
        // Don't even surface the dropped-text hint while Telegram is
        // active — it'd flicker stale Web-Speech buffers under the
        // "on Telegram call" status and confuse the user.
        if (!telegramActiveRef.current) {
          setInterimText(`(dropped: ${final.slice(0, 40)})`);
          window.setTimeout(() => setInterimText(""), 1200);
        } else {
          setInterimText("");
        }
        return;
      }
      // Confidence filter — second layer of the echo defence. Direct
      // close-mic speech scores ~0.7–0.95 on Chrome's WebSpeech
      // engine; audio re-captured from the speakers (YouTube /
      // podcast / news-TTS bleed that the browser AEC failed to
      // cancel) comes in noticeably lower. Drop finals below
      // CONF_MIN as likely echo rather than route a fake user turn
      // into sendMessage. Guarded on `finalConfCount > 0` so
      // browsers that don't populate confidence (value is always 0)
      // fall through to the normal send path. The recogniser stays
      // open — don't call rec.stop() here — so the real utterance
      // that probably follows (now that the source is ducked via
      // vadActive above) still lands.
      const CONF_MIN = 0.6;
      if (finalConfCount > 0) {
        const avgConf = finalConfSum / finalConfCount;
        if (avgConf < CONF_MIN) {
          console.info("[spar] dropped low-confidence final", {
            text: final.slice(0, 40),
            confidence: avgConf.toFixed(2),
            threshold: CONF_MIN,
          });
          setInterimText(`(echo? ${final.slice(0, 30)})`);
          window.setTimeout(() => setInterimText(""), 1200);
          return;
        }
      }
      setInterimText("");
      try {
        rec.stop();
      } catch {
        /* already stopping */
      }
      void sendMessage(final);
    };
    rec.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      setInterimText("");
      if (!wantListeningRef.current) return;
      // Don't re-arm while a Telegram call holds the audio. The
      // channel edge effect stopped us for a reason; bouncing back
      // would re-open the laptop mic for the duration of the phone
      // call.
      if (telegramActiveRef.current) return;
      if (restartTimerRef.current) window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = window.setTimeout(() => {
        restartTimerRef.current = null;
        if (
          wantListeningRef.current &&
          !recognitionRef.current &&
          !busyRef.current &&
          !micMutedRef.current &&
          !telegramActiveRef.current &&
          !ttsAudibleRef.current &&
          !fillerAudibleRef.current
        ) {
          startRecognition();
        }
      }, 600);
    };
    rec.onerror = function onErr(this: unknown, ev?: { error?: string }) {
      recognitionRef.current = null;
      setListening(false);
      const code = ev?.error ?? "?";
      if (code !== "no-speech" && code !== "aborted") {
        setInterimText(`mic error: ${code}`);
      }
    } as unknown as () => void;
    try {
      rec.start();
      recognitionRef.current = rec as unknown as { stop: () => void; abort: () => void };
      setListening(true);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setInterimText(`mic start threw: ${detail.slice(0, 80)}`);
    }
  }

  async function acquireMicStream(): Promise<void> {
    if (micStreamRef.current) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
    try {
      // Constraints engage Chrome's full WebRTC processing pipeline so
      // system audio (YouTube filler music, news TTS, idle podcast
      // playback) is cancelled out of the mic capture and only the
      // user's voice survives. Filler audio plays through the speakers
      // and acoustically re-enters the mic — without these flags
      // SpeechRecognition picks up that bleed as a "user turn" and we
      // get hallucinated transcripts mid-music.
      //
      //   echoCancellation  → AEC3 itself. Reference signal is the
      //                       browser's audio output mix, so anything
      //                       <audio>, <video>, WebAudio or YouTube
      //                       iframe emits gets cancelled from the
      //                       captured mic feed.
      //   noiseSuppression  → RNNoise. Trims HVAC, keyboard, fan,
      //                       constant-tone noise so the canceller has
      //                       cleaner input to work with.
      //   autoGainControl   → Keeps the mic level stable so recognition
      //                       confidence doesn't sag when the user
      //                       leans back from the mic.
      //
      // Additional processing on top of the 3 standard constraints:
      //   channelCount: 1   → Mono input. AEC's reference math is more
      //                       reliable on mono — stereo capture can
      //                       leave one channel uncancelled when the
      //                       reference path doesn't differentiate.
      //                       `ideal` rather than `exact` so devices
      //                       that only support stereo don't fail.
      //   sampleRate: 48000 → Match Chrome's internal WebRTC sample
      //                       rate. Without this we resample, and
      //                       resampling between AEC reference and
      //                       capture introduces phase drift that
      //                       degrades cancellation over long sessions.
      //   sampleSize: 16    → 16-bit PCM — what AEC3 expects natively.
      //
      // Chrome legacy flags (`googEchoCancellation`, etc.) are NOT
      // included — modern Chrome ignores them and unknown keys can
      // fail the whole constraint set on strict UAs.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
          sampleSize: { ideal: 16 },
        },
      });
      // Race guard: getUserMedia is async (~50–100 ms). If a gate
      // condition flipped true between the call and resolution, the
      // consolidated effect already ran with `micStreamRef.current ===
      // null` and did nothing — landing this stream now would leave
      // the OS capture (and the orange indicator) live for the rest
      // of the disable window. Stop the freshly-acquired tracks
      // immediately and don't publish them; the next gate-clear edge
      // will re-acquire.
      const shouldSilence =
        micMutedRef.current ||
        ttsAudibleRef.current ||
        ttsTailSettlingRef.current ||
        fillerAudibleRef.current ||
        busyRef.current;
      if (shouldSilence) {
        try {
          for (const t of stream.getTracks()) t.stop();
        } catch {
          /* ignore */
        }
        return;
      }
      micStreamRef.current = stream;
      // Log the active settings so it's obvious from the console
      // whether AEC/NS/AGC actually engaged on this device. Some
      // Bluetooth headsets and OS-level audio routings silently drop
      // one or more of the constraints; if we see `echoCancellation:
      // false` here despite asking for true, that's why mic still
      // captures filler bleed.
      try {
        const track = stream.getAudioTracks()[0];
        const settings = track?.getSettings?.() ?? {};
        console.info("[spar] mic stream active settings", {
          echoCancellation: settings.echoCancellation,
          noiseSuppression: settings.noiseSuppression,
          autoGainControl: settings.autoGainControl,
          channelCount: settings.channelCount,
          sampleRate: settings.sampleRate,
          sampleSize: settings.sampleSize,
          deviceId:
            typeof settings.deviceId === "string"
              ? settings.deviceId.slice(0, 8)
              : null,
        });
      } catch {
        /* getSettings() not supported — informational log only */
      }
    } catch (err) {
      // Permission denied / device busy / HTTPS gate — stay graceful.
      // SpeechRecognition will still try its own path; on Chrome it
      // has browser-default AEC on, so worst case we lose the explicit
      // guarantee but the mic still works.
      console.warn("[spar] mic getUserMedia failed:", err);
    }
  }

  function releaseMicStream(): void {
    const s = micStreamRef.current;
    if (!s) return;
    try {
      for (const t of s.getTracks()) t.stop();
    } catch {
      /* ignore */
    }
    micStreamRef.current = null;
  }

  // Safety net: release the mic if the provider unmounts mid-call
  // (e.g. user navigates away with /spar open). endCall already covers
  // the normal path; this handles the route-away case.
  useEffect(() => {
    return () => {
      releaseMicStream();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startCall = useCallback((opts?: { resumedAt?: number }) => {
    wantListeningRef.current = true;
    setInCall(true);
    const ts = opts?.resumedAt ?? Date.now();
    setCallStartedAt(ts);
    writeActiveCallRecord({
      type: "spar",
      startedAt: ts,
      lastHeartbeat: Date.now(),
    });
    if (!opts?.resumedAt) {
      // Don't log on resume — that's a reload, not a fresh call.
      trackAction("spar:call:start");
    }
    setMicMuted(false);
    if (!telegramActiveRef.current) {
      void acquireMicStream();
      startRecognition();
    }
    ttsPrime();
    maybeKickoff();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const endCall = useCallback(() => {
    wantListeningRef.current = false;
    setInCall(false);
    setCallStartedAt(null);
    // Only clear if THIS is a spar record — otherwise we'd nuke a
    // telegram record that the channel observer is tracking.
    const rec = readActiveCallRecord();
    if (rec && rec.type === "spar") clearActiveCallRecord();
    trackAction("spar:call:end");
    setListening(false);
    if (restartTimerRef.current) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    try {
      recognitionRef.current?.stop();
    } catch {
      /* already stopping */
    }
    ttsCancel();
    releaseMicStream();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resume call after page reload / tab close / dev-server restart.
  // Reads the persisted record, decides whether to trust it, then
  // either re-enters the call with the original start timestamp (so
  // the in-call timer stays continuous) or wipes the record if it
  // turns out to be stale.
  //
  // Staleness reasons we explicitly handle:
  //   1. lastHeartbeat too old → tab closed mid-call long ago, the call
  //      is definitely over.
  //   2. Record says telegram, server says no telegram channel → the
  //      phone call hung up while we were reloading.
  //   3. Record says spar, server says telegram → the user picked up
  //      the phone during the reload; telegram now owns the audio
  //      channel and the spar UI shouldn't fight for it.
  //
  // Telegram resumption is mostly automatic — useVoiceChannel's 100 ms
  // poll surfaces `voice.channel === "telegram"` on its own, which the
  // rest of the UI already reacts to. We just keep/clear the record so
  // the next reload is decided correctly.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rec = readActiveCallRecord();
      if (!rec) return;

      // (1) Heartbeat too old → don't trust.
      if (Date.now() - rec.lastHeartbeat > ACTIVE_CALL_STALENESS_MS) {
        clearActiveCallRecord();
        return;
      }

      // Cross-check server state. The voice-channel poll will catch up
      // a few hundred ms later, but doing this once here lets us make
      // the right decision before any UI flicker.
      let serverChannel: "spar" | "telegram" | "chat" | null = null;
      try {
        const res = await fetch("/api/telegram/session", { cache: "no-store" });
        if (res.ok) {
          const body = (await res.json()) as {
            session?: { channel?: "spar" | "telegram" | "chat" | null } | null;
          };
          serverChannel = body?.session?.channel ?? null;
        }
      } catch {
        /* network blip — fall through with serverChannel=null and
           trust the local record; the 100 ms poll will reconcile if
           we got it wrong */
      }
      if (cancelled) return;

      if (rec.type === "telegram") {
        // (2) The phone call ended during the reload.
        if (serverChannel !== "telegram") {
          clearActiveCallRecord();
          return;
        }
        // Otherwise leave the record in place; the channel observer
        // below will keep its heartbeat fresh.
        return;
      }

      // type === "spar"
      // (3) Telegram took over while we were reloading — yield.
      if (serverChannel === "telegram") {
        clearActiveCallRecord();
        return;
      }
      startCall({ resumedAt: rec.startedAt });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Heartbeat tick while a spar call is active. Updates the record's
  // lastHeartbeat so the staleness check on a future reload knows the
  // call was alive recently. 30 s cadence is loose by design — the only
  // job is to distinguish "tab closed minutes ago" from "tab closed
  // hours ago".
  useEffect(() => {
    if (!inCall) return;
    bumpActiveCallHeartbeat("spar");
    const id = window.setInterval(() => {
      bumpActiveCallHeartbeat("spar");
    }, ACTIVE_CALL_HEARTBEAT_MS);
    return () => window.clearInterval(id);
  }, [inCall]);

  // Telegram channel observer. The phone call is owned by the Python
  // userbot and surfaced via `voice.channel === "telegram"` from the
  // shared session poll, so the dashboard didn't need explicit
  // start/end hooks for it. We mirror its lifecycle into the persisted
  // record so a reload during a call comes back into the same state
  // without flicker, and so a reload right after a hangup correctly
  // shows the no-call UI.
  useEffect(() => {
    if (voice.channel === "telegram") {
      const existing = readActiveCallRecord();
      if (!existing || existing.type !== "telegram") {
        // Either no record or a stale spar record from before the
        // phone took over. Replace with a fresh telegram record.
        writeActiveCallRecord({
          type: "telegram",
          startedAt: Date.now(),
          lastHeartbeat: Date.now(),
        });
      } else {
        bumpActiveCallHeartbeat("telegram");
      }
      return;
    }
    // Channel left telegram (or never was). Clear any telegram record
    // we wrote so we don't try to resume one on the next reload.
    const existing = readActiveCallRecord();
    if (existing && existing.type === "telegram") {
      clearActiveCallRecord();
    }
  }, [voice.channel]);

  const toggleMicMute = useCallback(() => {
    setMicMuted((prev) => {
      const next = !prev;
      if (next) {
        if (restartTimerRef.current) {
          window.clearTimeout(restartTimerRef.current);
          restartTimerRef.current = null;
        }
        try {
          recognitionRef.current?.stop();
        } catch {
          /* already stopping */
        }
      }
      // track.enabled is driven by the consolidated mic-gate effect,
      // which re-runs on `micMuted` and decides whether the hardware
      // capture should currently be live.
      return next;
    });
  }, []);

  const toggleTtsMute = useCallback(() => {
    setTtsMuted((v) => !v);
  }, []);

  // When the user toggles TTS off (and isn't on a call), drop any
  // already-fetched audio on the floor — the queue model has us
  // pre-fetching the next chunk while the current one plays, so
  // without this the user hears a sentence-and-a-half of trailing
  // speech after hitting the toggle. ttsCancel bumps the gen so
  // any /api/tts POST currently in-flight discards its result.
  useEffect(() => {
    if (ttsMuted && !inCall) {
      ttsCancel();
    }
    // ttsCancel is a stable closure over refs only — safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ttsMuted, inCall]);

  // Re-arm the mic once Haiku's reply finishes playing.
  // Also gated on telegram: while the phone call holds the audio
  // channel, the phone's mic is the authoritative input and Web
  // Speech stays off entirely.
  //
  // Side effect: on the "assistant just finished talking" edge we
  // also fire the your-turn chime before the mic opens. Tracking the
  // edge with a ref (was-active → now-idle) instead of just playing
  // whenever the effect runs keeps us from chiming on every state
  // shuffle — e.g. a micMuted toggle or a channel change would
  // otherwise double-fire.
  const ttsAudibleRef = useRef(false);
  useEffect(() => {
    ttsAudibleRef.current = ttsAudible;
  }, [ttsAudible]);

  // Kill recognition the instant TTS starts emitting audio so the mic
  // never picks up the speaker output and feeds it back as user input.
  // We use abort() rather than stop() here: stop() flushes SR's audio
  // buffer and emits one last final result, and that buffer already
  // contains the leading edge of the TTS — that final is exactly the
  // "AI's words transcribed as user input" feedback we're trying to
  // prevent. abort() drops the buffer with no final fired.
  // Hardware track.enabled flips live in the consolidated mic-gate
  // effect below — keeping all the "should the OS see capture?" rules
  // in one place means a new audio source (filler, busy/thinking,
  // future modes) can be added by widening the OR there instead of
  // remembering to flip tracks in three different effects.
  useEffect(() => {
    if (!ttsAudible) return;
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.abort();
    } catch {
      /* already stopping */
    }
  }, [ttsAudible]);

  // Same gate, applied to filler audio (YouTube, news, fun-facts,
  // ambient pad). Without this the laptop mic samples filler output and
  // feeds it back as a transcript — feedback loop and wrong "user said"
  // events. Mirrors the ttsAudible effect above so the mic-arming path
  // stays the single owner of "open the mic". abort() (not stop()) for
  // the same buffered-echo reason.
  useEffect(() => {
    fillerAudibleRef.current = fillerAudible;
    if (!fillerAudible) return;
    if (!recognitionRef.current) return;
    try {
      recognitionRef.current.abort();
    } catch {
      /* already stopping */
    }
  }, [fillerAudible]);

  useEffect(() => {
    return subscribeFillerAudible(setFillerAudible);
  }, []);

  // Consolidated hardware mic gate. macOS / Windows light their
  // OS-level capture indicator (the orange menu-bar dot) for any
  // process that holds a live MediaStreamTrack on a recording device.
  // Setting `track.enabled = false` only mutes the data flowing
  // through JS — the OS still considers the device captured, so the
  // dot stayed lit through every reply. The only way to turn the
  // indicator off is to release the device with `track.stop()`,
  // which is what we do here. Permission has already been granted
  // for the page so the re-acquire on the way back is a sync flip
  // for the user (no prompt) — costs ~50–100 ms, well under the
  // 450 ms tail window we already wait through.
  //
  // Rule: if anything is producing — or about to produce — audio
  // ('busy' for the thinking phase that may launch filler, 'ttsAudible'
  // / 'ttsTailSettling' for the reply itself, 'fillerAudible' for the
  // YouTube / news / fun-fact / ambient sources, 'micMuted' for the
  // user's explicit gate), the device goes dark. Capture resumes only
  // when we're fully silent and waiting on the user.
  useEffect(() => {
    const shouldSilence =
      micMuted || ttsAudible || ttsTailSettling || fillerAudible || busy;
    if (shouldSilence) {
      const stream = micStreamRef.current;
      if (!stream) return;
      try {
        for (const track of stream.getTracks()) track.stop();
      } catch {
        /* ignore — best-effort release */
      }
      micStreamRef.current = null;
      return;
    }
    // All gates cleared. Re-acquire only inside an active spar call
    // (no point holding the device when no one is listening) and only
    // when Telegram isn't holding the audio session (the phone owns
    // the mic in that mode). acquireMicStream is idempotent on
    // micStreamRef so a redundant call is a cheap early return.
    if (!inCallRef.current) return;
    if (telegramActiveRef.current) return;
    if (micStreamRef.current) return;
    void acquireMicStream();
  }, [micMuted, ttsAudible, ttsTailSettling, fillerAudible, busy]);

  // Falling-edge tail window for ANY audio source. See the
  // `ttsTailSettling` declaration above for the why — the same logic
  // applies whether the bleed-source is TTS, news clips, YouTube
  // music, or fun-fact playback: cutting the mic the instant the
  // <audio> element's `ended` fires lets the speakers' acoustic tail
  // (the room reverb / driver decay) into the next mic capture and
  // SR transcribes it as a phantom user turn. The tail name has
  // stuck for historical reasons; conceptually it's an "any audio
  // out → mic stays dark for 450 ms after silence" gate.
  // Cancel any pending clear if either source goes audible again
  // mid-tail so we don't drop the gate while audio is still playing.
  useEffect(() => {
    const POST_AUDIO_TAIL_MS = 450;
    const audible = ttsAudible || fillerAudible;
    if (audible) {
      if (ttsTailTimerRef.current !== null) {
        window.clearTimeout(ttsTailTimerRef.current);
        ttsTailTimerRef.current = null;
      }
      setTtsTailSettling(false);
      return;
    }
    setTtsTailSettling(true);
    if (ttsTailTimerRef.current !== null) {
      window.clearTimeout(ttsTailTimerRef.current);
    }
    ttsTailTimerRef.current = window.setTimeout(() => {
      ttsTailTimerRef.current = null;
      setTtsTailSettling(false);
      // Re-acquiring the hardware mic stream is owned by the
      // consolidated mic-gate effect: when ttsTailSettling flips
      // to false here, that effect re-evaluates and re-acquires
      // (provided nothing else — busy, filler, ttsAudible,
      // mic-mute — still asks for silence).
    }, POST_AUDIO_TAIL_MS);
    return () => {
      if (ttsTailTimerRef.current !== null) {
        window.clearTimeout(ttsTailTimerRef.current);
        ttsTailTimerRef.current = null;
      }
    };
  }, [ttsAudible, fillerAudible]);

  const ttsActiveRef = useRef(false);
  useEffect(() => {
    const ttsActiveNow = busy || !ttsIdle;
    const wasActive = ttsActiveRef.current;
    ttsActiveRef.current = ttsActiveNow;

    if (!inCall) return;
    if (listening) return;
    if (!ttsIdle) return;
    if (busy) return;
    if (micMuted) return;
    if (voice.channel === "telegram") return;
    if (!wantListeningRef.current) return;

    // Falling edge of "AI was doing something": the user just heard
    // the reply wind down, mic is about to open. The Telegram side
    // plays an identical WAV at the same moment in `_handle_turn`.
    if (wasActive) {
      playYourTurnChime();
    }

    const t = window.setTimeout(() => {
      if (
        !recognitionRef.current &&
        wantListeningRef.current &&
        !busyRef.current &&
        !micMutedRef.current &&
        !telegramActiveRef.current &&
        !ttsAudibleRef.current &&
        !fillerAudibleRef.current
      ) {
        startRecognition();
      }
    }, 1200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inCall, busy, listening, ttsIdle, micMuted, voice.channel]);

  // Silence-nudge timer. The user asked for an "annoying training
  // partner who won't let you zone out": when a voice call is open
  // and nobody has said anything for ~60 s, fire a proactive turn
  // that pushes the user — what are you working on, what's stuck,
  // do you need help. Resets every time the user talks (vadActive
  // edge), every time the assistant talks (ttsAudible / busy edge),
  // and bails on Telegram channel because the phone owns the audio
  // there and a dashboard nudge would step on the call.
  //
  // Cooldown: 3 minutes between nudges so we don't pile them up if
  // the user takes a long thinking break. The server-side proactive
  // helper has its own 5 min global cooldown, so the effective
  // floor is 5 min — that's fine; better to under-nudge than to
  // pester through a focused stretch.
  const lastNudgeAtRef = useRef(0);
  useEffect(() => {
    const NUDGE_SILENCE_MS = 60_000;
    const NUDGE_COOLDOWN_MS = 180_000;
    if (!inCall) return;
    if (voice.channel === "telegram") return;
    if (busy) return;
    if (ttsAudible || ttsTailSettling || !ttsIdle) return;
    if (vadActive) return;
    if (micMuted) return;
    if (!wantListeningRef.current) return;

    // Honour the cooldown by stretching the timer when we'd otherwise
    // fire too soon — that way the next vadActive edge still resets
    // it cleanly without a separate "armed but waiting" branch.
    const sinceLast = Date.now() - lastNudgeAtRef.current;
    const wait = Math.max(NUDGE_SILENCE_MS, NUDGE_COOLDOWN_MS - sinceLast);

    const t = window.setTimeout(() => {
      // Re-check at fire time — any of these can flip during the wait
      // and we'd rather drop a nudge than land it mid-utterance.
      if (!inCallRef.current) return;
      if (busyRef.current) return;
      if (ttsAudibleRef.current) return;
      if (ttsTailSettlingRef.current) return;
      if (telegramActiveRef.current) return;
      if (micMutedRef.current) return;
      if (Date.now() - lastNudgeAtRef.current < NUDGE_COOLDOWN_MS) return;
      lastNudgeAtRef.current = Date.now();
      void fetch("/api/spar/proactive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "custom",
          directive:
            "Voice call is open and the user has been silent for about a minute. " +
            "Push them like an annoying training partner: ask what they're working on, " +
            "what's blocking them, or whether they need help thinking through something. " +
            "Energetic, warm, mildly impatient — don't let them zone out. " +
            "One or two short sentences. Plain prose. End on a question.",
        }),
      }).catch(() => {
        /* network blip — the next silence window will try again */
      });
    }, wait);
    return () => window.clearTimeout(t);
  }, [
    inCall,
    voice.channel,
    busy,
    ttsAudible,
    ttsTailSettling,
    ttsIdle,
    vadActive,
    micMuted,
  ]);

  const saveHeartbeat = useCallback(async () => {
    setSavingHeartbeat(true);
    try {
      const r = await fetch("/api/spar/heartbeat", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: speakingUserId, body: heartbeat }),
      });
      if (r.ok) setHeartbeatDirty(false);
    } finally {
      setSavingHeartbeat(false);
    }
  }, [heartbeat, speakingUserId]);

  const loadHeartbeatFor = useCallback(async (userId: number) => {
    const r = await fetch(`/api/spar/heartbeat?user=${userId}`);
    if (!r.ok) return;
    const json = (await r.json()) as { userId: number; body: string };
    setHeartbeat(json.body);
    setSpeakingUserId(json.userId);
    setHeartbeatDirty(false);
  }, []);

  // Derived "effective" conversation state. While Telegram holds the
  // line the dashboard mic is hard-stopped and the local sendMessage
  // path is idle, but the conversation is still happening — the
  // Python worker is appending turns into the shared session. Map
  // that activity into the same listening/thinking/speaking flags so
  // the visualizer keeps animating accurately and the user gets the
  // same status text they'd see on a normal Spar call.
  //
  // - "thinking" → most recent turn is the user's, so the assistant
  //   is generating a reply. Capped at 30s so a stuck worker doesn't
  //   pin the indicator forever.
  // - "speaking" → most recent turn is the assistant's and was added
  //   recently enough that Telegram is probably still playing it
  //   back. Heuristic: ~50ms per char, clamped to 1.5–15s.
  // - otherwise → "listening", since Telegram's mic is always on
  //   when nobody is mid-turn.
  const lastTurn =
    voice.turns.length > 0 ? voice.turns[voice.turns.length - 1] : null;
  const onTelegram = voice.channel === "telegram";
  const telegramThinking =
    onTelegram &&
    !!lastTurn &&
    lastTurn.role === "user" &&
    Date.now() - lastTurn.at < 30_000;
  const telegramSpeaking =
    onTelegram &&
    !!lastTurn &&
    lastTurn.role === "assistant" &&
    Date.now() - lastTurn.at <
      Math.max(1500, Math.min(15_000, lastTurn.text.length * 50));
  const telegramListening =
    onTelegram && !telegramThinking && !telegramSpeaking;

  const effectiveBusy = busy || telegramThinking;
  // While TTS is muted (and we're not in a call) the speech path is
  // bypassed entirely — surface that as "idle" to consumers so the
  // user-message queue drains the moment streaming finishes instead
  // of waiting for a speech window that will never open.
  const effectiveTtsIdle =
    (ttsMuted && !inCall) || (ttsIdle && !telegramSpeaking);
  const effectiveListening = listening || telegramListening;

  // Telegram-call audio policy: the dashboard stays SILENT while the
  // phone owns the audio leg. The Python worker plays its own
  // thinking-start / your-turn cues through the phone, so mirroring
  // them on the laptop would double-fire from two devices the user can
  // hear at once. Refs are kept (instead of dropped) so when the call
  // ends and the channel flips back, future reactivations have a
  // clean baseline rather than re-firing on the very first poll.
  const tgPrevThinkingRef = useRef(false);
  const tgPrevListeningRef = useRef(false);
  useEffect(() => {
    if (voice.channel !== "telegram") {
      tgPrevThinkingRef.current = false;
      tgPrevListeningRef.current = false;
      return;
    }
    // Track the phase edges (so the badge debug log / future hooks
    // could observe them) but DO NOT play any laptop audio. Phone
    // chimes are authoritative.
    tgPrevThinkingRef.current = telegramThinking;
    tgPrevListeningRef.current = telegramListening;
  }, [voice.channel, telegramThinking, telegramListening]);

  // While Telegram holds the line we ignore the manual mic-mute
  // toggle for status purposes — the dashboard mic is off either
  // way, and surfacing "mic muted" would mask the real listening/
  // thinking/speaking state coming from the call.
  const status =
    micMuted && !onTelegram
      ? "mic muted"
      : effectiveBusy
        ? "thinking…"
        : !effectiveTtsIdle
          ? "speaking…"
          : effectiveListening
            ? "listening…"
            : inCall
              ? "connecting…"
              : "tap to call";

  const value = useMemo(
    () => ({
      currentUser,
      canManageOthers,
      messages,
      // Expose the *effective* busy/listening/ttsIdle so consumers
      // (visualizer, mic button, mini-overlay) keep animating
      // accurately during a Telegram call. The internal logic of this
      // provider keeps using the raw flags above — only the
      // outward-facing values are derived.
      busy: effectiveBusy,
      interimText,
      status,
      inCall,
      voiceChannel: voice.channel,
      listening: effectiveListening,
      micMuted,
      ttsMuted,
      ttsIdle: effectiveTtsIdle,
      autopilot,
      callTimeLabel,
      dispatches,
      lastDispatch,
      heartbeat,
      setHeartbeat,
      heartbeatDirty,
      setHeartbeatDirty,
      savingHeartbeat,
      speakingUserId,
      analyserRef,
      messagesEndRef,
      youtubeNowPlaying,
      youtubeQueue,
      youtubeVolume,
      setYoutubeVolume,
      youtubePlay,
      youtubePause,
      youtubeStop,
      youtubeSkip,
      youtubeEnqueue,
      youtubeClearQueue,
      youtubeRemoveFromQueue,
      youtubeReorderQueue,
      fillerNow,
      newsUpcoming,
      newsPause,
      newsResume,
      newsSkip,
      newsUpNextAfterYoutube,
      startCall,
      endCall,
      toggleMicMute,
      toggleTtsMute,
      toggleAutopilot,
      pendingAttachments,
      addAttachments,
      removeAttachment,
      clearAttachments,
      sendMessage,
      saveHeartbeat,
      loadHeartbeatFor,
      clearTranscript,
      appendNotice,
      conversations,
      activeConversationId,
      loadingConversation,
      selectConversation,
      newConversation,
      deleteConversation: deleteConversationApi,
      refreshConversations,
      activeDriftNotice:
        activeConversationId == null
          ? null
          : conversations.find((c) => c.id === activeConversationId)
              ?.driftNotice ?? null,
      dismissDriftNotice,
    }),
    [
      currentUser,
      canManageOthers,
      messages,
      pendingAttachments,
      effectiveBusy,
      interimText,
      status,
      inCall,
      voice.channel,
      effectiveListening,
      micMuted,
      ttsMuted,
      effectiveTtsIdle,
      autopilot,
      callTimeLabel,
      dispatches,
      lastDispatch,
      heartbeat,
      heartbeatDirty,
      savingHeartbeat,
      speakingUserId,
      youtubeNowPlaying,
      youtubeQueue,
      youtubeVolume,
      youtubePlay,
      youtubePause,
      youtubeStop,
      youtubeSkip,
      youtubeEnqueue,
      youtubeClearQueue,
      youtubeRemoveFromQueue,
      youtubeReorderQueue,
      fillerNow,
      newsUpcoming,
      newsPause,
      newsResume,
      newsSkip,
      newsUpNextAfterYoutube,
      startCall,
      endCall,
      toggleMicMute,
      toggleTtsMute,
      toggleAutopilot,
      addAttachments,
      removeAttachment,
      clearAttachments,
      sendMessage,
      saveHeartbeat,
      loadHeartbeatFor,
      clearTranscript,
      appendNotice,
      conversations,
      activeConversationId,
      loadingConversation,
      selectConversation,
      newConversation,
      deleteConversationApi,
      refreshConversations,
      dismissDriftNotice,
    ],
  );

  return (
    <SparContext.Provider value={value}>
      {children}
      <audio ref={audioElRef} preload="auto" className="hidden" />
    </SparContext.Provider>
  );
}
