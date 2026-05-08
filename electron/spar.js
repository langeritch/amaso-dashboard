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
const body = document.body;

const MAX_MESSAGES = 20;
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_MS = 250;
const CHUNK_SAMPLES = (TARGET_SAMPLE_RATE * CHUNK_MS) / 1000; // 4000

let mode = "chat";
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

composer.addEventListener("submit", (e) => {
  e.preventDefault();
  const t = textInput.value.trim();
  if (!t) return;
  appendMessage("user", t);
  window.spar.send({ type: "spar.text", text: t }).catch(() => {});
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
        window.spar.send({ type: "spar.audio.chunk", data: b64 }).catch(() => {});
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
    window.spar.send({ type: "spar.audio.start" }).catch(() => {});
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
  window.spar.send({ type: "spar.audio.stop" }).catch(() => {});
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
    default:
      break;
  }
});

window.spar.onFocusChange((focused) => {
  body.classList.toggle("unfocused", !focused);
});
