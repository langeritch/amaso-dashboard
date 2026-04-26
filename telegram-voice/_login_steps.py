"""
Two-phase login helper the operator (or Claude) can drive across
separate invocations, so the verification-code wait doesn't have to
tie up a terminal.

    python _login_steps.py send
        Connects, asks Telegram to send the SMS/Telegram code,
        prints PHONE_CODE_HASH=... so we can feed it back in step 2.

    python _login_steps.py confirm <code> [2fa_password]
        Connects, signs in with the code. If 2FA is on and no
        password was passed, prints NEED_PASSWORD and exits 2 so
        the caller knows to re-invoke with one.

Both steps share the same Pyrogram session file (assistant.session).
Pyrogram persists MTProto auth keys after `connect()`, so the hash
from step 1 stays valid for step 2 even across a disconnect. The
session only becomes a *user* session after a successful sign_in —
that's when login.py's "you're signed in" moment lands.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from pyrogram import Client
from pyrogram.errors import SessionPasswordNeeded


HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")


def _client() -> Client:
    return Client(
        name=os.environ.get("SESSION_NAME", "assistant"),
        api_id=int(os.environ["TELEGRAM_API_ID"]),
        api_hash=os.environ["TELEGRAM_API_HASH"],
        workdir=str(HERE),
    )


async def send() -> None:
    phone = os.environ["ASSISTANT_PHONE"]
    app = _client()
    await app.connect()
    try:
        sent = await app.send_code(phone)
    finally:
        await app.disconnect()
    print(f"PHONE_CODE_HASH={sent.phone_code_hash}")
    print(f"TYPE={sent.type.name}")


async def confirm(code: str, password: str | None) -> None:
    phone = os.environ["ASSISTANT_PHONE"]
    hash_file = HERE / ".login_hash.txt"
    if not hash_file.exists():
        print("ERROR: .login_hash.txt not found — run `send` first", file=sys.stderr)
        sys.exit(2)
    phone_code_hash = hash_file.read_text(encoding="utf-8").strip()

    app = _client()
    await app.connect()
    try:
        try:
            await app.sign_in(phone, phone_code_hash, code)
        except SessionPasswordNeeded:
            if not password:
                print("NEED_PASSWORD")
                sys.exit(3)
            await app.check_password(password)
        me = await app.get_me()
        username = f" @{me.username}" if me.username else ""
        print(f"OK id={me.id} name={me.first_name!r}{username}")
    finally:
        await app.disconnect()

    # Clean up — the hash file is single-use; leaving it around would
    # confuse a future re-login.
    hash_file.unlink(missing_ok=True)


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    cmd = sys.argv[1]
    if cmd == "send":
        asyncio.run(send())
    elif cmd == "confirm":
        if len(sys.argv) < 3:
            print("usage: confirm <code> [password]", file=sys.stderr)
            sys.exit(2)
        code = sys.argv[2]
        password = sys.argv[3] if len(sys.argv) > 3 else None
        asyncio.run(confirm(code, password))
    else:
        print(f"unknown command: {cmd}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
