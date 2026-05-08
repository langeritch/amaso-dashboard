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
const orb = document.getElementById("orb");
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
orb.addEventListener("click", toggleMic);
orb.addEventListener("keydown", (e) => {
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

function ensurePlaybackCtx() {
  if (!playbackCtx) {
    playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
    playbackHead = 0;
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
  src.connect(ctx.destination);
  src.start(startAt);
  playbackHead = startAt + buf.duration;
}

function base64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

// ---- Orb state ----------------------------------------------------------

function setOrbState(state) {
  if (state !== "idle" && state !== "listening" && state !== "thinking" && state !== "speaking") {
    return;
  }
  orb.dataset.state = state;
}

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
