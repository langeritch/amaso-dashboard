// Renderer for the Sparring Partner window. Owns:
//   - chat thread + composer
//   - voice mode orb + push-to-talk
//   - mic capture (16 kHz mono Int16 PCM, base64 chunks every ~250 ms)
//   - audio playback queue with gapless scheduling
//   - dispatch of incoming spar.* messages from the main process
//
// All WebSocket I/O is brokered by the main process via window.spar.*
// (see spar-preload.js). The renderer never touches the socket
// directly so the existing companion-ws cookie auth and CSWSH guard
// stay intact.

const messagesEl = document.getElementById("messages");
const composer = document.getElementById("composer");
const textInput = document.getElementById("text");
const micBtn = document.getElementById("micBtn");
const modeBtn = document.getElementById("modeBtn");
const orbCanvas = document.getElementById("orbCanvas");
const convPill = document.getElementById("convPill");
const convLabel = document.getElementById("convLabel");
const convMenu = document.getElementById("convMenu");
const body = document.body;

const MAX_MESSAGES = 20;
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_MS = 250;
const CHUNK_SAMPLES = (TARGET_SAMPLE_RATE * CHUNK_MS) / 1000; // 4000

let mode = "chat";

// Conversation state. activeConversationId is included on every
// outbound spar.text and spar.audio.* message so the dashboard can
// route each chunk to the right thread when the user has multiple
// conversations open. conversations is the picker list, refreshed
// from spar.conversations whenever the dashboard pushes one.
let activeConversationId = null;
let conversations = [];
let micActive = false;
let micStream = null;
let micCtx = null;
let micProc = null;
let micSource = null;
let micAccum = [];
let micAccumLen = 0;

let playbackCtx = null;
let playbackHead = 0;

let streamingDiv = null;

// ---- Mode toggle ---------------------------------------------------------

function setMode(next) {
  if (next !== "chat" && next !== "voice") return;
  if (next === mode) return;
  mode = next;
  body.classList.toggle("mode-chat", next === "chat");
  body.classList.toggle("mode-voice", next === "voice");
  // Tell main to resize the window. The renderer does the content
  // swap immediately; the OS-animated resize lands a beat later and
  // the layout is already correct under it.
  window.spar.setMode(next).catch(() => {});
}

modeBtn.addEventListener("click", () => {
  setMode(mode === "chat" ? "voice" : "chat");
});

// ---- Chat thread ---------------------------------------------------------

function appendMessage(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  messagesEl.append(div);
  while (messagesEl.children.length > MAX_MESSAGES) {
    messagesEl.firstChild.remove();
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

// Streamed assistant response: append tokens to the same bubble
// until `final` arrives, then close the bubble out so the next
// response starts a fresh one.
function appendStream(text, final) {
  if (!streamingDiv) streamingDiv = appendMessage("assistant", "");
  streamingDiv.textContent += text;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  if (final) streamingDiv = null;
}

// Decorate an outbound message with the active conversationId,
// when one exists. Server defaults if missing, so a click before
// the first spar.conversations push still works.
function withConversation(msg) {
  if (!activeConversationId) return msg;
  return { ...msg, conversationId: activeConversationId };
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const t = textInput.value.trim();
  if (!t) return;
  appendMessage("user", t);
  window.spar.send(withConversation({ type: "spar.text", text: t })).catch(() => {});
  textInput.value = "";
});

// ---- Mic capture ---------------------------------------------------------
//
// getUserMedia → AudioContext at 16 kHz → ScriptProcessorNode that
// accumulates 250 ms windows, converts Float32 → Int16 little-endian
// PCM, base64s, ships via spar.audio.chunk.

async function startMic() {
  if (micActive) return;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: TARGET_SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    // The browser may ignore the requested sampleRate; ask the
    // AudioContext for it explicitly and downsample on the fly if
    // it ends up at the system default (typically 48 kHz).
    micCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: TARGET_SAMPLE_RATE,
    });
    micSource = micCtx.createMediaStreamSource(micStream);
    micProc = micCtx.createScriptProcessor(4096, 1, 1);
    micAccum = [];
    micAccumLen = 0;

    micProc.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      const ratio = micCtx.sampleRate / TARGET_SAMPLE_RATE;
      const ds = downsample(input, ratio);
      micAccum.push(ds);
      micAccumLen += ds.length;
      while (micAccumLen >= CHUNK_SAMPLES) {
        const merged = mergeFloat32(micAccum, micAccumLen);
        const head = merged.subarray(0, CHUNK_SAMPLES);
        const tail = merged.subarray(CHUNK_SAMPLES);
        micAccum = tail.length > 0 ? [tail] : [];
        micAccumLen = tail.length;
        const i16 = floatToInt16(head);
        const b64 = bufferToBase64(i16.buffer);
        window.spar.send(withConversation({ type: "spar.audio.chunk", data: b64 })).catch(() => {});
      }
    };

    micSource.connect(micProc);
    // ScriptProcessorNode does not fire onaudioprocess unless its
    // output is connected to something. Routing to destination is
    // the standard idiom; it would echo the mic to speakers, but
    // we're not actually feeding any output, so it stays silent.
    micProc.connect(micCtx.destination);

    micActive = true;
    micBtn.classList.add("active");
    setOrbState("listening");
    window.spar.send(withConversation({ type: "spar.audio.start" })).catch(() => {});
  } catch (err) {
    console.warn("[spar] mic start failed:", (err && err.message) || err);
    micActive = false;
    micBtn.classList.remove("active");
    setOrbState("idle");
  }
}

