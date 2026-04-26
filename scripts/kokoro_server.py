"""Long-running HTTP sidecar that serves Kokoro ONNX synthesis to the
Next.js app and the Claude Code TTS stop hook. Loaded once so the ~3 s
model load is paid a single time instead of on every request.

POST /synth     {text, voice?, speed?, lang?}  -> audio/wav
POST /shutdown                                 -> {"ok": true}  (process exits)
GET  /health                                   -> "ok"

TTS_IDLE_SECONDS > 0 enables an idle watchdog that exits the process
after that many seconds without a /synth or /health hit — useful when
the stop hook cold-starts the sidecar outside of a running dashboard.
Set to 0 (default) to keep the sidecar alive as long as the parent
process stays up.
"""

import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# CUDA DLLs for onnxruntime-gpu ship as nvidia-* pip packages (cublas,
# cudnn, cufft, curand, cusolver, cusparse, cuda-runtime, cuda-nvrtc,
# nvjitlink). ORT's providers_cuda.dll resolves them via the standard
# Windows loader, which honours PATH but not add_dll_directory, so we
# prepend all nvidia/<pkg>/bin dirs to PATH before importing ORT. When
# onnxruntime-gpu isn't installed this block is a no-op (no nvidia pkg
# dirs exist) and we fall through to CPU.
_nvidia_root = os.path.join(os.path.dirname(sys.executable), "..", "Lib", "site-packages", "nvidia")
_nvidia_root = os.path.normpath(_nvidia_root)
if os.path.isdir(_nvidia_root):
    _nv_bins = [
        os.path.join(_nvidia_root, d, "bin")
        for d in sorted(os.listdir(_nvidia_root))
        if os.path.isdir(os.path.join(_nvidia_root, d, "bin"))
    ]
    if _nv_bins:
        os.environ["PATH"] = os.pathsep.join(_nv_bins) + os.pathsep + os.environ.get("PATH", "")
        for _b in _nv_bins:
            try:
                os.add_dll_directory(_b)
            except (OSError, AttributeError):
                pass

# Default to the FP32 model — on this hardware it was the fastest
# combination we found:
#   FP32 + CUDA (RTX 3060, onnxruntime-gpu + nvidia-* pip pkgs): ~1.5s
#   FP32 + CPU  (intra=8, default ORT options):                  ~6.2s
#   INT8 + CPU  (kokoro-onnx's naive dynamic quant):             ~18s
#   FP16 + CPU  (no AVX-512 FP16, upconverts to FP32):           ~6.0s
#   *  + DML    (Kokoro's ConvTranspose crashes the DML kernel)   FAIL
# Override with TTS_MODEL if you have a different variant on disk.
_FP32 = "C:/Users/santi/tools/tts/models/kokoro-v1.0.onnx"
MODEL = os.environ.get("TTS_MODEL") or _FP32
VOICES = os.environ.get("TTS_VOICES", "C:/Users/santi/tools/tts/models/voices-v1.0.bin")
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "af_heart")
DEFAULT_SPEED = float(os.environ.get("TTS_SPEED", "1.0"))
DEFAULT_LANG = os.environ.get("TTS_LANG", "en-us")
PORT = int(os.environ.get("TTS_PORT", "3939"))
IDLE_SECONDS = int(os.environ.get("TTS_IDLE_SECONDS", "0"))

_last_activity = time.time()
_activity_lock = threading.Lock()


def _mark_activity():
    global _last_activity
    with _activity_lock:
        _last_activity = time.time()

print(f"[kokoro] loading model: {MODEL}", flush=True)
import onnxruntime as rt
from kokoro_onnx import Kokoro
import soundfile as sf

