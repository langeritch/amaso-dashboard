"""
Long-running login daemon. One process keeps the MTProto session hot
for the entire window between send_code and sign_in, so the hash
stays valid while we wait on the human for the verification code.

Flow:
    1. Connect. Call send_code.
    2. Write .login_status.json = {"stage": "waiting_for_code"}.
    3. Poll .login_code.txt once a second. When it appears, read it,
       delete it, call sign_in.
    4. If 2FA kicks in, write {"stage": "waiting_for_password"} and
       poll .login_password.txt the same way.
    5. On success, write {"stage": "ok", ...} and exit 0.

The caller (the outer Claude session) reads .login_status.json to
know when to prompt the user, and writes .login_code.txt to hand the
code back. No stdin required, no shell-piping gymnastics.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from pyrogram import Client
from pyrogram.errors import (
    BadRequest,
    PasswordHashInvalid,
    SessionPasswordNeeded,
)


HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")

STATUS = HERE / ".login_status.json"
CODE_FILE = HERE / ".login_code.txt"
PASSWORD_FILE = HERE / ".login_password.txt"

POLL_INTERVAL = 1.0
# Keep the MTProto session hot for up to 30 min per prompt. Telegram
# app codes can expire in ~2 min, but once Pyrogram has the hash in
# memory we can sit on it much longer than send_code → sign_in across
# separate processes would allow.
MAX_WAIT_S = 1_800.0


def write_status(**kv: object) -> None:
    kv["ts"] = time.time()
    STATUS.write_text(json.dumps(kv), encoding="utf-8")


async def wait_for_file(path: Path) -> str:
    deadline = time.monotonic() + MAX_WAIT_S
    while time.monotonic() < deadline:
        if path.exists():
            value = path.read_text(encoding="utf-8").strip()
            path.unlink(missing_ok=True)
            return value
        await asyncio.sleep(POLL_INTERVAL)
    raise TimeoutError(f"timed out waiting for {path.name}")


async def main() -> None:
    # Clear any leftover state from a prior run so `{"stage": "ok"}`
    # can't be mistaken for "this one succeeded."
    for f in (STATUS, CODE_FILE, PASSWORD_FILE):
        f.unlink(missing_ok=True)

    phone = os.environ["ASSISTANT_PHONE"]
    app = Client(
        name=os.environ.get("SESSION_NAME", "assistant"),
        api_id=int(os.environ["TELEGRAM_API_ID"]),
        api_hash=os.environ["TELEGRAM_API_HASH"],
        workdir=str(HERE),
    )

    write_status(stage="connecting")
    await app.connect()
    try:
        write_status(stage="sending_code")
        sent = await app.send_code(phone)
        write_status(
            stage="waiting_for_code",
            phone=phone,
            delivery=sent.type.name,
        )

        code = await wait_for_file(CODE_FILE)

        try:
            await app.sign_in(phone, sent.phone_code_hash, code)
        except SessionPasswordNeeded:
            # Password file accepts multiple candidates separated by
            # newlines — handy when the human can't remember which of
            # a few passwords they set for this account. We try each
            # in order and stop on the first PasswordHashInvalid.
            while True:
                write_status(stage="waiting_for_password")
                blob = await wait_for_file(PASSWORD_FILE)
                candidates = [line for line in blob.splitlines() if line.strip()]
                if not candidates:
                    # Empty file — treat as a retry signal.
                    continue
                last_error: Exception | None = None
                for attempt in candidates:
                    try:
                        await app.check_password(attempt)
                        last_error = None
                        break
                    except PasswordHashInvalid as exc:
                        last_error = exc
                        continue
                if last_error is None:
                    break
                write_status(
                    stage="waiting_for_password",
                    error="none of the provided passwords worked — append more, one per line",
                )
        except BadRequest as exc:
            write_status(stage="error", error=f"{type(exc).__name__}: {exc}")
            raise

        me = await app.get_me()
        write_status(
            stage="ok",
            user_id=me.id,
            username=me.username or "",
            first_name=me.first_name or "",
        )
    finally:
        await app.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        write_status(stage="error", error=f"{type(exc).__name__}: {exc}")
        print(f"[login_daemon] {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