function stopMic() {
  if (!micActive) return;
  try { micProc && micProc.disconnect(); } catch {}
  try { micSource && micSource.disconnect(); } catch {}
  try { micStream && micStream.getTracks().forEach((t) => t.stop()); } catch {}
  try { micCtx && micCtx.close(); } catch {}
  micProc = null;
  micSource = null;
  micStream = null;
  micCtx = null;
  micAccum = [];
  micAccumLen = 0;
  micActive = false;
  micBtn.classList.remove("active");
  window.spar.send(withConversation({ type: "spar.audio.stop" })).catch(() => {});
  setOrbState("idle");
}

function toggleMic() {
  if (micActive) stopMic();
  else startMic();
}

micBtn.addEventListener("click", toggleMic);
orbCanvas.addEventListener("click", toggleMic);
orbCanvas.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleMic();
  }
});

function downsample(input, ratio) {
  if (Math.abs(ratio - 1) < 0.01) return input;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    out[i] = input[Math.floor(i * ratio)];
  }
  return out;
}

function mergeFloat32(chunks, total) {
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function floatToInt16(buf) {
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i += 1) {
    const s = Math.max(-1, Math.min(1, buf[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function bufferToBase64(ab) {
  const bytes = new Uint8Array(ab);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// ---- Audio playback ------------------------------------------------------
//
// Each spar.audio.response carries a base64-encoded encoded-audio
// blob (MP3/Opus/AAC/whatever the dashboard's TTS emits). We decode
// each chunk to an AudioBuffer and schedule it at the previous
// chunk's end time so chunks queue gaplessly.

// Holds the AnalyserNode the visualizer reads from. Same ref-object
// pattern the dashboard component uses, so the draw loop sees the
// latest analyser without restarting when one is created lazily on
// the first audio chunk.
const analyserRef = { current: null };

function ensurePlaybackCtx() {
  if (!playbackCtx) {
    playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
    playbackHead = 0;
    // Build the analyser once per AudioContext and route every
    // playback source through it: source -> analyser -> destination.
    // fftSize 256 gives 128 frequency bins, which is exactly what
    // the dashboard visualizer reads (data = new Uint8Array(128)).
    const an = playbackCtx.createAnalyser();
    an.fftSize = 256;
    an.smoothingTimeConstant = 0.7;
    an.connect(playbackCtx.destination);
    analyserRef.current = an;
  }
  return playbackCtx;
}

async function enqueueAudio(b64) {
  const ctx = ensurePlaybackCtx();
  let buf;
  try {
    const ab = base64ToArrayBuffer(b64);
    buf = await ctx.decodeAudioData(ab);
  } catch (err) {
    console.warn("[spar] decode failed:", (err && err.message) || err);
    return;
  }
  const startAt = Math.max(ctx.currentTime, playbackHead);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // Route through the shared analyser so the visualizer reacts to
  // the assistant's TTS. analyserRef.current is guaranteed to be
  // non-null after ensurePlaybackCtx().
  src.connect(analyserRef.current);
  src.start(startAt);
  playbackHead = startAt + buf.duration;
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// ---- Orb state + canvas visualizer --------------------------------------
//
// 96-bar radial canvas, ported verbatim from the dashboard's
// SparAudioVisualizer.tsx. The draw loop reads the latest flags
// from flagsRef on every frame, so state transitions take effect
// without restarting the loop, and reads the analyser node from
// analyserRef so a lazily-created playback analyser slots in
// transparently. Bar colors and shadow rules match the dashboard
// 1:1, which is the whole point of the port.

const flagsRef = {
  current: {
    inCall: false,
    listening: false,
    speaking: false,
    thinking: false,
    autopilot: false,
  },
};

function setOrbState(state) {
  if (state !== "idle" && state !== "listening" && state !== "thinking" && state !== "speaking") {
    return;
  }
  // The dashboard's visualizer treats inCall as the master "voice
  // session active" flag and gates the others off it. The companion
  // is always in a voice session whenever the orb is on screen, so
  // we keep inCall true and toggle the per-state flags off it.
  flagsRef.current = {
    inCall: true,
    listening: state === "listening",
    speaking: state === "speaking",
    thinking: state === "thinking",
    autopilot: false,
  };
}

function startOrbVisualizer() {
  const canvas = orbCanvas;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const NUM_BARS = 96;
  const TWO_PI = Math.PI * 2;

  const heights = new Float32Array(NUM_BARS);
  const data = new Uint8Array(128);

  let lastW = 0;
  let lastH = 0;
  const dpr = window.devicePixelRatio || 1;
  let idleSeed = 0;

  const draw = () => {
    requestAnimationFrame(draw);
    const f = flagsRef.current;

    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width));
    const H = Math.max(1, Math.round(rect.height));
    if (W !== lastW || H !== lastH) {
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lastW = W;
      lastH = H;
    }
    // Wipe + force the context back to a known pristine state every
    // frame; mirrors the dashboard's belt-and-braces reset so a
    // future tweak that leaves a shadow / gradient / composite mode
    // hanging can't bleed into the next frame.
    ctx.clearRect(0, 0, W, H);
    ctx.shadowBlur = 0;
    ctx.shadowColor = "rgba(0,0,0,0)";
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.filter = "none";

    const CENTER_X = W / 2;
    const CENTER_Y = H / 2;
    const SHORT = Math.min(W, H);
    const INNER_R = SHORT * 0.28;
    const BASE_BAR = 2;
    const MAX_BAR = SHORT * 0.48 - INNER_R;

    const analyser = analyserRef.current;
    const haveAudio = analyser != null && f.speaking;
    if (haveAudio) {
      analyser.getByteFrequencyData(data);
    }

    idleSeed += 1;

    if (f.autopilot) {
      let audioEnergy = 0;
      if (haveAudio) {
        let sum = 0;
        const lim = Math.min(32, data.length);
        for (let k = 0; k < lim; k += 1) sum += data[k];
        audioEnergy = Math.min(1, sum / (lim * 180));
      }
      const breath = 0.5 + 0.5 * Math.sin(idleSeed * 0.055);
      const shadowBlur = 8 + 10 * breath + 16 * audioEnergy;
      const shadowAlpha = Math.min(
        0.9,
        0.4 + 0.2 * breath + 0.3 * audioEnergy,
      );
      ctx.shadowBlur = shadowBlur;
      ctx.shadowColor = `rgba(74,222,128,${shadowAlpha})`;
    } else {
      ctx.shadowBlur = 0;
      ctx.shadowColor = "rgba(0,0,0,0)";
    }

    for (let i = 0; i < NUM_BARS; i += 1) {
      const half = NUM_BARS / 2;
      const mirror = i < half ? i : NUM_BARS - 1 - i;
      const binIdx = Math.min(
        data.length - 1,
        2 + Math.floor((mirror / half) * (data.length * 0.55)),
      );
      let target;
      if (haveAudio) {
        target = Math.min(1.25, Math.pow(data[binIdx] / 200, 0.75));
      } else if (f.thinking) {
        target = 0.12 + 0.08 * Math.sin(idleSeed * 0.06 + i * 0.12);
      } else if (f.listening) {
        target = 0.06 + 0.04 * Math.sin(idleSeed * 0.1 + i * 0.3);
      } else if (f.inCall) {
        target = 0.04 + 0.02 * Math.sin(idleSeed * 0.04 + i * 0.2);
      } else {
        target = 0.02;
      }
      const cur = heights[i];
      const k = target > cur ? 0.62 : 0.14;
      heights[i] = cur + (target - cur) * k;

      const mag = heights[i];
      const len = BASE_BAR + mag * MAX_BAR;
      const angle = (i / NUM_BARS) * TWO_PI - Math.PI / 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const x1 = CENTER_X + cos * INNER_R;
      const y1 = CENTER_Y + sin * INNER_R;
      const x2 = CENTER_X + cos * (INNER_R + len);
      const y2 = CENTER_Y + sin * (INNER_R + len);

      let r;
      let g;
      let b;
      if (f.speaking) {
        r = 52; g = 211; b = 153;
      } else if (f.thinking) {
        r = 251; g = 191; b = 36;
      } else if (f.listening) {
        r = 248; g = 113; b = 113;
      } else {
        r = 16; g = 185; b = 129;
      }
      const alpha = 0.3 + Math.min(1, mag) * 0.65;

      ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
      ctx.lineWidth = 2 + Math.min(1, mag) * 1.6;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
    ctx.shadowColor = "rgba(0,0,0,0)";
  };
  requestAnimationFrame(draw);
}

// Seed flags so the canvas paints a soft inCall pulse from the
// first frame, then start the loop immediately. The loop runs for
// the lifetime of the renderer; CSS handles hide/show via the
// voice-pane display rule.
setOrbState("idle");
startOrbVisualizer();

// ---- Conversation picker -------------------------------------------------
//
// The pill in the title strip shows the active conversation's label;
// clicking it opens a dropdown of every conversation the dashboard
// has surfaced, plus a "New conversation" entry. The dropdown closes
// on outside click or after any selection.

function activeConversation() {
  return conversations.find((c) => c && c.id === activeConversationId) || null;
}

// Dashboard sends `title`; older builds may have used `label`. Read
// title first, fall back to label, then "Untitled" so a row that
// somehow ships without either still renders.
function conversationTitle(c) {
  if (!c) return "";
  if (typeof c.title === "string" && c.title) return c.title;
  if (typeof c.label === "string" && c.label) return c.label;
  return "";
}

// Dashboard sends `lastMessageAt`; older builds may have used
// `updatedAt`. Same dual-read pattern.
function conversationTimestamp(c) {
  if (!c) return "";
  if (typeof c.lastMessageAt === "string" && c.lastMessageAt) return c.lastMessageAt;
  if (typeof c.updatedAt === "string" && c.updatedAt) return c.updatedAt;
  return "";
}

function renderConvLabel() {
  const active = activeConversation();
  const title = conversationTitle(active);
  convLabel.textContent = title
    ? title
    : conversations.length === 0
      ? "Sparring"
      : "Untitled";
}

// Format an ISO timestamp as a compact relative label. Same calendar
// day = "today", previous day = "yesterday", within the past week =
// short weekday ("Mon"), older = locale month + day ("May 6").
function relativeTime(iso) {
  if (typeof iso !== "string" || !iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const now = new Date();
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(then, now)) return "today";
  if (sameDay(then, yesterday)) return "yesterday";
  const ageDays = Math.floor((now.getTime() - then.getTime()) / (1000 * 60 * 60 * 24));
  if (ageDays >= 0 && ageDays < 7) {
    return then.toLocaleDateString(undefined, { weekday: "short" });
  }
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderConvMenu() {
  convMenu.replaceChildren();
  for (const c of conversations) {
    if (!c || typeof c.id !== "string") continue;
    const item = document.createElement("div");
    item.className = "conv-item" + (c.id === activeConversationId ? " active" : "");
    item.setAttribute("role", "menuitem");

    const name = document.createElement("div");
    name.className = "conv-name";
    name.textContent = conversationTitle(c) || "Untitled";

    const meta = document.createElement("div");
    meta.className = "conv-meta";
    const ts = relativeTime(conversationTimestamp(c));
    const last = typeof c.lastMessage === "string" ? c.lastMessage : "";
    meta.textContent = ts && last ? `${ts} · ${last}` : ts || last;

    item.append(name, meta);
    item.addEventListener("click", () => {
      closeConvMenu();
      if (c.id === activeConversationId) return;
      // Optimistic switch so subsequent outbound messages tag the
      // new conversation. Dashboard has no dedicated switch message;
      // re-issuing spar.history.request with the new id is how we
      // pull the thread for the picked conversation. Clear the
      // existing thread first so the previous conversation's tail
      // doesn't bleed underneath the new one.
      activeConversationId = c.id;
      renderConvLabel();
      messagesEl.replaceChildren();
      streamingDiv = null;
      window.spar
        .send({ type: "spar.history.request", conversationId: c.id })
        .catch(() => {});
    });
    convMenu.append(item);
  }

  if (conversations.length > 0) {
    const sep = document.createElement("div");
    sep.className = "conv-divider";
    convMenu.append(sep);
  }
  const newItem = document.createElement("div");
  newItem.className = "conv-new";
  newItem.setAttribute("role", "menuitem");
  newItem.textContent = "+ New conversation";
  newItem.addEventListener("click", () => {
    closeConvMenu();
    // Dashboard has no dedicated "new" message: a fresh
    // conversation materializes server-side the first time the
    // companion sends spar.text without a conversationId. Clear
    // local state so subsequent outbound messages omit the id and
    // the user sees an empty thread immediately.
    activeConversationId = null;
    renderConvLabel();
    messagesEl.replaceChildren();
    streamingDiv = null;
  });
  convMenu.append(newItem);
}

function openConvMenu() {
  renderConvMenu();
  convMenu.classList.add("open");
  convPill.setAttribute("aria-expanded", "true");
}
function closeConvMenu() {
  convMenu.classList.remove("open");
  convPill.setAttribute("aria-expanded", "false");
}

convPill.addEventListener("click", (e) => {
  e.stopPropagation();
  if (convMenu.classList.contains("open")) closeConvMenu();
  else openConvMenu();
});
// Outside click closes the menu. Keying off mousedown rather than
// click lets the close fire before any other component swallows the
// click; safer when the dropdown is layered over scrollable content.
document.addEventListener("mousedown", (e) => {
  if (!convMenu.classList.contains("open")) return;
  const target = e.target;
  if (convMenu.contains(target) || convPill.contains(target)) return;
  closeConvMenu();
});

// ---- History rendering ---------------------------------------------------
//
// A spar.history payload replaces the in-memory thread wholesale.
// We trim to the same 20-message cap the live thread uses so a long
// history doesn't balloon the DOM; the dashboard remains the source
// of truth for older messages.

function loadHistory(messages) {
  messagesEl.replaceChildren();
  streamingDiv = null;
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    if (typeof m.text !== "string") continue;
    const div = document.createElement("div");
    div.className = "msg " + m.role;
    div.textContent = m.text;
    messagesEl.append(div);
  }
  while (messagesEl.children.length > MAX_MESSAGES) {
    messagesEl.firstChild.remove();
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function requestConversationState() {
  window.spar.send({ type: "spar.conversations.list" }).catch(() => {});
  // Omit conversationId so the dashboard returns the latest
  // conversation's history (or an empty payload pinned to id "0"
  // if the user has none yet). The history.response that comes
  // back carries the canonical conversationId we treat as active.
  window.spar.send({ type: "spar.history.request" }).catch(() => {});
}

// ---- Inbound dashboard messages -----------------------------------------

window.spar.onMessage((msg) => {
  if (!msg || typeof msg.type !== "string") return;
  switch (msg.type) {
    case "spar.state":
      if (typeof msg.state === "string") setOrbState(msg.state);
      break;
    case "spar.text.response":
      if (typeof msg.text === "string") appendStream(msg.text, !!msg.final);
      break;
    case "spar.transcript":
      if (typeof msg.text === "string") appendMessage("user", msg.text);
      break;
    case "spar.audio.response":
      if (typeof msg.data === "string") enqueueAudio(msg.data);
      break;
    case "spar.audio.response.end":
      // Nothing to do: the queue self-completes once the last
      // scheduled buffer finishes. Reset the head so a fresh
      // response after silence starts immediately rather than
      // chasing a stale playbackHead.
      playbackHead = playbackCtx ? playbackCtx.currentTime : 0;
      break;
    case "spar.history.response":
      loadHistory(msg.messages);
      if (typeof msg.conversationId === "string" && msg.conversationId !== "0") {
        // The dashboard pins the empty-state response to id "0";
        // ignore that so the renderer's activeConversationId stays
        // null and the next outbound text creates a real one.
        activeConversationId = msg.conversationId;
        renderConvLabel();
      }
      break;
    case "spar.conversations.response":
      if (Array.isArray(msg.conversations)) {
        conversations = msg.conversations;
        // No activeId is sent; if our local pointer no longer
        // exists in the list (e.g. the conversation was deleted
        // out from under us), drop it so the next history request
        // falls back to the latest conversation.
        if (
          activeConversationId &&
          !conversations.some((c) => c && c.id === activeConversationId)
        ) {
          activeConversationId = null;
        }
        renderConvLabel();
      }
      break;
    default:
      break;
  }
});

window.spar.onFocusChange((focused) => {
  body.classList.toggle("unfocused", !focused);
  // Clicks in another app don't dispatch a mousedown to this
  // renderer, so the in-document outside-click handler can't see
  // them. Hooking the OS-level blur is the only reliable way to
  // close the menu when the user goes back to whatever they were
  // doing.
  if (!focused) closeConvMenu();
});

// Fetch state on first load and again every time the window
// becomes visible. Server-side handlers are idempotent so the
// (rare) duplicate on first show after a hide is harmless.
requestConversationState();
window.spar.onVisible(() => {
  requestConversationState();
});
