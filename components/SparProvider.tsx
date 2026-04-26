"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SparContext,
  type Dispatch,
  type Msg,
  type Role,
  type SparUser,
  MAX_TRANSCRIPT,
} from "./SparContext";
import { useVoiceChannel } from "./useVoiceChannel";
import { useThinkingHum } from "./useThinkingHum";
import { useThinkingFiller } from "./useThinkingFiller";
import { useTtsFillerContent } from "./useTtsFillerContent";
import { useAmbientPad } from "./useAmbientPad";
import { awaitFillerHandoff } from "@/lib/filler-handoff";
import { trackAction } from "./UserTracker";
import { useYoutubeFiller } from "./useYoutubeFiller";
import { useChime } from "./useChime";
import { useToneCue } from "./useToneCue";

const TRANSCRIPT_KEY_PREFIX = "spar:transcript:v1:";
const AUTOPILOT_KEY_PREFIX = "spar:autopilot:v1:";
const SENTENCE_BOUNDARY = /[.!?,;:—–](\s|$)/g;

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
  const recognitionRef = useRef<{ stop: () => void } | null>(null);
  const wantListeningRef = useRef(false);
  const restartTimerRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<Msg[]>([]);

  useEffect(() => {
    ttsMutedRef.current = ttsMuted;
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
  //   "news"    → pre-rendered news clips (Kokoro + RSS)
  //   "youtube" → user-selected music / podcast / video audio
  //   "hum"     → windchime only
  //   "off"     → silent filler slot
  const mode = voice.fillerMode;
  const ytVideoId = voice.youtube.videoId;
  const ytSelected = ytVideoId !== null && voice.youtube.status !== "idle";
  const wantsYoutube = mode === "youtube" && ytSelected;
  // Declared up here (not next to the restore effect below) because
  // `wantsNews` consumes it. See the block around setYtRestoring for
  // the lifecycle details. Default false — gets flipped true only
  // when the mount effect finds a fresh localStorage record.
  const [ytRestoring, setYtRestoring] = useState(false);
  // Two reasons to play news: mode is explicitly "news", OR mode is
  // "youtube" but no video is selected (safe fallback).
  //
  // IMPORTANT: during the ~100-500 ms window right after a page
  // refresh, the server's in-memory YouTube state has been wiped but
  // `mode` (from filler-config.json on disk) still says "youtube".
  // Without the `ytRestoring` guard below, that window fires the
  // fallback and the user hears a news headline for a second before
  // YT resumes — which consistently reads as "it defaults back to
  // headlines every time I refresh". The guard holds the fallback
  // back until the restore POST completes (or 4 s times out).
  //
  // If the user is on `mode==="news"` intentionally, we still play
  // news — the guard only affects the youtube-fallback branch.
  const wantsNews =
    mode === "news" ||
    (mode === "youtube" && !ytSelected && !ytRestoring);
  const wantsHum = mode === "hum" || mode === "quiet";
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
  const ttsQuiet = !ttsAudible && ttsIdle;
  const nobodyTalking = ttsQuiet && !vadActive;
  const ytMusicShouldPlay =
    wantsYoutube &&
    voice.youtube.status === "playing" &&
    !fillerOnTelegram &&
    nobodyTalking;
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

  // ---- localStorage persistence: one-shot restore on mount ----
  // Protects against the one scenario the in-memory server state
  // can't: the dashboard process restarts between the user
  // selecting a YouTube track and returning to the tab. Server
  // state is gone, localStorage still has the record. We POST
  // back to /api/youtube/state to rebuild the server selection —
  // after that the existing 100 ms session-poll → useYoutubeFiller
  // flow takes over identically to a fresh play call.
  //
  // `savedRestore` holds the saved position until the hook has
  // actually cued the matching video; passing it as startAtSec
  // while videoId matches makes cueVideoById seek on load. Once
  // the playhead ticks past the saved position it becomes a no-op
  // (YT preserves the real playhead across pause/play).
  type SavedRecord = {
    videoId: string;
    title: string | null;
    thumbnailUrl: string | null;
    durationSec: number | null;
    positionSec: number;
    playlistUrl: string | null;
    // Resting volume (0–100). Default 100 when absent (pre-extension
    // records). Fed to useYoutubeFiller as restoreVolume so the first
    // fade-in lands at the user's prior level.
    volume: number;
    // Sticky server status. "paused" means the user explicitly held
    // silence — after we POST action=play to restore the selection,
    // we follow up with action=pause so the server state matches.
    status: "playing" | "paused";
    savedAt: number;
  };
  const [savedRestore, setSavedRestore] = useState<SavedRecord | null>(null);
  // `ytRestoring` is declared higher up (next to the filler mode
  // wiring) because `wantsNews` consumes it. The flip-to-true lives
  // here inside the restore mount effect; the flip-back-to-false
  // lives in a follow-up effect below that watches
  // voice.youtube.videoId. Overall lifecycle:
  //   true from: we find a fresh localStorage record on mount
  //   false after: server's videoId matches the record OR 4 s timeout
  // Suppresses the "mode=youtube + !ytSelected → fall back to news"
  // branch during the 100–500 ms race where the restore POST hasn't
  // yet landed and the server in-memory state still reads null.
  // That race is what made refreshes sound like "always defaults to
  // headlines" — it was really "headlines for a second, then YT".
  useEffect(() => {
    if (typeof window === "undefined") return;
    let raw: string | null;
    try {
      raw = window.localStorage.getItem("spar-youtube-playback");
    } catch {
      return;
    }
    if (!raw) return;
    let parsed: Partial<SavedRecord>;
    try {
      parsed = JSON.parse(raw) as Partial<SavedRecord>;
    } catch {
      return;
    }
    const vid = parsed.videoId;
    if (typeof vid !== "string" || vid.length !== 11) return;
    const pos =
      typeof parsed.positionSec === "number" && parsed.positionSec >= 0
        ? parsed.positionSec
        : 0;
    const savedAt =
      typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
    // Match the server-side youtube-state 6 h TTL — past that the
    // user probably doesn't want the music to ambush them.
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    if (savedAt > 0 && Date.now() - savedAt > SIX_HOURS_MS) {
      try {
        window.localStorage.removeItem("spar-youtube-playback");
      } catch {
        /* ignore */
      }
      return;
    }
    const rawVolume =
      typeof parsed.volume === "number" && Number.isFinite(parsed.volume)
        ? parsed.volume
        : 100;
    const volume = Math.max(0, Math.min(100, Math.round(rawVolume)));
    const status: "playing" | "paused" =
      parsed.status === "paused" ? "paused" : "playing";
    const record: SavedRecord = {
      videoId: vid,
      title: (parsed.title as string | null) ?? null,
      thumbnailUrl: (parsed.thumbnailUrl as string | null) ?? null,
      durationSec:
        typeof parsed.durationSec === "number" ? parsed.durationSec : null,
      positionSec: pos,
      playlistUrl: (parsed.playlistUrl as string | null) ?? null,
      volume,
      status,
      savedAt,
    };
    setSavedRestore(record);
    setYtRestoring(true);
    console.info(
      "[YT-FILLER] restoring from localStorage:",
      { videoId: vid, positionSec: pos, title: record.title, volume, status },
    );
    // Rebuild server state so everything downstream (mode flip,
    // session poll, hook cue) flows the normal path. Fire-and-
    // forget; if it fails the worst case is no auto-restore, not
    // a broken dashboard. If the user had the video paused before
    // the refresh, we chain a second POST (action=pause) so the
    // sticky pause state comes back too.
    void (async () => {
      try {
        await fetch("/api/youtube/state", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "play",
            video_id: vid,
            title: record.title,
            thumbnail_url: record.thumbnailUrl,
            duration_sec: record.durationSec,
          }),
          cache: "no-store",
        });
        if (status === "paused") {
          await fetch("/api/youtube/state", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "pause" }),
            cache: "no-store",
          });
        }
      } catch {
        /* non-fatal — ytRestoring timeout below will release the
           suppression so the user at least hears SOMETHING eventually */
      }
    })();
    // Mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear ytRestoring once the server-side videoId matches what we
  // asked to restore — the poll will have picked up the rebuilt
  // selection and useYoutubeFiller is cueing the video. Also run a
  // safety timeout so a failed restore POST can't pin the suppression
  // forever (4 s is plenty; the POST + next 100 ms poll typically
  // complete in well under a second).
  useEffect(() => {
    if (!ytRestoring) return;
    if (
      savedRestore &&
      voice.youtube.videoId === savedRestore.videoId
    ) {
      setYtRestoring(false);
      return;
    }
    const id = window.setTimeout(() => setYtRestoring(false), 4_000);
    return () => window.clearTimeout(id);
  }, [ytRestoring, savedRestore, voice.youtube.videoId]);

  // Use the saved position only while the current selection matches
  // what was saved. Switching to a different video (or the user
  // stopping) resets the seek target back to whatever the server
  // reports (which is 0 for a fresh play).
  const startAtSec =
    savedRestore && ytVideoId === savedRestore.videoId
      ? savedRestore.positionSec
      : voice.youtube.positionSec;

  // Mini-player slider state. Initialised from the saved record so a
  // refresh lands on the same resting level; updated live as the user
  // drags. Passed to useYoutubeFiller as `volume`, which snaps the
  // iframe volume on every change.
  const [youtubeVolume, setYoutubeVolume] = useState<number>(100);
  const youtubeVolumeInitRef = useRef(false);
  useEffect(() => {
    if (youtubeVolumeInitRef.current) return;
    if (savedRestore && typeof savedRestore.volume === "number") {
      setYoutubeVolume(
        Math.max(0, Math.min(100, Math.round(savedRestore.volume))),
      );
      youtubeVolumeInitRef.current = true;
    }
  }, [savedRestore]);

  // Telegram-call handoff resync. While a call is active, the Python
  // service is advancing voice.youtube.positionSec via
  // /api/youtube/state action=report_position. The iframe is paused
  // locally (hardCutoff includes voice.channel === "telegram") so its
  // own playhead is frozen at the pre-call value. When the call ends
  // we bump `resyncSignal` so useYoutubeFiller seeks to the fresher
  // server position before resuming. Without this, the user would
  // hear audio they already heard on the phone.
  const lastChannelRef = useRef(voice.channel);
  const [resyncSignal, setResyncSignal] = useState<number>(0);
  useEffect(() => {
    const prev = lastChannelRef.current;
    lastChannelRef.current = voice.channel;
    if (prev === "telegram" && voice.channel !== "telegram") {
      // Snapshot bump — the timestamp serves as a unique trigger value;
      // the hook reads startAtRef.current at fire time, so it always
      // gets the latest server position regardless of when this state
      // update flushes vs. when the next render lands.
      setResyncSignal(Date.now());
    }
  }, [voice.channel]);

  // Auto-advance: when the iframe finishes a video, hit the advance
  // endpoint so the server promotes the next queue item (or stops if
  // the queue is empty). Defined inline rather than reusing youtubeSkip
  // because the skip helper isn't in scope here yet — keeping the
  // network call self-contained avoids a dependency-ordering shuffle.
  const handleVideoEnded = useCallback(() => {
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "advance" }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal — next poll re-syncs */
    });
  }, []);

  useYoutubeFiller({
    active: ytMusicShouldPlay,
    ducked: ytMusicDucked,
    videoId: ytVideoId,
    startAtSec,
    title: voice.youtube.title,
    thumbnailUrl: voice.youtube.thumbnailUrl,
    durationSec: voice.youtube.durationSec,
    playlistUrl: savedRestore?.playlistUrl ?? null,
    // One-shot restore hints. `restoreVolume` targets the first fade-in
    // so a refreshed session lands at the user's prior resting level
    // instead of snapping to 100. `serverStatus` is the authoritative
    // read from the shared voice-session poll — the hook uses it when
    // writing localStorage so a "paused" refresh comes back paused.
    restoreVolume:
      savedRestore && ytVideoId === savedRestore.videoId
        ? savedRestore.volume
        : null,
    volume: youtubeVolume,
    serverStatus: voice.youtube.status as "playing" | "paused" | "idle",
    resyncSignal,
    onEnded: handleVideoEnded,
  });

  const youtubePlay = useCallback(() => {
    const vid = voice.youtube.videoId;
    if (!vid) return;
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "play",
        video_id: vid,
        title: voice.youtube.title,
        thumbnail_url: voice.youtube.thumbnailUrl,
        duration_sec: voice.youtube.durationSec,
      }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal — next poll re-syncs from server */
    });
  }, [
    voice.youtube.videoId,
    voice.youtube.title,
    voice.youtube.thumbnailUrl,
    voice.youtube.durationSec,
  ]);

  const youtubePause = useCallback(() => {
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "pause" }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal */
    });
  }, []);

  const youtubeStop = useCallback(() => {
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "stop" }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal */
    });
  }, []);

  // Skip current track. Server promotes the head of the queue into
  // now-playing, or — if the queue is empty — falls back to a full
  // stop, returning the filler mode to news. The browser doesn't
  // distinguish: the next session poll either reveals the new
  // selection or sees idle, and the iframe hook reacts accordingly.
  const youtubeSkip = useCallback(() => {
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "advance" }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal */
    });
  }, []);

  const youtubeEnqueue = useCallback((item: import("./SparContext").YoutubeQueueItem) => {
    if (!item || !item.videoId) return;
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "enqueue",
        video_id: item.videoId,
        title: item.title,
        thumbnail_url: item.thumbnailUrl,
        duration_sec: item.durationSec,
      }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal */
    });
  }, []);

  const youtubeClearQueue = useCallback(() => {
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clear_queue" }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal */
    });
  }, []);

  const youtubeRemoveFromQueue = useCallback((videoId: string) => {
    if (!videoId) return;
    void fetch("/api/youtube/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove_from_queue", video_id: videoId }),
      cache: "no-store",
    }).catch(() => {
      /* non-fatal — next session poll reconciles the queue */
    });
  }, []);

  const youtubeReorderQueue = useCallback(
    (fromIdx: number, toIdx: number) => {
      if (!Number.isFinite(fromIdx) || !Number.isFinite(toIdx)) return;
      if (fromIdx === toIdx) return;
      void fetch("/api/youtube/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reorder_queue",
          from_index: fromIdx,
          to_index: toIdx,
        }),
        cache: "no-store",
      }).catch(() => {
        /* non-fatal — next session poll reconciles the order */
      });
    },
    [],
  );

  const youtubeQueue = useMemo(
    () =>
      voice.youtube.queue.map((q) => ({
        videoId: q.videoId,
        title: q.title,
        thumbnailUrl: q.thumbnailUrl,
        durationSec: q.durationSec,
      })),
    [voice.youtube.queue],
  );

  const youtubeNowPlaying = useMemo(
    () => ({
      videoId: voice.youtube.videoId,
      title: voice.youtube.title,
      thumbnailUrl: voice.youtube.thumbnailUrl,
      durationSec: voice.youtube.durationSec,
      positionSec: voice.youtube.positionSec,
      // useVoiceChannel types `status` as `string` (it's whatever the
      // poll endpoint returns), so we narrow explicitly here. A
      // disjunction through the type-guard ternary would still leave
      // the truthy branch as `string`; the const triple is the
      // cleanest narrow that fits SparContextValue's literal union.
      status: ((): "playing" | "paused" | "idle" => {
        if (voice.youtube.status === "playing") return "playing";
        if (voice.youtube.status === "paused") return "paused";
        return "idle";
      })(),
    }),
    [
      voice.youtube.videoId,
      voice.youtube.title,
      voice.youtube.thumbnailUrl,
      voice.youtube.durationSec,
      voice.youtube.positionSec,
      voice.youtube.status,
    ],
  );

  // News clips — same unified gate, plus an explicit `!vadActive`
  // check to preserve stop-on-VAD behaviour. (vadActive was removed
  // from hardCutoff because the YouTube hook now handles VAD via
  // mute rather than pause; news has no ducking affordance of its
  // own, so it continues to fully stop during user speech and
  // restart after the 800 ms decay.)
  const { hasContent: fillerHasContent } = useThinkingFiller(
    fillerShouldPlay && !vadActive && wantsNews,
  );

  // Hum fallback — explicit "hum" mode, news mode with empty pool,
  // or YouTube mode without a selection (and no news to fall back
  // to). Same `!vadActive` gate as news for the same reason.
  const humFallbackForNews = wantsNews && !fillerHasContent;
  const humFallbackForYoutube =
    wantsYoutube && mode === "youtube" && !ytSelected && !fillerHasContent;
  useThinkingHum(
    fillerShouldPlay &&
      !vadActive &&
      (wantsHum || humFallbackForNews || humFallbackForYoutube),
  );

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
  useAmbientPad(
    inCall &&
      fillerShouldPlay &&
      !vadActive &&
      !newsSpeaking &&
      !ttsContentSpeaking,
  );

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
  //   4. User VAD is hot — they're speaking right now.
  //   5. News filler currently audible (gating mirrors useThinkingFiller).
  //   6. Hum currently audible (mirrors useThinkingHum gate).
  //   7. Just thinking, no audible filler.
  //   8. Idle.
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
    if (listening && vadActive) return { kind: "listening" };
    if (fillerShouldPlay && !vadActive && wantsNews && fillerHasContent) {
      return { kind: "news" };
    }
    if (
      fillerShouldPlay &&
      !vadActive &&
      (wantsHum || humFallbackForNews || humFallbackForYoutube)
    ) {
      return { kind: "hum" };
    }
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
    fillerShouldPlay,
    wantsNews,
    wantsHum,
    fillerHasContent,
    humFallbackForNews,
    humFallbackForYoutube,
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

  // Persist the transcript per-user in localStorage so reloads don't wipe
  // context, and so the server's slice(-30) cap is mirrored client-side.
  const transcriptKey = `${TRANSCRIPT_KEY_PREFIX}${currentUser.id}`;
  const transcriptLoadedRef = useRef(false);
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

  const autopilotKey = `${AUTOPILOT_KEY_PREFIX}${currentUser.id}`;
  const autopilotLoadedRef = useRef(false);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(autopilotKey);
      if (raw === "1") setAutopilot(true);
    } catch {
      /* ignore */
    } finally {
      autopilotLoadedRef.current = true;
    }
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

  const toggleAutopilot = useCallback(() => {
    setAutopilot((v) => !v);
  }, []);

  const clearTranscript = useCallback(() => {
    setMessages([]);
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
    return { id: nextIdRef.current++, role, content };
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
      setTtsAudible(false);
      playNextTts();
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
    if (ttsMutedRef.current) return;
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
    if (ttsMutedRef.current) {
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
  }

  const sendMessage = useCallback(
    async (raw: string, opts?: { kickoff?: boolean }) => {
      const text = raw.trim();
      if (!opts?.kickoff && !text) return;
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
      const userMsg = opts?.kickoff ? null : newMsg("user", text);
      const assistantMsg = newMsg("assistant", "");
      setMessages((prev) =>
        userMsg ? [...prev, userMsg, assistantMsg] : [...prev, assistantMsg],
      );
      const priorHistory = userMsg
        ? [...messagesRef.current, userMsg]
        : messagesRef.current;
      try {
        let r: Response;
        try {
          r = await fetch("/api/spar", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              autopilot: autopilotRef.current,
              messages: priorHistory
                .slice(-MAX_TRANSCRIPT)
                .map((m) => ({ role: m.role, content: m.content })),
            }),
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, content: `[network: ${detail.slice(0, 160)}]` }
                : m,
            ),
          );
          return;
        }
        if (!r.ok || !r.body) {
          const errText = await r.text().catch(() => "spar failed");
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, content: `[error: ${errText.slice(0, 200)}]` }
                : m,
            ),
          );
          return;
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let accumulated = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            accumulated += decoder.decode(value, { stream: true });
            const soFar = accumulated;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id ? { ...m, content: soFar } : m,
              ),
            );
            flushSpokenText(soFar, false);
          }
          accumulated += decoder.decode();
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          accumulated += `\n[stream dropped: ${detail.slice(0, 160)}]`;
        }
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsg.id ? { ...m, content: accumulated } : m,
          ),
        );
        flushSpokenText(accumulated, true);
        // Fire-and-forget: feed the turn into the learning pipeline so
        // the user-profile store on the server gets updated. Skipped
        // for kickoff (no user turn yet) and for network/stream error
        // replies (we'd be teaching the extractor to store error
        // strings, which is noise). Never awaited — the POST returns
        // 202 immediately and extraction runs in the background.
        const replyForLearn = accumulated.replace(/​/g, "").trim();
        const looksLikeError =
          replyForLearn.startsWith("[error:") ||
          replyForLearn.startsWith("[network:") ||
          replyForLearn.startsWith("[stream dropped:");
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
      }
    },
    [playMessageSentChime],
  );

  // Auto-report: when a previously-sent dispatch just picked up a
  // completedAt, nudge spar to summarize it aloud. Tracks which ids
  // we've already reacted to so a dispatch is only reported once; only
  // fires while in-call and spar isn't mid-reply so we don't talk over
  // the user or ourselves.
  const reportedCompletionsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!inCall) return;
    if (busyRef.current) return;
    if (!ttsIdleRef.current) return;
    const pending = dispatches
      .filter(
        (d) =>
          d.status === "sent" &&
          d.completedAt != null &&
          Date.now() - d.completedAt < 5 * 60_000 &&
          !reportedCompletionsRef.current.has(d.id),
      )
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
    const next = pending[0];
    if (!next) return;
    reportedCompletionsRef.current.add(next.id);
    void sendMessage(
      `The task on ${next.projectId} just finished — check its recent output and give me a brief summary of what it did.`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatches, inCall, busy, ttsIdle]);

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
      // Telegram takes priority: even after rec.stop() the browser may
      // deliver one more buffered final result, and we must NOT route
      // that into sendMessage — the phone owns the conversation.
      const blocked =
        busyRef.current ||
        !ttsIdleRef.current ||
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
          !telegramActiveRef.current
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
      recognitionRef.current = rec as unknown as { stop: () => void };
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
      return next;
    });
  }, []);

  const toggleTtsMute = useCallback(() => {
    setTtsMuted((v) => !v);
  }, []);

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
        !telegramActiveRef.current
      ) {
        startRecognition();
      }
    }, 400);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inCall, busy, listening, ttsIdle, micMuted, voice.channel]);

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
  const effectiveTtsIdle = ttsIdle && !telegramSpeaking;
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
      startCall,
      endCall,
      toggleMicMute,
      toggleTtsMute,
      toggleAutopilot,
      sendMessage,
      saveHeartbeat,
      loadHeartbeatFor,
      clearTranscript,
    }),
    [
      currentUser,
      canManageOthers,
      messages,
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
      startCall,
      endCall,
      toggleMicMute,
      toggleTtsMute,
      toggleAutopilot,
      sendMessage,
      saveHeartbeat,
      loadHeartbeatFor,
      clearTranscript,
    ],
  );

  return (
    <SparContext.Provider value={value}>
      {children}
      <audio ref={audioElRef} preload="auto" className="hidden" />
    </SparContext.Provider>
  );
}
