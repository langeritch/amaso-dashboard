"""
Telegram voice-call service — audio relay for the dashboard session.

This process does NOT own a conversation. It signs in as the assistant
userbot, shuttles audio between Telegram and the dashboard, and
exposes a thin HTTP/WS surface for the dashboard to drive it.

Every caller utterance is transcribed locally (Whisper), POSTed to
the dashboard's /api/telegram/respond, and the reply text that comes
back is synthesised (Kokoro) and played into the call. The dashboard
owns the one true conversation — same session, same memory, same
model as the Spar browser UI. Telegram is "speakerphone swapped for
the phone", not a separate brain.

If the dashboard is unreachable we apologise briefly into the call
and stay listening. We never, ever fabricate a reply out-of-band:
the whole point of the relay model is that the user sees the same
transcript on the dashboard that they hear on the phone.

    POST   /call       { "user_id"?: int, "phone"?: "+31..." }
    POST   /speak      { "text": "...", "voice"?: "...", "speed"?: 1.0 }
    POST   /hangup
    GET    /status
    WS     /ws/transcript        live utterances as JSON frames
    WS     /ws/status             live state changes

All routes except /status require `X-Auth: <SERVICE_TOKEN>`. That's
the only thing between the dashboard and Santi's phone ringing.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from pyrogram import Client
from pytgcalls import PyTgCalls, filters as tgfilters
from pytgcalls.types import (
    AudioQuality,
    ChatUpdate,
    Device,
    Direction,
    MediaStream,
    RecordStream,
    StreamFrames,
)

import httpx

import kokoro_bridge
from filler_manager import FillerManager
from stt_bridge import Utterance, WhisperSTT


HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("telegram-voice")


# ---- State --------------------------------------------------------------

CallState = Literal["idle", "dialing", "ringing", "connected", "hanging_up"]
CallMode = Literal["inbound", "outbound"]
CallSubstate = Literal["listening", "transcribing", "thinking", "speaking"]


@dataclass
class Turn:
    role: Literal["caller", "assistant"]
    text: str
    at: float


@dataclass
class CallStatus:
    state: CallState = "idle"
    mode: CallMode | None = None
    substate: CallSubstate | None = None
    peer_user_id: int | None = None
    peer_phone: str | None = None
    peer_name: str | None = None
    peer_username: str | None = None
    started_at: float | None = None
    connected_at: float | None = None
    # Preserved across the idle transition so the dashboard can keep
    # showing the last call's transcript as a "call history" entry.
    last_ended_at: float | None = None
    # Display-only echo of the conversation so /status and /ws/transcript
    # subscribers can render the call in real time. NOT a source of
    # truth for the assistant — the dashboard's voice-session store
    # owns history. Turns in here may be trimmed or reset per call
    # without affecting what the dashboard remembers.
    turns: list[Turn] = field(default_factory=list)
    # When the dashboard tells us we took over an existing session
    # (Spar, chat, etc.), stash the previous channel so the UI can
    # render a "continued from Spar" chip. None on a fresh session.
    dashboard_session_id: str | None = None
    took_over_from: str | None = None
    last_error: str | None = None
    last_event: str | None = None


@dataclass
class Service:
    pyrogram: Client
    calls: PyTgCalls
    stt: WhisperSTT
    status: CallStatus = field(default_factory=CallStatus)
    transcript_subs: set[asyncio.Queue[dict[str, Any]]] = field(default_factory=set)
    status_subs: set[asyncio.Queue[dict[str, Any]]] = field(default_factory=set)
    # Queue of caller utterances waiting for the conversation worker to
    # process. Frame handler pushes; worker pops. Bounded to avoid
    # unbounded growth if the LLM jams.
    utterance_queue: asyncio.Queue[Utterance] = field(
        default_factory=lambda: asyncio.Queue(maxsize=32)
    )
    worker_task: asyncio.Task[None] | None = None
    # Plays pre-rendered news headlines / fun facts over the call
    # while Claude is thinking, instead of a single chime loop. None
    # until startup completes.
    filler: FillerManager | None = None


_service: Service | None = None
_speak_lock = asyncio.Lock()


# ---- Models -------------------------------------------------------------

class CallBody(BaseModel):
    user_id: int | None = None
    phone: str | None = Field(default=None, description="E.164, e.g. +31648935807")


class SpeakBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    voice: str | None = None
    speed: float | None = Field(default=None, ge=0.5, le=2.0)


class ImportContactBody(BaseModel):
    phone: str
    first_name: str = "Amaso"
    last_name: str = ""


# ---- Auth ---------------------------------------------------------------

def _require_token(x_auth: str | None = Header(default=None)) -> None:
    expected = os.environ.get("SERVICE_TOKEN", "").strip()
    if not expected:
        # No token configured → service refuses to authorise anything.
        # Safer than defaulting to "open", especially while the feature
        # is new and there's no audit trail yet.
        raise HTTPException(503, "service token not configured")
    if x_auth != expected:
        raise HTTPException(401, "bad token")


# ---- App ----------------------------------------------------------------

app = FastAPI(title="amaso-telegram-voice", version="0.1.0")


@app.on_event("startup")
async def startup() -> None:
    global _service

    api_id = int(_require_env("TELEGRAM_API_ID"))
    api_hash = _require_env("TELEGRAM_API_HASH")
    session_name = os.environ.get("SESSION_NAME", "assistant").strip() or "assistant"

    if not (HERE / f"{session_name}.session").exists():
        raise RuntimeError(
            f"no session file at {HERE / (session_name + '.session')}. "
            "Run `python login.py` first."
        )

    pyro = Client(
        name=session_name,
        api_id=api_id,
        api_hash=api_hash,
        workdir=str(HERE),
        in_memory=False,
        no_updates=False,
    )
    calls = PyTgCalls(pyro)
    stt = WhisperSTT()

    _service = Service(pyrogram=pyro, calls=calls, stt=stt)
    _register_handlers(_service)

    # Pre-bake every feedback sound so the first call doesn't block the
    # VoIP thread on numpy+soundfile. Cheap; they're tens of kilobytes.
    _prewarm_feedback_sounds()

    # Warn early (not fatal) if the Kokoro sidecar isn't up. If it
    # stays down, inbound calls fall back to the apology text and
    # /speak returns 503 — but surfacing it at boot saves a confused
    # 10 minutes of "why can't the caller hear me?".
    if not kokoro_bridge.health_check():
        log.warning(
            "Kokoro sidecar health check failed at %s — TTS will fail "
            "until it comes up. Start the dashboard first.",
            kokoro_bridge._sidecar_url(),
        )

    log.info("starting Pyrogram + pytgcalls")
    await calls.start()  # starts both Pyrogram and the VoIP layer

    # Spin up the inbound-call worker. It lives for the lifetime of
    # the service and silently no-ops when no utterances are queued.
    # The worker itself has no brain — every turn is an RPC to the
    # dashboard. See _handle_turn for the single-path contract.
    _service.worker_task = asyncio.create_task(_conversation_worker(_service))

    # Kick off filler-content prerender in the background. It uses
    # Kokoro to bake news headlines and fun facts into WAV files so
    # playback during the "thinking" window has zero synth latency.
    # Non-blocking: the first post-boot call may still hit the chime
    # fallback if prerender isn't done yet.
    _service.filler = FillerManager(kokoro_bridge.synthesize)
    _service.filler.kick_off_prerender()

    log.info("audio relay running; dashboard=%s", os.environ.get("AMASO_DASHBOARD_URL", "http://127.0.0.1:3737"))


@app.on_event("shutdown")
async def shutdown() -> None:
    if _service is None:
        return
    if _service.worker_task is not None:
        _service.worker_task.cancel()
        with contextlib.suppress(Exception):
            await _service.worker_task
    with contextlib.suppress(Exception):
        if _service.status.state != "idle":
            await _service.calls.leave_call(
                _service.status.peer_user_id
                if _service.status.peer_user_id is not None
                else 0
            )
    with contextlib.suppress(Exception):
        await _service.pyrogram.stop()


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing {name} in .env")
    return value


# ---- Routes -------------------------------------------------------------

@app.get("/status")
async def get_status() -> dict[str, Any]:
    if _service is None:
        return {"state": "starting"}
    return _status_payload(_service.status)


@app.post("/call", dependencies=[Depends(_require_token)])
async def post_call(body: CallBody) -> dict[str, Any]:
    svc = _require_service()
    if svc.status.state != "idle":
        raise HTTPException(409, f"already in a call ({svc.status.state})")

    peer_id = await _resolve_peer(svc, body)
    wav = _dial_tone_path()

    # Look up the peer's display name too so the dashboard can label
    # the call even before the first utterance lands.
    try:
        peer_user = await svc.pyrogram.get_users(peer_id)
        peer_name = peer_user.first_name
        peer_username = peer_user.username
    except Exception:
        peer_name = None
        peer_username = None

    svc.status = CallStatus(
        state="dialing",
        mode="outbound",
        substate=None,
        peer_user_id=peer_id,
        peer_phone=body.phone or os.environ.get("TARGET_PHONE"),
        peer_name=peer_name,
        peer_username=peer_username,
        started_at=time.time(),
        last_event="dialing",
    )
    await _broadcast_status(svc)
    # Silence the laptop before we even start playing the dial tone —
    # otherwise the user hears both channels until the peer picks up.
    asyncio.create_task(_notify_dashboard_acquired())

    try:
        # play() against a user_id with no active group chat starts a
        # private 1-on-1 call. The WAV we feed here is the "outgoing
        # ring audio" — Telegram plays it only until the other side
        # accepts, then replaces it with our subsequent /speak calls.
        await svc.calls.play(peer_id, MediaStream(str(wav)))
    except Exception as exc:
        # Fully reset status via _end_call so peer_* and mode don't
        # stay pinned to a call that never actually started — a bare
        # `state = idle` leaves the dashboard showing a zombie peer
        # in the call-history chip.
        _end_call(svc, reason="dial_failed", error=str(exc))
        await _broadcast_status(svc)
        log.exception("call failed")
        raise HTTPException(502, f"call failed: {exc}") from exc

    # Arm the inbound-audio recorder so Whisper starts eating frames
    # as soon as the handshake completes.
    with contextlib.suppress(Exception):
        await svc.calls.record(peer_id, RecordStream(True, AudioQuality.HIGH))

    return _status_payload(svc.status)


@app.post("/speak", dependencies=[Depends(_require_token)])
async def post_speak(body: SpeakBody) -> dict[str, Any]:
    svc = _require_service()
    if svc.status.state != "connected":
        raise HTTPException(409, f"not in a connected call ({svc.status.state})")

    async with _speak_lock:
        wav_bytes, duration_s = await asyncio.to_thread(
            kokoro_bridge.synthesize, body.text, body.voice, body.speed
        )
        # pytgcalls' play() wants a file path or URL. Writing each
        # utterance to a tempfile is cheap and avoids a named-pipe
        # dance on Windows. Files are cleaned up in a background task
        # so overlapping /speak calls don't fight over a single fd.
        path = _write_temp_wav(wav_bytes)
        try:
            await svc.calls.play(svc.status.peer_user_id, MediaStream(str(path)))
        finally:
            asyncio.get_running_loop().call_later(30, _unlink_quietly, path)

    return {"ok": True, "bytes": len(wav_bytes), "duration_s": duration_s}


@app.post("/contacts/import", dependencies=[Depends(_require_token)])
async def post_import_contact(body: ImportContactBody) -> dict[str, Any]:
    """
    Add a phone number to the assistant account's contact list so we
    can resolve it to a user_id later. Telegram's server silently
    ignores numbers that aren't registered with Telegram — if the
    returned `imported` list is empty, the number has no Telegram
    account attached to it.
    """
    svc = _require_service()
    from pyrogram.raw import functions as raw_fn
    from pyrogram.raw import types as raw_t

    result = await svc.pyrogram.invoke(
        raw_fn.contacts.ImportContacts(
            contacts=[
                raw_t.InputPhoneContact(
                    client_id=0,
                    phone=body.phone,
                    first_name=body.first_name,
                    last_name=body.last_name,
                )
            ]
        )
    )
    imported_ids = [int(p.user_id) for p in result.imported]
    users = [
        {"id": int(u.id), "username": u.username, "first_name": u.first_name}
        for u in result.users
    ]
    return {
        "phone": body.phone,
        "imported": imported_ids,
        "users": users,
        "retry_contacts": [c.phone for c in result.retry_contacts],
    }


@app.post("/hangup", dependencies=[Depends(_require_token)])
async def post_hangup() -> dict[str, Any]:
    svc = _require_service()
    if svc.status.state == "idle":
        return _status_payload(svc.status)
    peer_id = svc.status.peer_user_id
    svc.status.state = "hanging_up"
    await _broadcast_status(svc)
    # Play an end tone into the call BEFORE tearing it down so the
    # peer gets a short audible "goodbye" cue. Best-effort: if the
    # state is anything other than "connected" (still dialing, or the
    # peer already dropped) there's nothing to play into, so skip.
    if peer_id is not None and svc.status.connected_at is not None:
        with contextlib.suppress(Exception):
            await svc.calls.play(peer_id, MediaStream(str(_end_tone_path())))
            # Matches the ~0.32 s tone length generated in _end_tone_path
            # — we'd rather clip the last 20 ms than hold the call open
            # a full beat past the tone.
            await asyncio.sleep(0.3)
    if peer_id is not None:
        with contextlib.suppress(Exception):
            await svc.calls.leave_call(peer_id)
    _end_call(svc, reason="hung_up")
    await _broadcast_status(svc)
    return _status_payload(svc.status)


@app.websocket("/ws/transcript")
async def ws_transcript(ws: WebSocket) -> None:
    await _auth_ws(ws)
    await _fanout_ws(ws, _require_service().transcript_subs)


@app.websocket("/ws/status")
async def ws_status(ws: WebSocket) -> None:
    await _auth_ws(ws)
    svc = _require_service()
    # Send current state on connect so the dashboard doesn't have to
    # poll /status just to render the initial row.
    await ws.send_json(_status_payload(svc.status))
    await _fanout_ws(ws, svc.status_subs)


# ---- pytgcalls handlers -------------------------------------------------

def _register_handlers(svc: Service) -> None:
    @svc.calls.on_update(tgfilters.chat_update(ChatUpdate.Status.INCOMING_CALL))
    async def _incoming(_, update: ChatUpdate) -> None:
        chat_id = update.chat_id
        # Log BEFORE any await so we always have proof the handler
        # fired, even if something later hangs or raises. This is the
        # first line to look for when diagnosing a missed pickup.
        log.info("INCOMING_CALL fired chat_id=%s — answering now", chat_id)

        # Answer FIRST, classify second. The previous version awaited
        # pyrogram.get_users() before calling record(), so a slow
        # Telegram round-trip could burn the entire ring window and
        # the call would time out unanswered on the peer's side.
        # pytgcalls accepts an incoming call implicitly by starting
        # to record/play; any exception here is the real "failed to
        # pick up" and must be logged, not suppressed.
        accepted = False
        for attempt in (1, 2):
            try:
                await svc.calls.record(chat_id, RecordStream(True, AudioQuality.HIGH))
                accepted = True
                log.info("ANSWERED chat_id=%s attempt=%d", chat_id, attempt)
                break
            except Exception as e:
                log.exception(
                    "accept attempt %d failed chat_id=%s: %s: %s",
                    attempt, chat_id, type(e).__name__, e,
                )
                if attempt == 1:
                    await asyncio.sleep(0.2)
        if not accepted:
            log.error("FAILED TO ANSWER chat_id=%s after 2 attempts", chat_id)
            return

        # Reset the STT buffer — prior call's residual samples shouldn't
        # bleed into the first utterance of this one.
        svc.stt.reset()

        # Caller lookup is optional for *answering* — we're already
        # on the line. A failed or slow get_users() mustn't unanswer
        # the call; 3 s is a hard ceiling so a network blip can't
        # strand peer info lookup forever.
        user = None
        try:
            user = await asyncio.wait_for(
                svc.pyrogram.get_users(chat_id), timeout=3.0
            )
        except Exception as e:
            log.warning(
                "get_users failed chat_id=%s: %s: %s — proceeding without peer info",
                chat_id, type(e).__name__, e,
            )

        # Spam filter runs *after* answering: a wrong-number caller
        # gets a momentary connect-then-disconnect, which is a fair
        # trade for never missing a legitimate call. TARGET_PHONE
        # blank → no filter (dev mode).
        target = os.environ.get("TARGET_PHONE", "").strip()
        if user and target and user.phone_number and not target.endswith(user.phone_number[-8:]):
            log.warning(
                "post-accept decline — uninvited caller %s (chat_id=%s)",
                user.phone_number, chat_id,
            )
            with contextlib.suppress(Exception):
                await svc.calls.leave_call(chat_id)
            return

        caller_label = (
            (user.first_name or user.username or str(user.id))
            if user else f"unknown({chat_id})"
        )
        log.info(
            "call from %s (id=%s, username=@%s, phone=%s)",
            caller_label,
            getattr(user, "id", chat_id),
            getattr(user, "username", "") or "",
            getattr(user, "phone_number", "") or "",
        )

        svc.status = CallStatus(
            state="ringing",
            mode="inbound",
            substate=None,
            peer_user_id=chat_id,
            peer_phone=getattr(user, "phone_number", None) if user else None,
            peer_name=getattr(user, "first_name", None) if user else None,
            peer_username=getattr(user, "username", None) if user else None,
            started_at=time.time(),
            last_event="incoming",
        )
        await _broadcast_status(svc)
        # Silence the laptop immediately — the accept chime and
        # everything after belongs to the phone call, not the tab.
        asyncio.create_task(_notify_dashboard_acquired())

        # Play the accept chime. Non-critical: we've already picked
        # up, so a play() failure is a UX hiccup, not a missed call.
        ring_path = _accept_chime_path()
        try:
            await svc.calls.play(chat_id, MediaStream(str(ring_path)))
        except Exception as e:
            log.warning(
                "accept chime play failed chat_id=%s: %s: %s",
                chat_id, type(e).__name__, e,
            )

    # pytgcalls' ChatUpdate enum has no explicit "connected" event for
    # private calls — the handshake completing is signalled implicitly
    # by the first inbound StreamFrames arriving. We use that as the
    # transition to "connected".
    @svc.calls.on_update(tgfilters.chat_update(ChatUpdate.Status.DISCARDED_CALL))
    async def _discarded(_, update: ChatUpdate) -> None:
        _end_call(svc, reason="discarded")
        await _broadcast_status(svc)

    @svc.calls.on_update(tgfilters.chat_update(ChatUpdate.Status.BUSY_CALL))
    async def _busy(_, update: ChatUpdate) -> None:
        _end_call(svc, reason="busy", error="peer is busy")
        await _broadcast_status(svc)

    @svc.calls.on_update(tgfilters.chat_update(ChatUpdate.Status.LEFT_CALL))
    async def _left(_, update: ChatUpdate) -> None:
        _end_call(svc, reason="left")
        await _broadcast_status(svc)

    @svc.calls.on_update(
        tgfilters.stream_frame(Direction.INCOMING, Device.MICROPHONE)
    )
    async def _audio(_, update: StreamFrames) -> None:
        # First inbound frame also means the handshake completed. Flip
        # state before doing anything else so dashboards can react.
        if svc.status.state != "connected":
            svc.status.state = "connected"
            svc.status.connected_at = time.time()
            svc.status.last_event = "connected"
            if svc.status.mode == "inbound" and svc.status.substate is None:
                svc.status.substate = "listening"
            # On the connected edge, dump what pytgcalls handed us so we
            # can sanity-check format, ssrc, and frame cadence from the
            # log without having to rewire the pipeline. Only logs the
            # first batch per call — if anything is off, it'll be off
            # here too.
            frames = list(update.frames or [])
            log.info(
                "audio: first batch on connect — direction=%s device=%s "
                "ssrcs=%s frames=%d sizes=%s first_bytes=%d",
                update.direction,
                update.device,
                sorted({f.ssrc for f in frames}),
                len(frames),
                [len(f.frame) for f in frames[:8]],
                len(frames[0].frame) if frames and frames[0].frame else 0,
            )
            await _broadcast_status(svc)
            # Safety re-notify. The ringing/dialing edges already
            # fire this, but if either dropped (dashboard slow, Node
            # restart mid-call, network blip) this catches the
            # handshake moment and guarantees the laptop is muted
            # before the peer can actually hear anything.
            asyncio.create_task(_notify_dashboard_acquired())

        if not update.frames:
            return

        # Turn-taking: while the assistant is replying, don't let the
        # caller's voice pile into the STT buffer. When we return to
        # `listening`, the STT is reset so utterance boundaries don't
        # straddle the gap.
        if svc.status.mode == "inbound" and svc.status.substate not in (
            "listening",
            None,
        ):
            return

        # pytgcalls batches multiple audio frames per callback. Earlier
        # code only read frames[0] and dropped the rest — at a typical
        # 20 ms frame size with ~5 frames per batch, that meant Whisper
        # was transcribing ~20 % of the actual audio, which looked like
        # silence to its internal VAD. Concatenate the whole batch so
        # we feed a contiguous buffer to STT.
        frame_bytes = b"".join(f.frame for f in update.frames if f.frame)
        if not frame_bytes:
            return
        for utterance in svc.stt.feed(frame_bytes):
            payload = {
                "type": "utterance",
                "at": utterance.started_at,
                "text": utterance.text,
            }
            await _broadcast_transcript(svc, payload)
            # Inbound conversation loop: hand the utterance off to the
            # worker. Outbound calls use /speak explicitly; the worker
            # ignores the queue when mode != "inbound" anyway.
            if svc.status.mode == "inbound":
                svc.status.turns.append(
                    Turn(role="caller", text=utterance.text, at=utterance.started_at)
                )
                svc.status.substate = "transcribing"
                await _broadcast_status(svc)
                try:
                    svc.utterance_queue.put_nowait(utterance)
                except asyncio.QueueFull:
                    log.warning("utterance queue full; dropping: %s", utterance.text)


def _end_call(svc: Service, *, reason: str, error: str | None = None) -> None:
    """
    Transition out of an active call while preserving the transcript
    so the dashboard can render it as a history entry. Called from
    every terminal ChatUpdate (DISCARDED / BUSY / LEFT) and from the
    /hangup route.

    Also fires a fire-and-forget release to the dashboard so its
    shared voice session flips off the Telegram channel — without
    this, the dashboard UI stays muted and the "on Telegram" chip
    stays lit indefinitely after a hangup.
    """
    prior = svc.status
    svc.status = CallStatus(
        state="idle",
        mode=None,
        substate=None,
        peer_user_id=prior.peer_user_id,
        peer_phone=prior.peer_phone,
        peer_name=prior.peer_name,
        peer_username=prior.peer_username,
        started_at=prior.started_at,
        connected_at=prior.connected_at,
        last_ended_at=time.time(),
        turns=prior.turns,
        last_event=reason,
        last_error=error,
    )
    # Drain queued utterances so a stale one can't trigger a TTS reply
    # into a dead call.
    while not svc.utterance_queue.empty():
        with contextlib.suppress(asyncio.QueueEmpty):
            svc.utterance_queue.get_nowait()
    # Cancel any active filler task BEFORE notifying the dashboard.
    # The YouTube branch's CancelledError handler fires a final
    # report_position so the dashboard's resume picks up the freshest
    # playhead, not the value from 5 s ago. cancel_thinking is the
    # sync variant of stop_thinking — it skips the silence-bridge
    # playback (which would fail mid-teardown anyway).
    if svc.filler is not None and prior.peer_user_id is not None:
        with contextlib.suppress(Exception):
            svc.filler.cancel_thinking(prior.peer_user_id)
    # Fire-and-forget notify the dashboard. A failed call here leaves
    # the dashboard thinking the Telegram line is still held, which
    # the 250 ms poll on /api/telegram/session will eventually
    # reconcile via the 30-min stale-TTL — but we always try first
    # so the hand-back feels instant in the common case.
    with contextlib.suppress(RuntimeError):
        asyncio.create_task(_notify_dashboard_released())


async def _notify_dashboard_released() -> None:
    base = os.environ.get("AMASO_DASHBOARD_URL", "http://127.0.0.1:3737").rstrip("/")
    token = os.environ.get("SERVICE_TOKEN", "").strip()
    if not token:
        return
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{base}/api/telegram/release",
                json={},
                headers={"X-Auth": token},
            )
    except httpx.HTTPError as exc:
        log.warning("dashboard release unreachable: %s", exc)


async def _notify_dashboard_acquired() -> None:
    """
    Tell the dashboard "I've got the audio, mute yourself" the moment
    a call transitions out of idle. This is the critical piece that
    stops the laptop speakers from bleeding into the phone call
    between "ringing" and the first transcribed utterance — the
    /respond endpoint alone was too late because Whisper's silence-
    hold segmentation takes 2 s minimum, and cold STT can take longer.
    Fire-and-forget; the dashboard's own 100 ms channel poll picks
    it up within a frame or two.
    """
    base = os.environ.get("AMASO_DASHBOARD_URL", "http://127.0.0.1:3737").rstrip("/")
    token = os.environ.get("SERVICE_TOKEN", "").strip()
    if not token:
        return
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                f"{base}/api/telegram/acquire",
                json={},
                headers={"X-Auth": token},
            )
    except httpx.HTTPError as exc:
        log.warning("dashboard acquire unreachable: %s", exc)


# ---- Conversation worker ------------------------------------------------

async def _conversation_worker(svc: Service) -> None:
    """
    Sequentially drains the utterance queue: LLM → Kokoro → play →
    sleep(duration). Only runs for inbound calls; /speak drives the
    outbound mode directly. Any exception is caught and logged — we
    never want a single bad turn to take the worker down.
    """
    loop = asyncio.get_running_loop()
    while True:
        try:
            utterance = await svc.utterance_queue.get()
        except asyncio.CancelledError:
            return
        try:
            await _handle_turn(svc, utterance, loop)
        except Exception:
            log.exception("conversation turn failed")
            # Best-effort: return to listening so the caller isn't
            # stuck with a frozen state indicator.
            if svc.status.mode == "inbound" and svc.status.state == "connected":
                svc.status.substate = "listening"
                svc.stt.reset()
                await _broadcast_status(svc)


async def _send_transcript_message(svc: Service, peer_id: int, text: str) -> None:
    """
    Mirror the assistant's spoken reply into the Telegram chat with
    the caller. They get a scrollable transcript of the call without
    having to do anything after hanging up.

    Scope on purpose:
      - Only fires during active inbound calls (caller's turn came in
        through the conversation loop). Outbound /speak stays audio-
        only since those are pushed by the dashboard with their own
        UI layer.
      - Plain text, no formatting. Markdown inside a voice reply is
        rare but if any slips through, sending as plain prose keeps
        the UX consistent with what the caller heard.
      - Swallows errors — the voice channel is the primary reply
        path; a message-send failure shouldn't take that down.
    """
    text = text.strip()
    if not text:
        return
    try:
        await svc.pyrogram.send_message(chat_id=peer_id, text=text)
    except Exception:
        log.exception("transcript send_message failed")


async def _call_dashboard_respond(svc: Service, utterance: str) -> str | None:
    """
    POST the caller's utterance to the dashboard's /api/telegram/respond
    endpoint. Returns the reply text on success, None on any failure
    (timeout, non-200, unreachable) so the caller can fall back.

    The dashboard handles history + session take-over; we just record
    which dashboard session this call is riding on and whether we
    inherited an existing conversation.
    """
    base = os.environ.get("AMASO_DASHBOARD_URL", "http://127.0.0.1:3737").rstrip("/")
    token = os.environ.get("SERVICE_TOKEN", "").strip()
    if not token:
        return None
    payload = {
        "utterance": utterance,
        "caller_name": svc.status.peer_name or "the caller",
    }
    # The dashboard's /respond runs the full Spar Claude CLI end-to-end
    # (subprocess boot + Haiku response + tool pre-flight), which on a
    # cold cache easily lands in the 15–25 s band. A tight timeout
    # here is what trips the "dashboard unreachable" apology into
    # every call. Bias toward waiting — the caller already hears the
    # thinking hum, so a longer wait sounds natural; an early abort
    # is the actual bug.
    #
    # timeout structure: 10 s to establish the TCP+TLS+route hit,
    # then 90 s for the full read. Without the per-pool split, a
    # stuck connection blocks indefinitely.
    timeout = httpx.Timeout(90.0, connect=10.0)
    t0 = time.monotonic()
    log.info("dashboard/respond: POST utterance=%r", utterance[:80])
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{base}/api/telegram/respond",
                json=payload,
                headers={"X-Auth": token},
            )
    except httpx.HTTPError as exc:
        log.warning(
            "dashboard/respond: FAILED after %.1fs: %s",
            time.monotonic() - t0,
            exc,
        )
        return None
    log.info(
        "dashboard/respond: %s in %.1fs, %d bytes",
        resp.status_code,
        time.monotonic() - t0,
        len(resp.content),
    )
    if resp.status_code != 200:
        log.warning("dashboard respond %s: %s", resp.status_code, resp.text[:200])
        return None
    data = resp.json()
    if not data.get("ok"):
        log.warning("dashboard respond not ok: %s", data)
        return None
    # First successful response seeds the session id and takeover flag
    # so the UI can surface it.
    if svc.status.dashboard_session_id is None:
        svc.status.dashboard_session_id = data.get("session_id")
        svc.status.took_over_from = data.get("took_over_from")
    reply = (data.get("reply") or "").strip()
    return reply or None


async def _handle_turn(svc: Service, utterance: Utterance, loop: asyncio.AbstractEventLoop) -> None:
    turn_t0 = time.monotonic()
    text = utterance.text
    # Clock anchors for the PIPELINE summary at end of turn.
    # utterance.end_of_speech_at is set by stt_bridge when silence
    # hold fired — that's the moment the caller stopped talking,
    # which is the honest start of "how long did they wait."
    last_voice_at = utterance.end_of_speech_at - utterance.silence_hold_s
    log.info(
        "turn: start utterance=%r state=%s audio_dur=%.2fs silence_hold=%.0fms whisper=%.0fms",
        text[:80],
        svc.status.state,
        utterance.audio_duration_s,
        utterance.silence_hold_s * 1000.0,
        utterance.whisper_ms,
    )

    # Sanity: call may have ended between enqueue and dequeue.
    if svc.status.mode != "inbound" or svc.status.state != "connected":
        log.info("turn: abort before dashboard — not connected")
        return

    # Single path: hand the utterance to the dashboard and wait for
    # the reply. This process has no conversation state of its own —
    # spinning up a second LLM here (as an earlier iteration did)
    # silently forked the conversation into a separate brain whenever
    # the dashboard was slow to answer, which is exactly the bug this
    # relay architecture exists to prevent.
    svc.status.substate = "thinking"
    await _broadcast_status(svc)
    # One-shot "starting to think" cue — distinct from the looping
    # windchime / news filler that follows. Kept brief + quiet so
    # it doesn't step on the filler clip that starts ~200 ms later.
    with contextlib.suppress(Exception):
        if svc.status.peer_user_id is not None:
            await svc.calls.play(
                svc.status.peer_user_id,
                MediaStream(str(_thinking_start_chime_path())),
            )
    # Pre-rendered filler (news / YouTube) replaces the windchime
    # loop as the thinking-state fill. If the filler manager has no
    # clips ready yet (prerender still running on first-boot call,
    # or mode set to "off") we drop back to the chime so the caller
    # always hears *something*.
    chime_t0 = time.monotonic()
    filler_started = False
    if svc.filler is not None and svc.filler.has_content() and svc.status.peer_user_id is not None:
        try:
            await svc.filler.start_thinking(svc.calls, svc.status.peer_user_id)
            filler_started = True
        except Exception:
            log.exception("filler: start_thinking raised — falling back to chime")
    if not filler_started:
        with contextlib.suppress(Exception):
            await svc.calls.play(
                svc.status.peer_user_id, MediaStream(str(_thinking_chime_path()))
            )
    chime_ms = (time.monotonic() - chime_t0) * 1000.0
    claude_t0 = time.monotonic()
    reply_text = await _call_dashboard_respond(svc, text)
    claude_ms = (time.monotonic() - claude_t0) * 1000.0

    # Stop the filler loop and lay down a 500 ms silence bridge so
    # the caller hears a deliberate gap rather than an abrupt cut
    # into the reply. pytgcalls doesn't expose a volume envelope, so
    # silence is the best approximation of "fade" we can do without
    # a real audio mixer in the path.
    if filler_started and svc.filler is not None and svc.status.peer_user_id is not None:
        with contextlib.suppress(Exception):
            await svc.filler.stop_thinking(svc.calls, svc.status.peer_user_id)

    # Abandonment check: the dashboard round-trip can take seconds,
    # and the caller may have hung up in the meantime. Running Kokoro
    # + play() against a dead peer just logs noisy exceptions, and
    # the user doesn't hear any of it anyway. Bail early — the next
    # call starts clean.
    if svc.status.mode != "inbound" or svc.status.state != "connected":
        log.info(
            "turn: abandoned after dashboard — state=%s (call ended mid-turn)",
            svc.status.state,
        )
        return

    if reply_text is None:
        # Dashboard RPC failed — token mismatch, network blip, 5xx,
        # whatever. Apologise briefly in voice and stay listening. We
        # explicitly do NOT fall back to a second AI: the user's
        # laptop transcript and phone audio must always reflect the
        # same session, and the only way to guarantee that is to let
        # the dashboard own every turn.
        log.warning("turn: dashboard returned None, using apology text")
        reply_text = (
            "I can't reach the dashboard right now, so I can't pull up our "
            "conversation. Give it a moment and try again."
        )
        svc.status.last_error = "dashboard unreachable"

    log.info("turn: reply %d chars: %r", len(reply_text), reply_text[:120])

    now = time.time()
    svc.status.turns.append(Turn(role="assistant", text=reply_text, at=now))
    await _broadcast_transcript(
        svc,
        {"type": "utterance", "at": now, "text": reply_text, "role": "assistant"},
    )

    # Synthesize + play.
    svc.status.substate = "speaking"
    await _broadcast_status(svc)
    synth_t0 = time.monotonic()
    try:
        wav_bytes, duration_s = await asyncio.to_thread(
            kokoro_bridge.synthesize, reply_text, None, None
        )
    except Exception as exc:
        log.exception("kokoro synth failed")
        svc.status.last_error = f"kokoro: {exc}"
        svc.status.substate = "listening"
        svc.stt.reset()
        await _broadcast_status(svc)
        return
    tts_ms = (time.monotonic() - synth_t0) * 1000.0
    log.info(
        "turn: kokoro done in %.1fs (%d bytes wav, %.1fs audio)",
        tts_ms / 1000.0,
        len(wav_bytes),
        duration_s,
    )

    path = _write_temp_wav(wav_bytes)
    # Fire the chat-transcript message in parallel with the audio
    # play. Two reasons it's a background task:
    #   1. `pyrogram.send_message` takes 200-400 ms round-trip; doing
    #      it before play() would add that gap to the audio reply and
    #      the caller hears a suspicious pause.
    #   2. If the message API ever errors, we don't want it to take
    #      down the actual voice reply — the audio is the primary
    #      channel, the message is nice-to-have.
    peer_id = svc.status.peer_user_id
    if peer_id is not None:
        asyncio.create_task(_send_transcript_message(svc, peer_id, reply_text))
    # Second abandonment check before play(): the caller might have
    # dropped between the dashboard reply and Kokoro finishing. Going
    # ahead here raises a noisy exception from pytgcalls that we'd
    # just suppress anyway.
    if svc.status.mode != "inbound" or svc.status.state != "connected":
        log.info("turn: abandoned before play — state=%s", svc.status.state)
        loop.call_later(30, _unlink_quietly, path)
        return
    # One-line latency breakdown from the caller's last spoken
    # syllable to reply-audio starting. Sum-of-stages usually
    # matches total within a few ms; any gap lives in chime + queue
    # + misc overhead, which we report separately so it's visible
    # when it bloats.
    play_t0 = time.monotonic()
    silence_ms = utterance.silence_hold_s * 1000.0
    whisper_ms = utterance.whisper_ms
    total_s = play_t0 - last_voice_at
    overhead_ms = max(
        0.0,
        total_s * 1000.0 - silence_ms - whisper_ms - claude_ms - tts_ms,
    )
    log.info(
        "PIPELINE silence=%.0fms whisper=%.0fms claude=%.0fms tts=%.0fms "
        "overhead=%.0fms chime=%.0fms total=%.2fs reply_chars=%d audio=%.1fs",
        silence_ms,
        whisper_ms,
        claude_ms,
        tts_ms,
        overhead_ms,
        chime_ms,
        total_s,
        len(reply_text),
        duration_s,
    )
    try:
        log.info("turn: play() start peer=%s", svc.status.peer_user_id)
        await svc.calls.play(svc.status.peer_user_id, MediaStream(str(path)))
        # Estimate playback completion. Pad by 300 ms so we don't clip
        # the tail when pytgcalls' buffer is still draining.
        await asyncio.sleep(duration_s + 0.3)
        log.info(
            "turn: done total=%.1fs",
            time.monotonic() - turn_t0,
        )
    except Exception:
        log.exception("turn: play() failed")
    finally:
        loop.call_later(30, _unlink_quietly, path)

    # Only return to listening if we're still in a connected call.
    if svc.status.mode == "inbound" and svc.status.state == "connected":
        # Soft "mic is open" chime between the end of the reply and
        # the mic-open transition. Without it the caller often starts
        # talking during the pytgcalls buffer drain and the first
        # syllable gets clipped by the substate gate.
        peer_id = svc.status.peer_user_id
        if peer_id is not None:
            with contextlib.suppress(Exception):
                await svc.calls.play(
                    peer_id, MediaStream(str(_your_turn_chime_path()))
                )
                # Match the chime's ~0.08 s length; any longer and the
                # caller feels like the assistant is still speaking.
                await asyncio.sleep(0.1)
        svc.status.substate = "listening"
        svc.stt.reset()
        await _broadcast_status(svc)


# ---- Helpers ------------------------------------------------------------

def _require_service() -> Service:
    if _service is None:
        raise HTTPException(503, "service not ready")
    return _service


async def _resolve_peer(svc: Service, body: CallBody) -> int:
    if body.user_id:
        return int(body.user_id)
    phone = (body.phone or os.environ.get("TARGET_PHONE", "")).strip()
    if not phone:
        raise HTTPException(400, "user_id or phone required")
    try:
        user = await svc.pyrogram.get_users(phone)
    except Exception as exc:
        raise HTTPException(
            400, f"can't resolve {phone} — the assistant account must have "
            f"this user in its contacts first ({exc})"
        ) from exc
    return int(user.id)


def _status_payload(status: CallStatus) -> dict[str, Any]:
    return {
        "state": status.state,
        "mode": status.mode,
        "substate": status.substate,
        "peer_user_id": status.peer_user_id,
        "peer_phone": status.peer_phone,
        "peer_name": status.peer_name,
        "peer_username": status.peer_username,
        "started_at": status.started_at,
        "connected_at": status.connected_at,
        "last_ended_at": status.last_ended_at,
        "turns": [
            {"role": t.role, "text": t.text, "at": t.at} for t in status.turns
        ],
        "dashboard_session_id": status.dashboard_session_id,
        "took_over_from": status.took_over_from,
        "last_event": status.last_event,
        "last_error": status.last_error,
    }


async def _broadcast_status(svc: Service) -> None:
    payload = _status_payload(svc.status)
    _fanout(svc.status_subs, payload)


async def _broadcast_transcript(svc: Service, payload: dict[str, Any]) -> None:
    _fanout(svc.transcript_subs, payload)


def _fanout(subs: set[asyncio.Queue[dict[str, Any]]], payload: dict[str, Any]) -> None:
    dead: list[asyncio.Queue[dict[str, Any]]] = []
    for q in subs:
        try:
            q.put_nowait(payload)
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        subs.discard(q)


async def _auth_ws(ws: WebSocket) -> None:
    token = ws.headers.get("x-auth") or ws.query_params.get("token") or ""
    expected = os.environ.get("SERVICE_TOKEN", "").strip()
    if not expected or token != expected:
        await ws.close(code=4401)
        raise WebSocketDisconnect(code=4401)
    await ws.accept()


async def _fanout_ws(ws: WebSocket, subs: set[asyncio.Queue[dict[str, Any]]]) -> None:
    q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=128)
    subs.add(q)
    try:
        while True:
            payload = await q.get()
            await ws.send_json(payload)
    except WebSocketDisconnect:
        return
    finally:
        subs.discard(q)


# ---- Feedback sounds ----------------------------------------------------
#
# The service expects three short WAV files in ./feedback_sounds/:
#   dial.wav    — played until the peer picks up
#   accept.wav  — played when we auto-accept an incoming call
#   end.wav     — played when the call ends (on our side)
#
# If a file is missing we fall back to a 200 ms of silence so pytgcalls
# has *something* to stream. See feedback_sounds/README.md.

SOUNDS = HERE / "feedback_sounds"
GENERATED_SOUNDS = HERE / "sounds"

# Bump whenever any generated WAV's acoustic recipe changes. On boot,
# `_prewarm_feedback_sounds` wipes the cache directory if the stamp on
# disk doesn't match — that way installs with stale WAVs from a prior
# recipe pick up the new sound on the next start without manual rm.
_SOUND_RECIPE_VERSION = "4"  # bumped for message_sent.wav addition


def _render_chime_wav(
    path: Path,
    strikes: list[tuple[float, float, float]],
    *,
    total_duration_s: float,
    decay_s: float = 1.5,
    peak: float = 0.22,
) -> Path:
    """
    Render bell-like strikes into a mono 48 kHz s16le WAV.

    Each strike is `(start_s, fundamental_hz, velocity)`. Every strike
    is a stack of three partials at slightly inharmonic ratios (1.0,
    2.76, 5.40 — a rough cut of the Fletcher bell coefficients) so the
    result sounds like struck metal, not a synthesised sine. A short
    raised-cosine attack keeps it from clicking, then an exponential
    decay over `decay_s` lets the tone ring out naturally.

    Used for both the thinking chime (many strikes scattered across 60 s)
    and the your-turn chime (a single strike) so the two cues feel like
    part of the same palette — same harmonic character, different pitch
    and length.
    """
    if path.exists():
        return path

    GENERATED_SOUNDS.mkdir(parents=True, exist_ok=True)
    import numpy as np
    import soundfile as sf

    sr = kokoro_bridge.TELEGRAM_SAMPLE_RATE
    total = int(sr * total_duration_s)
    sig = np.zeros(total, dtype=np.float32)

    partial_ratios = (1.0, 2.76, 5.40)
    partial_gains = (1.0, 0.5, 0.25)
    tau = max(decay_s / 5.0, 1e-3)  # ~5τ ≈ fully decayed
    attack_n = max(1, int(sr * 0.004))
    attack = 0.5 * (
        1.0 - np.cos(np.linspace(0.0, np.pi, attack_n, dtype=np.float32))
    )

    for start_s, freq, velocity in strikes:
        n = int(sr * (decay_s + 0.05))
        if n <= 0:
            continue
        t = np.arange(n, dtype=np.float32) / sr
        env = np.exp(-t / tau).astype(np.float32)
        env[:attack_n] *= attack
        wave = np.zeros(n, dtype=np.float32)
        for ratio, gain in zip(partial_ratios, partial_gains):
            wave += gain * np.sin(
                2.0 * np.pi * float(freq) * float(ratio) * t
            ).astype(np.float32)
        strike_sig = float(velocity) * env * wave
        start_i = int(start_s * sr)
        end_i = min(start_i + n, total)
        if end_i > start_i:
            sig[start_i:end_i] += strike_sig[: end_i - start_i]

    # Normalise to the requested peak. Overlapping strikes can momentarily
    # sum past 1.0; a post-render peak-normalise is simpler than a live
    # limiter and sounds the same for our sparse hits.
    pk = float(np.max(np.abs(sig))) if sig.size else 0.0
    if pk > 0.0:
        sig *= peak / pk

    samples = np.clip(sig * 32767.0, -32768.0, 32767.0).astype(np.int16)
    sf.write(path, samples, sr, subtype="PCM_16")
    return path


def _thinking_chime_path() -> Path:
    """
    Soft wind-chime loop played while the assistant is thinking. Bells
    strike at randomised intervals on an A-minor pentatonic palette —
    no harsh intervals, the way real wind chimes are tuned — with a mix
    of close clusters and longer quiets so it feels like weather, not a
    metronome. Generated once and cached.

    Replaces the earlier 90/93 Hz detuned-sine drone; that design was
    "technically correct ambient noise" but actively unpleasant to sit
    through for 10+ seconds, which is exactly when the caller hears it.
    Bells are quieter perceptually too, so they sit under TTS better.
    """
    user = SOUNDS / "thinking_chime.wav"
    if user.exists():
        return user

    path = GENERATED_SOUNDS / "thinking_chime.wav"
    if path.exists():
        return path

    import numpy as np

    # Deterministic seed so the chime is identical across restarts —
    # keeps recordings comparable if we ever A/B a tweak.
    rng = np.random.default_rng(0xC41ECAFE)
    # A minor pentatonic: A4, C5, D5, E5, G5. Same set of notes most
    # physical wind chimes are tuned to for exactly this reason.
    palette = [440.00, 523.25, 587.33, 659.25, 783.99]

    duration_s = 60.0
    strikes: list[tuple[float, float, float]] = []
    t = 0.5
    while t < duration_s - 2.2:
        freq = float(rng.choice(palette))
        velocity = 0.5 + 0.5 * float(rng.random())
        strikes.append((t, freq, velocity))
        # 35 % chance of a close follow-up strike (mimics a gust moving
        # through multiple chimes at once), otherwise a longer quiet.
        if float(rng.random()) < 0.35:
            t += 0.25 + 0.35 * float(rng.random())
        else:
            t += 2.0 + 2.0 * float(rng.random())

    return _render_chime_wav(
        path,
        strikes,
        total_duration_s=duration_s,
        decay_s=1.8,
        peak=0.22,
    )


def _tone_wav(
    path: Path,
    segments: list[tuple[float, float, float]],
    *,
    amplitude: float = 0.25,
) -> Path:
    """
    Render a sequence of sine-tone segments into a single WAV at
    48 kHz mono s16le. Each segment is `(frequency_hz, duration_s,
    amp_scale)` — amp_scale of 1.0 means `amplitude`, 0.0 means
    silence. Edges are linearly cross-faded over 10 ms so the call
    doesn't get a click between segments.

    Used for the dial / accept / end / your-turn chimes. Generated on
    demand and cached on disk so the cost is paid once.
    """
    if path.exists():
        return path

    GENERATED_SOUNDS.mkdir(parents=True, exist_ok=True)
    import numpy as np
    import soundfile as sf

    sr = kokoro_bridge.TELEGRAM_SAMPLE_RATE
    fade_n = max(1, int(sr * 0.01))
    chunks: list[np.ndarray] = []
    for freq, dur, scale in segments:
        n = int(sr * dur)
        if n <= 0:
            continue
        if freq <= 0 or scale <= 0:
            chunks.append(np.zeros(n, dtype=np.float32))
            continue
        t = np.arange(n, dtype=np.float32) / sr
        seg = amplitude * scale * np.sin(2 * np.pi * freq * t).astype(np.float32)
        # Per-segment fades so adjacent segments don't click into each
        # other when the frequency changes.
        if n > fade_n * 2:
            fade = np.linspace(0.0, 1.0, fade_n, dtype=np.float32)
            seg[:fade_n] *= fade
            seg[-fade_n:] *= fade[::-1]
        chunks.append(seg)

    sig = np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32)
    samples = np.clip(sig * 32767, -32768, 32767).astype(np.int16)
    sf.write(path, samples, sr, subtype="PCM_16")
    return path


def _dial_tone_path() -> Path:
    """Classic two-tone dial pattern — 350+440 Hz dyad used by POTS
    dial tones. Short and quiet; Telegram replaces this the instant
    the peer accepts, so length barely matters."""
    user = SOUNDS / "dial.wav"
    if user.exists():
        return user
    # The dyad gets rendered as two separate segments summed — fake it
    # with the higher tone alone, which is what callers hear over a
    # cell network anyway.
    return _tone_wav(
        GENERATED_SOUNDS / "dial.wav",
        [(420.0, 1.2, 0.6)],
        amplitude=0.18,
    )


def _accept_chime_path() -> Path:
    """Rising two-note pip so the caller knows we just picked up. If
    a user-supplied WAV exists in ./feedback_sounds/, prefer that —
    the generated default is the fallback."""
    user = SOUNDS / "accept.wav"
    if user.exists():
        return user
    return _tone_wav(
        GENERATED_SOUNDS / "accept.wav",
        [(660.0, 0.12, 1.0), (880.0, 0.18, 1.0)],
        amplitude=0.22,
    )


def _end_tone_path() -> Path:
    """Descending pip played when WE hang up, so the peer gets an
    audible "goodbye" cue before the line drops. When the peer hangs
    up first the VoIP layer has already torn down and this is moot."""
    user = SOUNDS / "end.wav"
    if user.exists():
        return user
    return _tone_wav(
        GENERATED_SOUNDS / "end.wav",
        [(660.0, 0.14, 1.0), (440.0, 0.18, 1.0)],
        amplitude=0.22,
    )


def _thinking_start_chime_path() -> Path:
    """
    One-shot warm cue played the instant the assistant starts
    thinking, distinct from the looping windchime / filler content.
    Two soft rising notes (A4 → C5) with a gentle 0.25 s decay —
    clearly a "starting something" signal without being alarming.
    Low amplitude so it sits UNDER the filler / news clip that
    follows ~200 ms later.
    """
    user = SOUNDS / "thinking_start.wav"
    if user.exists():
        return user
    return _tone_wav(
        GENERATED_SOUNDS / "thinking_start.wav",
        [(440.0, 0.14, 1.0), (523.25, 0.20, 1.0)],
        amplitude=0.14,
    )


def _message_sent_chime_path() -> Path:
    """
    Soft descending pair (E5 → B4) played the moment the user submits
    a typed turn. Acts as a "launched" acknowledgement so the user
    knows the message left the dashboard, not just that they hit Enter.
    Pitched lower and shorter than the assistant cues so the ear
    parses it as "user-side action" rather than "AI is doing
    something". Same recipe as the rising thinking_start cue but
    inverted in direction and dropped in amplitude.
    """
    user = SOUNDS / "message_sent.wav"
    if user.exists():
        return user
    return _tone_wav(
        GENERATED_SOUNDS / "message_sent.wav",
        [(659.25, 0.10, 1.0), (493.88, 0.14, 1.0)],
        amplitude=0.12,
    )


def _your_turn_chime_path() -> Path:
    """
    Short, bright bell-ping played just before we return to listening
    after a reply. Signals "mic is open" the way push-to-talk radios
    do, so the caller doesn't start talking during the pytgcalls buffer
    drain window.

    Uses the same inharmonic-bell recipe as the thinking chime but
    pitched up to D6 (1175 Hz) with a quick 0.35 s decay — clearly
    "higher and shorter" than the thinking chime's ringing A-minor
    cluster, so the ear can tell the two cues apart without thinking
    about it.
    """
    user = SOUNDS / "your_turn.wav"
    if user.exists():
        return user
    return _render_chime_wav(
        GENERATED_SOUNDS / "your_turn.wav",
        [(0.0, 1174.66, 1.0)],
        total_duration_s=0.45,
        decay_s=0.35,
        peak=0.18,
    )


def _sound_or_silence(name: str) -> Path:
    candidate = SOUNDS / name
    if candidate.exists():
        return candidate
    return _silence_wav()


def _prewarm_feedback_sounds() -> None:
    """Render every generated feedback WAV to disk up-front so the
    VoIP thread never has to do it mid-call. Idempotent per recipe
    version — if `_SOUND_RECIPE_VERSION` has been bumped since the last
    run, the cache directory is wiped first so every WAV bakes against
    the new recipe. User-supplied overrides in `feedback_sounds/` are
    never touched."""
    GENERATED_SOUNDS.mkdir(parents=True, exist_ok=True)
    version_file = GENERATED_SOUNDS / ".recipe_version"
    try:
        current = version_file.read_text().strip() if version_file.exists() else ""
    except Exception:
        current = ""
    if current != _SOUND_RECIPE_VERSION:
        for child in GENERATED_SOUNDS.glob("*.wav"):
            with contextlib.suppress(Exception):
                child.unlink()
        with contextlib.suppress(Exception):
            version_file.write_text(_SOUND_RECIPE_VERSION)

    for ensure in (
        _thinking_chime_path,
        _thinking_start_chime_path,
        _dial_tone_path,
        _accept_chime_path,
        _end_tone_path,
        _your_turn_chime_path,
        _message_sent_chime_path,
    ):
        with contextlib.suppress(Exception):
            ensure()


_silence_cache: Path | None = None


def _silence_wav() -> Path:
    global _silence_cache
    if _silence_cache and _silence_cache.exists():
        return _silence_cache
    import numpy as np
    import soundfile as sf

    samples = np.zeros(int(0.2 * kokoro_bridge.TELEGRAM_SAMPLE_RATE), dtype="int16")
    path = Path(tempfile.gettempdir()) / "amaso-silence-48k.wav"
    sf.write(path, samples, kokoro_bridge.TELEGRAM_SAMPLE_RATE, subtype="PCM_16")
    _silence_cache = path
    return path


def _write_temp_wav(data: bytes) -> Path:
    fd, name = tempfile.mkstemp(suffix=".wav", prefix="amaso-tts-")
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return Path(name)


def _unlink_quietly(path: Path) -> None:
    with contextlib.suppress(Exception):
        path.unlink()


# ---- Main ---------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "service:app",
        host=os.environ.get("SERVICE_HOST", "127.0.0.1"),
        port=int(os.environ.get("SERVICE_PORT", "8765")),
        log_level="info",
    )
