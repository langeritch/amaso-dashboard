"""Render the demo-mode voiceover to public/demo/walkthrough.mp3.

Run with the Kokoro venv:
  "C:/Users/santi/tools/tts/venv/Scripts/python.exe" scripts/generate_voiceover.py

Each caption in `lib/demo/script.ts` is synthesised once and pasted into a
single 34-second silent track at the sample offset that matches the
caption's `atMs`. We don't try to match the tour's duration by speeding
up speech — if a line runs over into the next caption's slot, they
overlap and we let the mix ride. Peak-normalise to 0.95 before export
so the final MP3 isn't clipped by ffmpeg.

The caption list below is hand-mirrored from lib/demo/script.ts. If you
adjust the tour there, update this table too — it's the only thing to
edit here.
"""

import os
import subprocess
import sys
import tempfile
from pathlib import Path

# ── Windows CUDA loader shim ───────────────────────────────────────────
# Lifted verbatim from scripts/kokoro_server.py: onnxruntime-gpu needs
# the nvidia-* pip shared libraries on PATH (and registered as DLL
# directories) before ORT imports, otherwise ORT silently refuses the
# CUDA EP and sometimes crashes on model load. No-op when the CPU build
# is installed.
_nvidia_root = os.path.normpath(
    os.path.join(
        os.path.dirname(sys.executable),
        "..",
        "Lib",
        "site-packages",
        "nvidia",
    )
)
if os.path.isdir(_nvidia_root):
    _nv_bins = [
        os.path.join(_nvidia_root, d, "bin")
        for d in sorted(os.listdir(_nvidia_root))
        if os.path.isdir(os.path.join(_nvidia_root, d, "bin"))
    ]
    if _nv_bins:
        os.environ["PATH"] = (
            os.pathsep.join(_nv_bins) + os.pathsep + os.environ.get("PATH", "")
        )
        for _b in _nv_bins:
            try:
                os.add_dll_directory(_b)  # type: ignore[attr-defined]
            except (OSError, AttributeError):
                pass

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro


# ── Config ────────────────────────────────────────────────────────────

MODEL_PATH = r"C:\Users\santi\tools\tts\models\kokoro-v1.0.onnx"
VOICES_PATH = r"C:\Users\santi\tools\tts\models\voices-v1.0.bin"
VOICE = "af_heart"
SPEED = 1.0
LANG = "en-us"
SAMPLE_RATE = 24000
TOTAL_MS = 34000

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "public" / "demo"
OUT_MP3 = OUT_DIR / "walkthrough.mp3"

# Mirrors the `caption` values + `atMs` offsets in lib/demo/script.ts.
CAPTIONS: list[tuple[int, str]] = [
    (0,     "Welcome to Amaso — let's sign you in."),
    (2000,  "Each team member has a secure account."),
    (5800,  "One click — into the client portal."),
    (8000,  "This is the portal — every project, conversation, and file in one place."),
    (10500, "Clients and the team message each other per project."),
    (15800, "All active engagements, status at a glance."),
    (20500, "Every project is a live workspace — files, deploys, remarks."),
    (24000, "Clients see exactly what's live, what's staged, what's next."),
    (27500, "One dashboard. Every client. Always current."),
    (30500, "That's Amaso. Let's build yours next."),
]


def synth(kokoro: Kokoro, text: str) -> np.ndarray:
    """Render one caption → float32 mono samples @ SAMPLE_RATE."""
    samples, sr = kokoro.create(text, voice=VOICE, speed=SPEED, lang=LANG)
    if sr != SAMPLE_RATE:
        raise RuntimeError(f"Kokoro returned sr={sr}, expected {SAMPLE_RATE}")
    return np.asarray(samples, dtype=np.float32)


def mix_into(track: np.ndarray, clip: np.ndarray, offset: int) -> None:
    """Additive overlay of `clip` into `track` starting at sample `offset`.
    Clips that run past the end of `track` are truncated."""
    end = min(offset + clip.shape[0], track.shape[0])
    n = end - offset
    if n <= 0:
        return
    track[offset:end] += clip[:n]


def peak_normalize(track: np.ndarray, peak: float = 0.95) -> np.ndarray:
    p = float(np.max(np.abs(track)))
    if p < 1e-9:
        return track
    return track * (peak / p)


def write_mp3(wav_path: Path, mp3_path: Path) -> bool:
    """Return True if ffmpeg succeeds. False to fall back to WAV."""
    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(wav_path),
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "128k",
                str(mp3_path),
            ],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return True
        print("ffmpeg failed:", result.stderr[-400:], file=sys.stderr)
        return False
    except FileNotFoundError:
        print("ffmpeg not found on PATH — falling back to WAV", file=sys.stderr)
        return False


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Loading Kokoro from {MODEL_PATH}")
    kokoro = Kokoro(MODEL_PATH, VOICES_PATH)

    total_samples = int(TOTAL_MS / 1000 * SAMPLE_RATE)
    track = np.zeros(total_samples, dtype=np.float32)

    for at_ms, caption in CAPTIONS:
        offset = int(at_ms / 1000 * SAMPLE_RATE)
        print(f"  [{at_ms:>5}ms] {caption}")
        clip = synth(kokoro, caption)
        mix_into(track, clip, offset)

    track = peak_normalize(track, 0.95)

    # Write an intermediate WAV, then transcode to MP3 via ffmpeg.
    with tempfile.TemporaryDirectory() as td:
        tmp_wav = Path(td) / "walkthrough.wav"
        sf.write(str(tmp_wav), track, SAMPLE_RATE, subtype="PCM_16")

        if write_mp3(tmp_wav, OUT_MP3):
            print(f"Wrote {OUT_MP3}")
        else:
            # Fall back to keeping the WAV at the mp3 path's folder.
            fallback = OUT_MP3.with_suffix(".wav")
            import shutil
            shutil.copy2(tmp_wav, fallback)
            print(f"Wrote fallback {fallback}", file=sys.stderr)
            return 1

    size = OUT_MP3.stat().st_size
    duration_s = total_samples / SAMPLE_RATE
    print(f"Size: {size:,} bytes  Duration: {duration_s:.2f}s @ {SAMPLE_RATE}Hz")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
