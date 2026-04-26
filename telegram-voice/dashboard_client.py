"""
Thin async HTTP client for talking to the Node dashboard from the
Python telegram-voice service.

There's already inline httpx-using code in service.py for the small
set of dashboard pings we need (acquire / release / respond). This
module exists for the YouTube-state surface specifically: it's read
and written from BOTH service.py (call lifecycle) and
filler_manager.py (per-tick position reports during YT playback),
and a centralised module avoids duplicating the auth/URL plumbing.

Auth model: matches the existing /api/telegram/acquire pattern —
SERVICE_TOKEN env var goes out as the X-Auth header. The Node side
resolves the userId (env override or first admin) so callers don't
have to know it.

All functions are best-effort: a failed dashboard call returns None
or False, never raises out to the audio loop. The filler manager's
fallback path (news / hum) handles the "we couldn't fetch state"
case the same way it handles "no video selected".
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Optional

import httpx

log = logging.getLogger(__name__)

# Slightly longer than _notify_dashboard_acquired's 5s — these calls
# may be made during a live audio loop, but they're never on the hot
# path of frame delivery. 8s gives us headroom on a slow network
# without being so long that a stuck endpoint stalls the loop.
DEFAULT_TIMEOUT = 8.0


def _base_url() -> str:
    return os.environ.get(
        "AMASO_DASHBOARD_URL", "http://127.0.0.1:3737"
    ).rstrip("/")


def _token() -> str:
    return os.environ.get("SERVICE_TOKEN", "").strip()


def _headers() -> dict[str, str]:
    return {"X-Auth": _token(), "Content-Type": "application/json"}


@dataclass(frozen=True)
class YouTubeStateSnapshot:
    """
    Mirror of lib/youtube-state.ts:YouTubeState. Frozen so callers
    can't mutate fields and trust a stale read accidentally — this
    object is a SNAPSHOT at the moment of the GET, not a live view.
    """

    user_id: int
    filler_mode: str
    video_id: Optional[str]
    title: Optional[str]
    thumbnail_url: Optional[str]
    duration_sec: Optional[float]
    position_sec: float
    status: str  # "playing" | "paused" | "idle"
    active_output: str  # "dashboard" | "telegram" | "none"

    @property
    def has_selection(self) -> bool:
        return bool(self.video_id) and self.status != "idle"

    @property
    def wants_youtube(self) -> bool:
        """
        The condition for the Python YouTube branch to even attempt
        playback: filler-mode is "youtube" AND a video is currently
        selected. Any other state means the news/hum fallback owns
        this call.
        """
        return self.filler_mode == "youtube" and self.has_selection


async def fetch_state() -> Optional[YouTubeStateSnapshot]:
    """
    GET /api/telegram/youtube-state — returns the current YouTube +
    filler-mode snapshot, or None if the call failed or auth is
    missing.
    """
    if not _token():
        return None
    url = f"{_base_url()}/api/telegram/youtube-state"
    try:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.get(url, headers=_headers())
            resp.raise_for_status()
            data: Any = resp.json()
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("dashboard youtube-state read failed: %s", exc)
        return None

    yt = data.get("youtube") or {}
    try:
        return YouTubeStateSnapshot(
            user_id=int(data.get("user_id", 0)),
            filler_mode=str(data.get("filler_mode", "news")),
            video_id=yt.get("videoId"),
            title=yt.get("title"),
            thumbnail_url=yt.get("thumbnailUrl"),
            duration_sec=(
                float(yt["durationSec"])
                if isinstance(yt.get("durationSec"), (int, float))
                else None
            ),
            position_sec=float(yt.get("positionSec", 0.0) or 0.0),
            status=str(yt.get("status", "idle")),
            active_output=str(yt.get("activeOutput", "none")),
        )
    except (TypeError, ValueError) as exc:
        log.warning("dashboard youtube-state shape unexpected: %s", exc)
        return None


async def report_position(position_sec: float) -> bool:
    """
    POST /api/telegram/youtube-state action=report_position. Used by
    the YouTube playback loop while a Telegram call is the active
    output. Best-effort — a missed report just means the dashboard's
    next resume picks up a few seconds behind the true playhead.
    """
    if not _token():
        return False
    url = f"{_base_url()}/api/telegram/youtube-state"
    payload = {"action": "report_position", "position_sec": float(position_sec)}
    try:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(url, headers=_headers(), json=payload)
            resp.raise_for_status()
            return True
    except httpx.HTTPError as exc:
        # Don't log every blip — these run every few seconds and
        # transient failures are expected during dev-server restarts.
        log.debug("dashboard report_position failed: %s", exc)
        return False


async def set_active_output(output: str) -> bool:
    """
    POST set_active_output. Normally activateChannel /
    releaseChannel on the Node side handle this in lockstep with the
    call channel, but the Python service can call this directly when
    it wants to claim or release playback ownership outside of the
    formal channel transitions (e.g. signalling that the YouTube
    branch is starting before the Telegram VoIP layer is fully up).
    """
    if output not in {"dashboard", "telegram", "none"}:
        raise ValueError(f"bad output: {output!r}")
    if not _token():
        return False
    url = f"{_base_url()}/api/telegram/youtube-state"
    payload = {"action": "set_active_output", "output": output}
    try:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(url, headers=_headers(), json=payload)
            resp.raise_for_status()
            return True
    except httpx.HTTPError as exc:
        log.warning("dashboard set_active_output failed: %s", exc)
        return False


async def stop_youtube() -> bool:
    """
    POST action=stop. Called when the Python YouTube branch hits an
    unrecoverable error mid-call (deleted video, revoked URL,
    yt-dlp extraction failure) and wants the dashboard to forget
    the selection so the next refresh doesn't retry the dead id.
    """
    if not _token():
        return False
    url = f"{_base_url()}/api/telegram/youtube-state"
    try:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
            resp = await client.post(
                url, headers=_headers(), json={"action": "stop"}
            )
            resp.raise_for_status()
            return True
    except httpx.HTTPError as exc:
        log.warning("dashboard stop_youtube failed: %s", exc)
        return False