# Build the ORT session ourselves. Two knobs matter:
#   (a) Prefer CUDA if onnxruntime-gpu is installed and the nvidia pip
#       packages loaded cleanly (PATH setup at the top of this file).
#       Fall back to CPU if CUDA session init throws — driver/toolkit
#       version mismatches are caught at InferenceSession() time.
#   (b) On the CPU path, pin intra-op threads to physical-core count:
#       ORT's default of "all logical threads" causes HT contention on
#       this 16-logical-core box and regresses synth ~50%.
_cpu_count = os.cpu_count() or 4
_intra = int(os.environ.get("TTS_INTRA_OP_THREADS", str(min(8, max(1, _cpu_count // 2)))))
_available = rt.get_available_providers()
_force_cpu = bool(os.environ.get("TTS_FORCE_CPU"))
_want_cuda = (not _force_cpu) and ("CUDAExecutionProvider" in _available)


def _build_session(providers: list) -> rt.InferenceSession:
    so = rt.SessionOptions()
    so.intra_op_num_threads = _intra
    return rt.InferenceSession(MODEL, sess_options=so, providers=providers)


_session = None
if _want_cuda:
    try:
        _session = _build_session(["CUDAExecutionProvider", "CPUExecutionProvider"])
        if "CUDAExecutionProvider" not in _session.get_providers():
            # ORT silently dropped CUDA (missing cuDNN, driver mismatch,
            # etc). Rebuild with CPU only so we don't carry a useless
            # CUDA allocator around.
            _session = None
    except Exception as e:
        print(f"[kokoro] CUDA session init failed, falling back to CPU: {e}", flush=True)
        _session = None
if _session is None:
    _session = _build_session(["CPUExecutionProvider"])

print(
    f"[kokoro] ORT: providers={_session.get_providers()} intra={_intra} "
    f"model={os.path.basename(MODEL)}",
    flush=True,
)

kokoro = Kokoro.from_session(_session, VOICES)
# Kokoro's ORT session is not thread-safe under concurrent inference; serialize.
synth_lock = threading.Lock()

# Warm up the graph so the first real request doesn't pay the
# one-time ORT-kernel compilation tax. A few words is enough to
# exercise every op; discard the output.
try:
    kokoro.create("warmup", voice=DEFAULT_VOICE, speed=DEFAULT_SPEED, lang=DEFAULT_LANG)
    print("[kokoro] warmup ok", flush=True)
except Exception as e:
    print(f"[kokoro] warmup failed: {e}", flush=True)

print(f"[kokoro] ready on 127.0.0.1:{PORT} voice={DEFAULT_VOICE} speed={DEFAULT_SPEED}", flush=True)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[kokoro] {self.address_string()} {fmt % args}\n")

    def do_GET(self):
        if self.path == "/health":
            _mark_activity()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        self.send_error(404)

    def do_POST(self):
        if self.path == "/shutdown":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            body = b'{"ok":true}'
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            print("[kokoro] shutdown requested", flush=True)
            # Let the response flush before we exit.
            threading.Thread(
                target=lambda: (time.sleep(0.1), os._exit(0)),
                daemon=True,
            ).start()
            return
        if self.path != "/synth":
            self.send_error(404)
            return
        _mark_activity()
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 64_000:
            self.send_error(400, "bad length")
            return
        try:
            data = json.loads(self.rfile.read(length))
        except Exception:
            self.send_error(400, "bad json")
            return
        text = (data.get("text") or "").strip()
        if not text:
            self.send_error(400, "empty text")
            return
        voice = data.get("voice") or DEFAULT_VOICE
        try:
            speed = float(data.get("speed") or DEFAULT_SPEED)
        except (TypeError, ValueError):
            speed = DEFAULT_SPEED
        lang = data.get("lang") or DEFAULT_LANG

        try:
            t0 = time.time()
            with synth_lock:
                samples, sr = kokoro.create(text, voice=voice, speed=speed, lang=lang)
            t1 = time.time()
            buf = io.BytesIO()
            sf.write(buf, samples, sr, format="WAV")
            wav = buf.getvalue()
            t2 = time.time()
            audio_s = len(samples) / sr if sr else 0
            synth_ms = (t1 - t0) * 1000
            encode_ms = (t2 - t1) * 1000
            rtf = (t1 - t0) / audio_s if audio_s > 0 else 0
            sys.stderr.write(
                f"[kokoro] synth chars={len(text)} audio={audio_s:.2f}s "
                f"synth={synth_ms:.0f}ms encode={encode_ms:.0f}ms RTF={rtf:.2f}\n"
            )
        except Exception as e:
            msg = f"synth failed: {type(e).__name__}: {e}"
            sys.stderr.write(f"[kokoro] {msg}\n")
            self.send_error(500, msg)
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(wav)
        except (BrokenPipeError, ConnectionResetError):
            pass


def _idle_watchdog():
    while True:
        time.sleep(30)
        with _activity_lock:
            idle = time.time() - _last_activity
        if idle >= IDLE_SECONDS:
            print(f"[kokoro] idle for {idle:.0f}s — shutting down", flush=True)
            os._exit(0)


class _ExclusiveServer(ThreadingHTTPServer):
    # The stdlib default is True, which on Windows translates to
    # SO_REUSEADDR=1 — and on Windows that flag behaves like Linux's
    # SO_REUSEPORT, letting multiple processes bind the same port
    # simultaneously. Connections then get round-robined between them,
    # so a second (stale or cold) sidecar spawned by a racing
    # lib/kokoro.ts startKokoro() call silently joins the pool and
    # intermittently answers requests with 500s. Forcing reuse off
    # makes a second kokoro bind fail with WSAEADDRINUSE and exit, so
    # at steady state exactly one process owns :3939.
    allow_reuse_address = False


def main():
    if IDLE_SECONDS > 0:
        print(f"[kokoro] idle watchdog armed: {IDLE_SECONDS}s", flush=True)
        threading.Thread(target=_idle_watchdog, daemon=True).start()
    try:
        srv = _ExclusiveServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        # WinError 10048 = WSAEADDRINUSE. This is the expected failure
        # when another sidecar already owns the port; log and hard-exit
        # so the spawning parent doesn't treat it as a crash.
        #
        # os._exit (not sys.exit) because by the time we reach main(),
        # ORT has already loaded the model — which spawns long-lived
        # non-daemon background threads that keep the interpreter alive
        # past sys.exit. os._exit bypasses thread-join and finalisers so
        # the duplicate vanishes immediately, leaving exactly one
        # process owning :3939.
        print(
            f"[kokoro] port {PORT} already in use — another sidecar is live "
            f"({type(e).__name__}: {e}). Exiting.",
            flush=True,
        )
        os._exit(0)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
