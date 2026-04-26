// macOS system audio ducking.
//
// macOS doesn't expose per-application volume to userspace scripts without
// private CoreAudio APIs and an unsigned entitlement, so we do the next-best
// thing: lower system output volume while we're speaking, and restore the
// previous level when we stop. The user's own audio from the dashboard
// (which plays through this app) comes out of the same mixer, so we keep
// our own level normal by cranking app volume relative to system.
//
// Call flow:
//   duckOthers(0.25) — remembers current system volume, sets it to 25%.
//   restoreOthers()  — sets it back to the remembered value.
//
// If two ducks arrive back-to-back we keep the original pre-duck level so
// rapid start/stop cycles don't drift.
//
// On non-Darwin platforms these functions resolve quickly with no effect —
// the whole Electron build is Mac-only, but this keeps `electron-builder`
// happy when it walks the graph on any host OS.

const { execFile } = require("node:child_process");

let originalVolume = null;
let duckDepth = 0;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout).trim());
    });
  });
}

async function readVolume() {
  // output volume is an int 0..100 in AppleScript.
  const out = await run("osascript", [
    "-e",
    "output volume of (get volume settings)",
  ]);
  const n = Number.parseInt(out, 10);
  return Number.isFinite(n) ? n : null;
}

async function writeVolume(level100) {
  const clamped = Math.max(0, Math.min(100, Math.round(level100)));
  await run("osascript", ["-e", `set volume output volume ${clamped}`]);
}

async function duckOthers(level) {
  if (process.platform !== "darwin") return;
  const fraction = typeof level === "number" ? level : 0.25;

  if (duckDepth === 0) {
    try {
      originalVolume = await readVolume();
    } catch {
      originalVolume = null;
    }
  }
  duckDepth += 1;

  if (originalVolume == null) return;
  const target = Math.round(originalVolume * fraction);
  await writeVolume(target);
}

async function restoreOthers() {
  if (process.platform !== "darwin") return;
  if (duckDepth > 0) duckDepth -= 1;
  if (duckDepth > 0) return; // Still ducking for another caller.

  if (originalVolume == null) return;
  try {
    await writeVolume(originalVolume);
  } finally {
    originalVolume = null;
  }
}

module.exports = { duckOthers, restoreOthers };
