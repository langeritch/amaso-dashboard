# Telegram voice calling — feasibility research

_Researched 2026-04-23. Summary: **feasible today** with the
`pytgcalls` 2.2.12 / `ntgcalls` 2.x stack. Everything else on the
public web — including blog posts, LLM answers, and the oft-quoted
"private calls are in a dev branch" line from MarshalX/tgcalls — is
stale._

## What the user asked for

A Python service that logs into Telegram as **a real user account**
(`+31 6 18 24 30 12`, not a bot — bots cannot make or receive voice
calls), places/receives 1-on-1 voice calls with Santi
(`+31 6 48 93 58 07`), pipes Kokoro TTS frames outbound, runs inbound
audio through Whisper, and exposes an HTTP API the dashboard can call.

## Library landscape (April 2026)

| Library | 1-on-1 private calls? | Group voice chats? | Status | Notes |
| --- | --- | --- | --- | --- |
| **`py-tgcalls` (pytgcalls)** 2.2.12 | **Yes** | Yes | ✅ Maintained — last release 2026-04-21 | Thin Python wrapper around `ntgcalls`. Works with Pyrogram, Telethon, and Hydrogram as the MTProto client. |
| **`ntgcalls`** 2.1.0 | **Yes** | Yes | ✅ Maintained — 2026-02-05 | Native C++ library the Python wrapper binds to. README: "Call flexibility: Group and private call support." |
| `MarshalX/tgcalls` | Partial (dev branch only) | Yes | ❌ Stale — last release 2021-08-22 | The source of the "already there and working, but not in release" line that's still quoted in many LLM answers. Superseded. |
| `pytgvoip` (bakatrouble) | Yes (originally) | No | ❌ **Archived 2025-02-15** | Dead. Last substantive work in 2020. |
| `pytgvoip` (gabomdq) | Experimental | No | ❌ Abandoned | Never shipped stable. |
| `Telethon-calls` (LonamiWebs) | Prototype | No | ❌ Abandoned | Predates ntgcalls. |
| TDLib with Python bindings | Yes (in principle) | Yes | ⚠️ Usable but heavy | You run TDLib in a subprocess and drive it via JSON. Handling audio still requires bridging to libtgvoip yourself — effectively reimplementing what ntgcalls already does. Not worth it. |
| MadelineProto (PHP) | Yes | Yes | ⚠️ PHP-only | Battle-tested but wrong language for this service. |

## Proof that pytgcalls 2.x does real 1-on-1 calls

The `p2p_example/example_p2p.py` file in the upstream repo uses exactly
the API shape we need:

```python
from pyrogram import Client, filters
from pytgcalls import PyTgCalls, filters as fl
from pytgcalls.types import ChatUpdate

app = Client('py-tgcalls', api_id=..., api_hash='...')
call_py = PyTgCalls(app)

# Outgoing: play() against a user chat_id starts a private call.
await call_py.play(chat_id, stream)

# Hangup:
await call_py.leave_call(chat_id)

# Incoming ring:
@call_py.on_update(fl.chat_update(ChatUpdate.Status.INCOMING_CALL))
async def incoming(_, update):
    await call_py.play(update.chat_id, stream)
```

And `whisper_transcription/example_transcription.py` shows the exact
inbound-audio pattern we need for STT — raw PCM frames delivered via an
event, ready to feed faster-whisper:

```python
from pytgcalls.types import AudioQuality, Device, Direction, RecordStream, StreamFrames

call_py.record(chat_id, RecordStream(True, AudioQuality.HIGH))

@call_py.on_update(filters.stream_frame(Direction.INCOMING, Device.MICROPHONE))
async def audio_data(_, update: StreamFrames):
    stt = model.transcribe(update.frames[0].frame)
```

## Decision

**Stack:**
- **Python 3.12** (pytgcalls wheels ship for 3.9–3.13; 3.12 is the
  most widely-tested combination with faster-whisper on Windows).
- **Pyrogram 2.x** as the MTProto client (Telethon also works, but
  Pyrogram's session file is portable and its TL object model is a
  better match for the examples).
- **`py-tgcalls` 2.2.12** for the VoIP layer.
- **`faster-whisper`** with `ctranslate2` (GPU-if-available, CPU
  fallback) for STT. Same model the upstream example uses.
- **FastAPI + uvicorn** for the HTTP surface. FastAPI's WebSocket
  support means we can stream transcriptions back to the dashboard
  over a single connection without separate SSE plumbing.
- **Kokoro ONNX** — reuse the existing install at
  `C:\Users\santi\tools\tts` rather than building a second copy.

**Posture:**
- The Python service runs as a standalone process. The dashboard
  Node server shells out or curls it, but never imports it.
- One-time phone verification is an interactive CLI script
  (`login.py`) that drops an encrypted Pyrogram session file next
  to the service. Subsequent runs load the session silently.
- The session file is the credential. It is gitignored, kept in the
  user data dir, and should be `chmod 600`-equivalent on Windows
  (ACL to the current user only).

## Known pitfalls

1. **The first Kokoro PCM write after call start can be lost.** The
   ntgcalls frame ring buffer has a ~200 ms pre-roll; we push 200 ms
   of silence at the top of every `/speak` call.
2. **Pyrogram's API_ID / API_HASH are per-developer, not per-user.**
   Get them once at <https://my.telegram.org/apps> and put them in
   `.env`. Do **not** commit them.
3. **VoIP on Windows needs the MSVC 2022 runtime.** ntgcalls wheels
   for win_amd64 link against it. Not usually a problem — most dev
   machines already have it — but call it out in the README so a
   fresh-laptop setup doesn't mystery-fail on `import pytgcalls`.
4. **Private calls use Telegram's end-to-end encrypted DH flow.**
   There is a ~1–2 s handshake between `play()` and audio flowing.
   The "call connected" feedback chime should fire on the
   `ChatUpdate.Status.CONNECTED` event, not on the `play()` return.
5. **Concurrent calls are not a feature.** The service holds one
   active call at a time; a second `/call` while one is live returns
   409. Good enough for the assistant-dialing-you use case.
6. **Telegram rate limits.** More than a few outbound call attempts
   per minute trips antispam. The service's `/call` endpoint
   exponential-backs off on `FloodWait` and surfaces the wait
   duration in the status JSON.

## Fallbacks if this stack ever breaks

- **Short-term:** pin `py-tgcalls==2.2.12` and `ntgcalls==2.1.0` in
  `requirements.txt` so an upstream breaking change doesn't silently
  flip us onto a version that drops private calls.
- **Medium-term:** the assistant joins a 2-person "group voice chat"
  in a private group with Santi. That's the feature pytgcalls has
  always supported regardless of library churn, and the UX
  difference is small (you tap Join instead of Answer).
- **Long-term:** run MadelineProto in a PHP subprocess for the
  MTProto + VoIP parts and keep the Python service as the HTTP
  front-door. Heavier but MadelineProto has never stopped working.

## Sources

- [py-tgcalls on PyPI](https://pypi.org/project/py-tgcalls/)
- [pytgcalls on GitHub](https://github.com/pytgcalls/pytgcalls)
- [pytgcalls p2p_example](https://github.com/pytgcalls/pytgcalls/tree/master/example/p2p_example)
- [pytgcalls whisper_transcription example](https://github.com/pytgcalls/pytgcalls/tree/master/example/whisper_transcription)
- [ntgcalls on GitHub](https://github.com/pytgcalls/ntgcalls)
- [MarshalX/tgcalls (superseded)](https://github.com/MarshalX/tgcalls)
- [bakatrouble/pytgvoip — archived](https://github.com/bakatrouble/pytgvoip)
