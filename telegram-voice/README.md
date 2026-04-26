# telegram-voice

Python service that turns the dashboard's Spar assistant into a real
Telegram userbot that can place and take 1-on-1 voice calls with
Santi.

**Not a bot.** The Bot API cannot make or receive voice calls.
This service logs into Telegram as a real user account
(`+31 6 18 24 30 12` — the "assistant" number) via Pyrogram, and uses
`py-tgcalls` 2.x (ntgcalls under the hood) for the VoIP layer.

**If you're asking "is this possible at all" — read
[`RESEARCH.md`](./RESEARCH.md) first.** It documents every library I
looked at, why most of them are dead, and why this stack is the right
one as of April 2026.

## Layout

```
telegram-voice/
├── RESEARCH.md          feasibility, decisions, fallbacks
├── README.md            this file
├── requirements.txt     pinned — don't float these
├── .env.example         copy to .env and fill in
├── .gitignore           session files and .env stay local
├── login.py             one-time Pyrogram phone verification
├── service.py           long-running FastAPI + pytgcalls process
├── kokoro_bridge.py     text → 48 kHz WAV via the existing Kokoro install
├── stt_bridge.py        incoming frames → faster-whisper utterances
└── feedback_sounds/     dial.wav, accept.wav, end.wav (48 kHz mono s16)
```

## Setup (one-time)

1. **Python 3.12** in a virtualenv:
   ```bash
   cd telegram-voice
   python -m venv .venv
   .venv\Scripts\activate      # Windows
   source .venv/bin/activate   # macOS/Linux
   pip install -r requirements.txt
   ```
2. Grab a Telegram developer app pair at <https://my.telegram.org/apps>
   (you only do this once per dev — not per account).
3. `cp .env.example .env` and fill in:
   - `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from step 2
   - `SERVICE_TOKEN` — pick any random string; the dashboard sends
     this in `X-Auth`
4. **Sign in as the assistant account**:
   ```bash
   python login.py
   ```
   Pyrogram will prompt for the phone number (pre-filled from
   `.env`), send a code via Telegram, and ask for it. Two-factor
   password too if the account has one. On success it writes
   `assistant.session` next to the script — that's the credential,
   guard it.
5. **Add Santi as a contact on the assistant account.** Private
   calls only work between users who have each other in contacts.
   Easiest way: from Santi's phone, open a chat with the assistant
   number and send any message; from the assistant account (log in
   on Telegram Desktop once), accept the chat and add to contacts.
6. Drop ring/accept/end WAVs in `feedback_sounds/` — see the README
   there for quick ffmpeg recipes.

## Running

```bash
python service.py
```

Binds to `127.0.0.1:8765` by default. Uvicorn logs every request.
If `assistant.session` is missing or expired you'll get a clean
`RuntimeError` at startup telling you to re-run `login.py`.

The dashboard Node server (already in this repo) calls the service
via HTTP. See the **Dashboard integration** section below.

## HTTP API

All non-`GET` routes require `X-Auth: <SERVICE_TOKEN>`.

### `POST /call`

Dials Santi (or any user by id / phone number).

```jsonc
// body — both fields optional; defaults to TARGET_PHONE
{ "user_id": 123456789 }
// or
{ "phone": "+31648935807" }
```

Returns the current status. Fails with 409 if a call is already in
progress and 400 if the target can't be resolved (the assistant
account must have the target in its contacts).

### `POST /speak`

Synthesizes text through Kokoro and plays the result into the
active call.

```jsonc
{ "text": "Hey Santi, quick update.",
  "voice": "af_bella",     // optional, falls back to TTS_VOICE env
  "speed": 1.0 }           // optional, 0.5–2.0
```

`/speak` replaces the current outgoing audio each time it's called
— calling it twice in quick succession effectively interrupts the
first utterance. That matches how real conversations work.

### `POST /hangup`

Ends the active call. Idempotent — hanging up when idle is a no-op.

### `GET /status`

No auth, public. Returns:

```jsonc
{
  "state": "connected",       // idle | dialing | ringing | connected | hanging_up
  "peer_user_id": 123456789,
  "peer_phone": "+31648935807",
  "started_at": 1714123200.12,
  "connected_at": 1714123203.88,
  "last_event": "connected",
  "last_error": null
}
```

### `WS /ws/status`

Streams the same status payload as `/status` on every state change.
Auth via `X-Auth` header *or* `?token=...` query param (the latter
because most browser WebSocket APIs can't set custom headers).

### `WS /ws/transcript`

Streams live utterances from the STT pipeline:

```jsonc
{ "type": "utterance", "at": 1714123210.55, "text": "how's it going" }
```

One message per completed utterance — the service segments on a
2-second silence hold (tunable in `stt_bridge.py`).

## Dashboard integration

The Node server already in `../` can reach this service over
localhost. Suggested wiring (already tracked as a separate task;
not yet implemented):

- `app/api/telegram/call/route.ts` → `POST /call`
- `app/api/telegram/speak/route.ts` → `POST /speak`
- `app/api/telegram/hangup/route.ts` → `POST /hangup`
- `app/api/telegram/stream/route.ts` → SSE bridge that subscribes to
  the two WebSockets and forwards frames to the browser

The dashboard never talks Pyrogram, pytgcalls, Whisper, or Kokoro
directly — this service owns all of it. That keeps the Node tree
free of the Python-only call stack.

## Running under the dashboard process supervisor

The dashboard has a lightweight process spawner (used for local dev
servers under `projects/`). Adding this service to the same
supervisor means it starts/stops with the dashboard and logs land
in the same place. See the dashboard `server.ts` for the existing
spawn patterns.

## Troubleshooting

- **`RuntimeError: no session file`** at startup — run `login.py`.
- **`PEER_ID_INVALID`** when calling — the assistant doesn't have
  the target in contacts. Add them once and retry.
- **Call connects but Santi hears nothing** — either Kokoro isn't
  emitting audio (run `python -c "import kokoro_bridge; print(len(kokoro_bridge.synthesize('test')))"`
  and confirm it returns a non-zero byte count) or the WAV sample
  rate is wrong (everything on the wire needs to be 48 kHz mono
  s16le — `kokoro_bridge` handles the resample).
- **Whisper is slow** — switch `WHISPER_MODEL=tiny.en` or put
  `WHISPER_DEVICE=cuda` if the box has a GPU. The first
  transcription after startup is always slower (model warmup).
- **`FLOOD_WAIT_X` on /call** — Telegram's antispam. Back off for X
  seconds; more than a few outbound calls per minute will trip it
  regardless of library.

## Security posture

- The `assistant.session` file *is* the credential. Anyone with a
  copy can impersonate the assistant account. Don't commit it, don't
  sync it through cloud folders, and keep the file to the current
  user only.
- `SERVICE_TOKEN` is the only thing between any process on the box
  and Santi's phone ringing. Rotate it if it leaks.
- The service binds to `127.0.0.1` by default on purpose. Don't
  change that without also putting it behind proper auth.
