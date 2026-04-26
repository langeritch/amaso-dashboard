"""
Faster-Whisper wrapper. Takes raw audio frames from pytgcalls'
RecordStream callback, downmixes stereo to mono, resamples to 16 kHz,
and segments utterances at 2 s silence boundaries.

IMPORTANT — pytgcalls format: `RecordStream(True, AudioQuality.HIGH)`
delivers **48 kHz stereo** s16le (AudioQuality.HIGH == (48000, 2)).
An earlier version of this file interpreted the interleaved L/R bytes
as mono, which effectively halved the sample rate the callers' voice
lived on: Whisper heard slowed-down, pitched-down audio and answered
with hallucinated "thank you thank you" loops — the classic
Whisper-on-garbage-audio symptom. We deinterleave to mono before
any VAD/resample work now.

We don't stream partials — private-call audio is already lossy enough
that streaming transcription adds noise without adding useful
interactivity. Whole-utterance at 2-second silence-hold is the
established pattern from pytgcalls' own Whisper example and it works
well at conversational pace.
"""

from __future__ import annotations

import json
import logging
import os
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np
import soxr
from faster_whisper import WhisperModel


log = logging.getLogger("telegram-voice.stt")


TELEGRAM_SAMPLE_RATE = 48_000
TELEGRAM_CHANNELS = 2  # AudioQuality.HIGH → (48000, 2). Change if the
#                        RecordStream quality setting in service.py changes.
WHISPER_SAMPLE_RATE = 16_000

# ~60 dBFS below full-scale s16 amplitude. Anything quieter than this
# counts as silence for utterance segmentation. Tuned against Telegram
# call audio — it's noisier than local mic audio so a higher floor
# than you'd use for local VAD.
_SILENCE_RMS = 120.0
_SILENCE_HOLD_S = 2.0
_MAX_UTTERANCE_S = 20.0


