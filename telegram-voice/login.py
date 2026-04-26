"""
One-time interactive login for the assistant Telegram account.

Usage:
    python login.py

Walks you through the SMS/Telegram-code flow, drops an encrypted
Pyrogram session file in this directory, and exits. Subsequent
`service.py` runs pick it up silently — no 2FA prompts, no re-entering
codes, no re-verifying the phone number.

You only ever need to run this once per machine (or after a session
expiry, which Telegram rarely triggers for userbots that stay logged
in). If Telegram signs the session out for inactivity, delete the
*.session file and run this again.
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from pyrogram import Client


HERE = Path(__file__).resolve().parent


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        print(f"[login] missing {name} in .env", file=sys.stderr)
        sys.exit(2)
    return value


async def main() -> None:
    load_dotenv(HERE / ".env")
    api_id = int(_require("TELEGRAM_API_ID"))
    api_hash = _require("TELEGRAM_API_HASH")
    phone = _require("ASSISTANT_PHONE")
    session_name = os.environ.get("SESSION_NAME", "assistant").strip() or "assistant"

    print(f"[login] signing in as {phone}")
    print(f"[login] session file → {HERE / (session_name + '.session')}")

    # workdir pins the session file next to the service so service.py
    # finds it by name without extra path plumbing.
    async with Client(
        name=session_name,
        api_id=api_id,
        api_hash=api_hash,
        phone_number=phone,
        workdir=str(HERE),
        in_memory=False,
    ) as app:
        me = await app.get_me()
        print(
            f"[login] signed in: {me.first_name}"
            + (f" {me.last_name}" if me.last_name else "")
            + f" (@{me.username})"
            if me.username
            else ""
        )
        print(f"[login] user_id = {me.id}")
        print("[login] done. You can now `python service.py`.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[login] cancelled", file=sys.stderr)
        sys.exit(1)
