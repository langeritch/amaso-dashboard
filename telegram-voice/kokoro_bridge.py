"""
Text → 48 kHz WAV bridge, backed by the warm Kokoro ONNX sidecar that
the dashboard already runs at http://127.0.0.1:3939/synth.

Reusing the sidecar matters:
    - The model-load cost (~3 s cold, ~1.5 s with CUDA) is paid once
      by whichever process started first. Shelling out to Kokoro from
      here would pay it again on every call.
    - The dashboard's Next.js TTS route uses the exact same endpoint
      (`POST /synth {text, voice?, speed?, lang?}`), so whatever voice
      Santi has configured there is the voice the assistant uses on
      the phone automatically.
    - If the sidecar isn't running we return a clear error instead of
      silently spawning a second copy and fighting for the model file.

Flow:
    1. POST to /synth → sidecar returns a WAV (Kokoro-native 24 kHz).
    2. Resample to 48 kHz for pytgcalls' AudioQuality.HIGH.
    3. Return the encoded WAV bytes.

The dashboard's server.ts auto-starts the sidecar on boot, so the
common path is "it's already running when we need it." If not,
TelegramVoiceUnavailable bubbles up and the /speak HTTP route
returns 503.
"""

from __future__ import annotations

import io
import json
import os
import urllib.error
import urllib.request
from typing import Final

import numpy as np
import soundfile as sf
import soxr


# The sidecar's default port is 3939 but can be overridden. Both the
# dashboard and this service read the same env var so they never
# disagree. Binding to 127.0.0.1 only — the sidecar has no auth.
_DEFAULT_PORT: Final = 3939
_ENDPOINT_ENV: Final = "TTS_PORT"

TELEGRAM_SAMPLE_RATE: Final = 48_000


class KokoroError(RuntimeError):
    """Raised when the Kokoro sidecar is down or returns bad audio."""


def _sidecar_url() -> str:
    port = int(os.environ.get(_ENDPOINT_ENV, _DEFAULT_PORT))
    return f"http://127.0.0.1:{port}"


def health_check() -> bool:
    """Quick liveness probe — service.py uses this at startup so it
    can warn early instead of failing on the first /speak."""
    try:
        with urllib.request.urlopen(
            f"{_sidecar_url()}/health", timeout=1.5
        ) as resp:
            return resp.status == 200
    except Exception:
        return False


def synthesize(
    text: str,
    voice: str | None = None,
    speed: float | None = None,
    lang: str | None = None,
) -> tuple[bytes, float]:
    """
    Render `text` through the sidecar and return
    `(wav_bytes_at_48khz, duration_seconds)`. Defaults (voice/speed/lang)
    come from the sidecar's own env config when the caller leaves them
    blank, which keeps this bridge in lockstep with the dashboard's TTS
    route.

    The duration is important for the conversation loop: pytgcalls'
    play() doesn't give us a completion callback we can easily await,
    so the service sleeps for `duration + pad` seconds before
    transitioning back to `listening`.
    """
    payload: dict[str, object] = {"text": text}
    if voice:
        payload["voice"] = voice
    if speed is not None:
        payload["speed"] = speed
    if lang:
        payload["lang"] = lang

    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{_sidecar_url()}/synth",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        # 30 s is generous — even a 4 000-char utterance synths in a
        # couple of seconds on CPU. Longer than that and something is
        # wrong with the sidecar.
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status != 200:
                raise KokoroError(f"kokoro sidecar {resp.status}")
            wav_bytes = resp.read()
    except urllib.error.URLError as exc:
        raise KokoroError(
            f"kokoro sidecar unreachable at {_sidecar_url()}: {exc}"
        ) from exc

    data, sr = sf.read(io.BytesIO(wav_bytes), dtype="int16", always_2d=False)
    if data.size == 0:
        raise KokoroError("kokoro returned 0 samples")

    if sr != TELEGRAM_SAMPLE_RATE:
        data = soxr.resample(data.astype(np.float32), sr, TELEGRAM_SAMPLE_RATE)
        data = np.clip(data, -32768, 32767).astype(np.int16)

    duration_s = len(data) / TELEGRAM_SAMPLE_RATE

    buf = io.BytesIO()
    sf.write(buf, data, TELEGRAM_SAMPLE_RATE, subtype="PCM_16", format="WAV")
    return buf.getvalue(), duration_s