def _debug_save_enabled() -> bool:
    """
    Debug audio capture defaults to OFF. The stereo-to-mono pipeline
    is now confirmed-good, so the per-chunk WAV dumps are no longer
    earning their disk cost for every call. Set
    `DEBUG_SAVE_AUDIO=true` / `1` / `on` / `yes` to re-enable when
    investigating a regression.
    """
    raw = os.environ.get("DEBUG_SAVE_AUDIO", "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _debug_audio_root() -> Path:
    override = os.environ.get("DEBUG_AUDIO_DIR", "").strip()
    if override:
        return Path(override)
    # Default: <repo>/logs/debug-audio. stt_bridge.py lives at
    # <repo>/telegram-voice/stt_bridge.py, so ../logs is the right anchor.
    return Path(__file__).resolve().parent.parent / "logs" / "debug-audio"


def _write_int16_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    """Write a mono int16 numpy array to a WAV file. Used only by the
    debug-capture path — the live transcription pipeline never touches
    disk."""
    if samples.dtype != np.int16:
        samples = samples.astype(np.int16, copy=False)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(samples.tobytes())


def _write_int16_wav_multichannel(
    path: Path, samples: np.ndarray, sample_rate: int
) -> None:
    """Write a (frames, channels) int16 array to a WAV. `wave` expects
    channels interleaved in the byte buffer — numpy row-major layout of
    a `(frames, channels)` array matches exactly when we .tobytes()."""
    if samples.ndim != 2:
        raise ValueError("multichannel writer needs a (frames, channels) array")
    if samples.dtype != np.int16:
        samples = samples.astype(np.int16, copy=False)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(int(samples.shape[1]))
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(samples.tobytes())


@dataclass
class Utterance:
    started_at: float             # monotonic — first voiced frame of this utterance
    text: str
    # Timing metadata carried through to service.py so the
    # per-turn PIPELINE latency line can break down end-to-end
    # response time into stages. All clock values are
    # time.monotonic() seconds; *_ms fields are convenience.
    end_of_speech_at: float = 0.0  # when silence-hold fired (caller done)
    audio_duration_s: float = 0.0  # raw 48 kHz mono utterance length
    silence_hold_s: float = 0.0    # quiet gap before we flushed
    whisper_ms: float = 0.0        # faster-whisper transcribe wall-clock


class WhisperSTT:
    def __init__(self) -> None:
        model_name = os.environ.get("WHISPER_MODEL", "small.en")
        device = os.environ.get("WHISPER_DEVICE", "auto")
        compute_type = "int8_float16" if device == "cuda" else "int8"
        self._model = WhisperModel(model_name, device=device, compute_type=compute_type)
        self._buffer: list[np.ndarray] = []
        self._started_at: float | None = None
        self._last_voice_at: float | None = None

        # Debug audio capture — per-process state so every run goes to
        # its own subdirectory. We don't rotate per call because reset()
        # is also called between turns and we want the full call in one
        # folder to make it easy to listen through.
        self._debug_session_dir: Path | None = None
        self._debug_chunk_n = 0
        self._debug_utt_n = 0
        if _debug_save_enabled():
            try:
                root = _debug_audio_root()
                stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
                self._debug_session_dir = root / f"session-{stamp}-{os.getpid()}"
                self._debug_session_dir.mkdir(parents=True, exist_ok=True)
                log.info(
                    "debug audio capture ON — writing to %s "
                    "(disable with DEBUG_SAVE_AUDIO=false)",
                    self._debug_session_dir,
                )
            except Exception:
                log.exception("failed to prepare debug audio dir")
                self._debug_session_dir = None

        log.info(
            "WhisperSTT ready: model=%s device=%s compute=%s "
            "input_format=%dHz %dch s16le → whisper=%dHz mono float32 "
            "silence_rms=%.0f silence_hold_s=%.1f max_utterance_s=%.1f",
            model_name,
            device,
            compute_type,
            TELEGRAM_SAMPLE_RATE,
            TELEGRAM_CHANNELS,
            WHISPER_SAMPLE_RATE,
            _SILENCE_RMS,
            _SILENCE_HOLD_S,
            _MAX_UTTERANCE_S,
        )

    def feed(self, pcm_s16le: bytes) -> Iterator[Utterance]:
        """
        Push one chunk of raw audio from the pytgcalls frame callback.

        Expected input: s16le, TELEGRAM_SAMPLE_RATE Hz, TELEGRAM_CHANNELS
        channels interleaved. For AudioQuality.HIGH that's 48 kHz stereo,
        i.e. 4 bytes per frame-pair. We deinterleave to mono here before
        anything else looks at the samples.

        Yields zero or more complete utterances — usually zero,
        occasionally one when the caller finishes speaking.
        """
        if not pcm_s16le:
            return

        interleaved = np.frombuffer(pcm_s16le, dtype=np.int16)
        n_bytes = len(pcm_s16le)

        # Downmix to mono. For stereo we average L+R as float to avoid
        # s16 overflow, then round back. For mono (e.g. if the quality
        # setting ever drops to MEDIUM/LOW) this is a pass-through.
        if TELEGRAM_CHANNELS == 1:
            mono = interleaved
            raw_stereo: np.ndarray | None = None
        else:
            # Clip to a multiple of channels — a trailing odd sample
            # would mis-align every subsequent frame. pytgcalls gives
            # us whole frames in practice, but the guard is cheap.
            usable = (interleaved.size // TELEGRAM_CHANNELS) * TELEGRAM_CHANNELS
            if usable != interleaved.size:
                log.warning(
                    "feed: dropping %d trailing samples to align to %d-channel frame",
                    interleaved.size - usable,
                    TELEGRAM_CHANNELS,
                )
                interleaved = interleaved[:usable]
            raw_stereo = interleaved.reshape(-1, TELEGRAM_CHANNELS)
            mono = raw_stereo.mean(axis=1).astype(np.int16, copy=False)

        now = time.monotonic()
        rms = (
            float(np.sqrt(np.mean(mono.astype(np.float32) ** 2)))
            if mono.size
            else 0.0
        )
        peak = int(np.abs(mono).max()) if mono.size else 0
        voiced = rms > _SILENCE_RMS

        # Chunk log. At ~5 batches/s this is chatty but invaluable while
        # diagnosing; drop to DEBUG once the pipeline is stable again.
        log.info(
            "chunk #%d: bytes=%d interleaved_samples=%d mono_samples=%d "
            "dur=%.3fs rms=%.1f peak=%d voiced=%s",
            self._debug_chunk_n,
            n_bytes,
            interleaved.size,
            mono.size,
            mono.size / TELEGRAM_SAMPLE_RATE if mono.size else 0.0,
            rms,
            peak,
            voiced,
        )

        # Debug: dump every raw chunk BEFORE any gating, so we can hear
        # exactly what pytgcalls delivered — including the silent tails
        # and the frames the VAD rejected. We save both the stereo
        # original (to confirm pytgcalls is really giving us stereo)
        # and the mono downmix that actually feeds Whisper.
        if self._debug_session_dir is not None:
            self._debug_write_chunk(mono, raw_stereo, rms=rms, peak=peak, voiced=voiced)

        if voiced:
            if self._started_at is None:
                self._started_at = now
            self._last_voice_at = now
            self._buffer.append(mono)
        elif self._buffer:
            # Still include this silent tail — Whisper segments better
            # when utterances have a little trailing air.
            self._buffer.append(mono)

        if not self._buffer or self._started_at is None:
            return

        elapsed = now - self._started_at
        quiet_for = now - (self._last_voice_at or self._started_at)
        if quiet_for >= _SILENCE_HOLD_S or elapsed >= _MAX_UTTERANCE_S:
            utterance = self._flush()
            if utterance is not None:
                yield utterance

    def _flush(self) -> Utterance | None:
        # Pin "end of speech" at the very top — this is the clock
        # anchor the downstream PIPELINE log measures latency from.
        end_of_speech_at = time.monotonic()
        if not self._buffer or self._started_at is None:
            self._reset()
            return None

        started_at = self._started_at
        last_voice_at = self._last_voice_at or started_at
        silence_hold_s = max(0.0, end_of_speech_at - last_voice_at)
        samples = np.concatenate(self._buffer)
        self._reset()

        buf_rms = (
            float(np.sqrt(np.mean(samples.astype(np.float32) ** 2)))
            if samples.size
            else 0.0
        )
        buf_peak = int(np.abs(samples).max()) if samples.size else 0
        buf_dur_s = samples.size / TELEGRAM_SAMPLE_RATE if samples.size else 0.0
        log.info(
            "flush: buffered %d samples (%.2fs @ %d Hz mono) rms=%.1f peak=%d",
            samples.size,
            buf_dur_s,
            TELEGRAM_SAMPLE_RATE,
            buf_rms,
            buf_peak,
        )

        # Down to 16 kHz float32 in [-1, 1] — Whisper's native format.
        resample_t0 = time.monotonic()
        resampled = soxr.resample(
            samples.astype(np.float32) / 32768.0,
            TELEGRAM_SAMPLE_RATE,
            WHISPER_SAMPLE_RATE,
        )
        resample_dt = time.monotonic() - resample_t0
        rs_peak = float(np.abs(resampled).max()) if resampled.size else 0.0
        rs_rms = (
            float(np.sqrt(np.mean(resampled.astype(np.float32) ** 2)))
            if resampled.size
            else 0.0
        )
        log.info(
            "flush: resample %d→%d Hz via soxr in %.3fs "
            "(out_samples=%d, %.2fs, rms=%.4f, peak=%.4f)",
            TELEGRAM_SAMPLE_RATE,
            WHISPER_SAMPLE_RATE,
            resample_dt,
            resampled.size,
            resampled.size / WHISPER_SAMPLE_RATE if resampled.size else 0.0,
            rs_rms,
            rs_peak,
        )

        # Debug: save both the assembled mono 48 kHz buffer AND the
        # 16 kHz resampled version that Whisper actually sees. If they
        # sound different, the issue is in the resample step; otherwise
        # listen to the 48 kHz to judge what Telegram handed us.
        if self._debug_session_dir is not None:
            self._debug_write_utterance(samples, resampled)

        # Whisper needs at least ~0.5 s of audio to produce anything
        # useful. Shorter clips routinely trigger training-set
        # hallucinations ("thank you.", "Thanks for watching!"). Bail
        # loudly rather than letting those reach the dashboard.
        if resampled.size < WHISPER_SAMPLE_RATE // 2:
            log.warning(
                "flush: utterance too short for Whisper (%.2fs < 0.5s) — dropping",
                resampled.size / WHISPER_SAMPLE_RATE,
            )
            return None

        # Skip Whisper's built-in Silero VAD. We already gate which
        # frames enter the buffer by RMS above, so running another VAD
        # on top was double-filtering — in practice it was removing
        # 100 % of the buffered audio on every Telegram call, which is
        # why the caller heard nothing back. If Whisper decides the
        # audio truly has no speech content it returns zero segments
        # and we yield nothing; that's the correct fallback without
        # the VAD throwing real speech away.
        whisper_t0 = time.monotonic()
        segments, _info = self._model.transcribe(
            resampled,
            language="en",
            vad_filter=False,
            beam_size=1,
        )
        segments_list = list(segments)
        whisper_ms = (time.monotonic() - whisper_t0) * 1000.0
        text = " ".join(s.text.strip() for s in segments_list).strip()
        log.info(
            "flush: whisper transcribe in %.3fs → %d segments, %d chars: %r",
            whisper_ms / 1000.0,
            len(segments_list),
            len(text),
            text[:120],
        )
        if not text:
            return None
        return Utterance(
            started_at=started_at,
            text=text,
            end_of_speech_at=end_of_speech_at,
            audio_duration_s=buf_dur_s,
            silence_hold_s=silence_hold_s,
            whisper_ms=whisper_ms,
        )

    # ---- Debug capture -------------------------------------------------

    def _debug_write_chunk(
        self,
        mono: np.ndarray,
        raw_stereo: np.ndarray | None,
        *,
        rms: float,
        peak: int,
        voiced: bool,
    ) -> None:
        if self._debug_session_dir is None:
            return
        try:
            n = self._debug_chunk_n
            self._debug_chunk_n += 1
            stem = f"chunk-{n:06d}"

            mono_path = self._debug_session_dir / f"{stem}-raw-48k-mono.wav"
            _write_int16_wav(mono_path, mono, TELEGRAM_SAMPLE_RATE)

            stereo_path: Path | None = None
            stereo_meta: dict | None = None
            if raw_stereo is not None:
                stereo_path = self._debug_session_dir / f"{stem}-raw-48k-stereo.wav"
                _write_int16_wav_multichannel(
                    stereo_path, raw_stereo, TELEGRAM_SAMPLE_RATE
                )
                l = raw_stereo[:, 0].astype(np.float32)
                r = raw_stereo[:, 1].astype(np.float32)
                l_rms = float(np.sqrt(np.mean(l * l))) if l.size else 0.0
                r_rms = float(np.sqrt(np.mean(r * r))) if r.size else 0.0
                stereo_meta = {
                    "path": stereo_path.name,
                    "channels": int(raw_stereo.shape[1]),
                    "frames": int(raw_stereo.shape[0]),
                    "l_rms": l_rms,
                    "r_rms": r_rms,
                    # If one channel is silent the caller's voice is
                    # panned hard — useful signal when triaging.
                    "l_peak_abs": int(np.abs(raw_stereo[:, 0]).max())
                    if raw_stereo.size
                    else 0,
                    "r_peak_abs": int(np.abs(raw_stereo[:, 1]).max())
                    if raw_stereo.size
                    else 0,
                }

            meta = {
                "kind": "chunk",
                "index": n,
                "wall_clock": time.time(),
                "monotonic": time.monotonic(),
                "source_format": {
                    "sample_rate": TELEGRAM_SAMPLE_RATE,
                    "channels": TELEGRAM_CHANNELS,
                    "bit_depth": 16,
                    "encoding": "PCM_S16LE (interleaved)",
                },
                "mono_downmix": {
                    "path": mono_path.name,
                    "sample_rate": TELEGRAM_SAMPLE_RATE,
                    "channels": 1,
                    "samples": int(mono.size),
                    "duration_s": float(mono.size) / TELEGRAM_SAMPLE_RATE
                    if mono.size
                    else 0.0,
                    "rms": rms,
                    "peak_abs": peak,
                    "voiced": voiced,
                    "silence_rms_threshold": _SILENCE_RMS,
                },
                "stereo_raw": stereo_meta,
            }
            (self._debug_session_dir / f"{stem}.json").write_text(
                json.dumps(meta, indent=2)
            )
        except Exception:
            log.exception("debug chunk write failed")

    def _debug_write_utterance(
        self, samples_48k_mono: np.ndarray, resampled_16k: np.ndarray
    ) -> None:
        if self._debug_session_dir is None:
            return
        try:
            n = self._debug_utt_n
            self._debug_utt_n += 1
            stem = f"utterance-{n:04d}"
            raw_path = self._debug_session_dir / f"{stem}-raw-48k.wav"
            whisper_path = self._debug_session_dir / f"{stem}-resampled-16k.wav"

            _write_int16_wav(raw_path, samples_48k_mono, TELEGRAM_SAMPLE_RATE)
            # resampled is float32 in [-1, 1]; clip then back to s16 for
            # playback. Whisper itself consumes the float array, so the
            # s16 copy here is purely for listening.
            clipped = np.clip(resampled_16k, -1.0, 1.0)
            s16_resampled = (clipped * 32767.0).astype(np.int16)
            _write_int16_wav(whisper_path, s16_resampled, WHISPER_SAMPLE_RATE)

            rms_48 = (
                float(np.sqrt(np.mean(samples_48k_mono.astype(np.float32) ** 2)))
                if samples_48k_mono.size
                else 0.0
            )
            peak_48 = int(np.abs(samples_48k_mono).max()) if samples_48k_mono.size else 0
            rms_16 = (
                float(np.sqrt(np.mean(resampled_16k.astype(np.float32) ** 2)))
                if resampled_16k.size
                else 0.0
            )
            peak_16 = float(np.abs(resampled_16k).max()) if resampled_16k.size else 0.0
            meta = {
                "kind": "utterance",
                "index": n,
                "wall_clock": time.time(),
                "monotonic": time.monotonic(),
                "started_at_monotonic": self._started_at,
                "raw_48k_mono": {
                    "path": raw_path.name,
                    "sample_rate": TELEGRAM_SAMPLE_RATE,
                    "format": "PCM_S16LE",
                    "channels": 1,
                    "samples": int(samples_48k_mono.size),
                    "duration_s": float(samples_48k_mono.size) / TELEGRAM_SAMPLE_RATE
                    if samples_48k_mono.size
                    else 0.0,
                    "rms": rms_48,
                    "peak_abs": peak_48,
                },
                "to_whisper_16k": {
                    "path": whisper_path.name,
                    "sample_rate": WHISPER_SAMPLE_RATE,
                    "format_on_disk": "PCM_S16LE (from float32 [-1,1])",
                    "format_to_whisper": "float32 mono [-1, 1]",
                    "channels": 1,
                    "samples": int(resampled_16k.size),
                    "duration_s": float(resampled_16k.size) / WHISPER_SAMPLE_RATE
                    if resampled_16k.size
                    else 0.0,
                    "rms_float": rms_16,
                    "peak_float_abs": peak_16,
                },
            }
            (self._debug_session_dir / f"{stem}.json").write_text(
                json.dumps(meta, indent=2)
            )
        except Exception:
            log.exception("debug utterance write failed")

    def _reset(self) -> None:
        self._buffer.clear()
        self._started_at = None
        self._last_voice_at = None

    def reset(self) -> None:
        """Public reset. Called between conversation turns so the
        caller's next utterance doesn't include tail samples from the
        previous one (or from our own TTS playback leaking back in)."""
        self._reset()
