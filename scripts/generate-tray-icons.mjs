// Generates the macOS menu-bar tray icons for the Amaso Companion. No
// external deps — hand-rolled PNG encoder (same approach as
// generate-icons.mjs). Output is monochrome with alpha so macOS can
// auto-invert for light/dark menu bars whenever the filename ends in
// "Template" (Apple's template-image convention).
//
// Writes:
//   electron/assets/trayIconTemplate.png            (22x22, idle/disconnected)
//   electron/assets/trayIconTemplate@2x.png         (44x44)
//   electron/assets/trayIconConnectedTemplate.png   (22x22, connected)
//   electron/assets/trayIconConnectedTemplate@2x.png
//   electron/assets/trayIconThinkingTemplate.png    (22x22, command in flight)
//   electron/assets/trayIconThinkingTemplate@2x.png
//
// Run with: node scripts/generate-tray-icons.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, "..", "electron", "assets");
mkdirSync(ASSETS, { recursive: true });

// ---- PNG encoder (grayscale + alpha) ------------------------------------

function makeCrcTable() {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC_TABLE = makeCrcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

// Color type 4 = grayscale + alpha (2 bytes/pixel). macOS treats any fully
// black pixel as the template foreground — alpha carries the shape.
function encodePng(width, height, ga) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 4; // color type: grayscale + alpha
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 2;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    ga.subarray(y * stride, (y + 1) * stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- Drawing primitives -------------------------------------------------
//
// Buffer layout: one byte gray, one byte alpha, row-major. We always draw
// black (gray=0) and vary alpha — macOS's template rule only looks at
// alpha for the silhouette.

function makeBuf(size) {
  const buf = Buffer.alloc(size * size * 2);
  // Initial fill: transparent black.
  return buf;
}

function setAlpha(buf, size, x, y, a) {
  if (x < 0 || x >= size || y < 0 || y >= size) return;
  const i = (y * size + x) * 2;
  // Keep existing alpha if it's already higher (simple max blend so
  // overlapping strokes don't darken themselves).
  if (buf[i + 1] < a) {
    buf[i] = 0;
    buf[i + 1] = a;
  }
}

function fillCircle(buf, size, cx, cy, r, alpha = 255) {
  const r2 = r * r;
  const feather = Math.max(0.75, r * 0.12);
  const rOut2 = (r + feather) * (r + feather);
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > rOut2) continue;
      let a = alpha;
      if (d2 > r2) {
        const t = (Math.sqrt(d2) - r) / feather;
        a = Math.max(0, Math.round(alpha * (1 - t)));
      }
      setAlpha(buf, size, x, y, a);
    }
  }
}

function ringCircle(buf, size, cx, cy, rOuter, rInner, alpha = 255) {
  const feather = Math.max(0.75, rOuter * 0.1);
  const rO2 = (rOuter + feather) * (rOuter + feather);
  const rI2 = Math.max(0, rInner - feather) ** 2;
  for (let y = Math.floor(cy - rOuter - 1); y <= Math.ceil(cy + rOuter + 1); y++) {
    for (let x = Math.floor(cx - rOuter - 1); x <= Math.ceil(cx + rOuter + 1); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > rO2 || d2 < rI2) continue;
      let a = alpha;
      const d = Math.sqrt(d2);
      if (d > rOuter) {
        a = Math.max(0, Math.round(alpha * (1 - (d - rOuter) / feather)));
      } else if (d < rInner) {
        a = Math.max(0, Math.round(alpha * (1 - (rInner - d) / feather)));
      }
      setAlpha(buf, size, x, y, a);
    }
  }
}

// ---- Icon variants ------------------------------------------------------
//
// All three share a common "A" glyph (a stylised amaso mark) so the menu
// bar always reads as the same app; the right-hand status badge is what
// changes.

function drawWordmark(buf, size) {
  // Stylised A: two diagonal strokes + a crossbar, scaled to fit the left
  // ~75% of the canvas so there's room for the status badge on the right.
  const left = Math.round(size * 0.12);
  const right = Math.round(size * 0.62);
  const top = Math.round(size * 0.18);
  const bot = Math.round(size * 0.82);
  const mid = (left + right) / 2;
  const stroke = Math.max(1.5, size * 0.09);

  const drawLine = (x0, y0, x1, y1) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
    const half = stroke / 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x0 + (x1 - x0) * t;
      const py = y0 + (y1 - y0) * t;
      fillCircle(buf, size, px, py, half, 255);
    }
  };

  drawLine(mid, top, left, bot);
  drawLine(mid, top, right, bot);
  drawLine(
    mid - (mid - left) * 0.55,
    top + (bot - top) * 0.62,
    mid + (right - mid) * 0.55,
    top + (bot - top) * 0.62,
  );
}

function drawConnectedBadge(buf, size) {
  // Filled dot, bottom-right.
  const cx = size * 0.82;
  const cy = size * 0.75;
  const r = size * 0.14;
  fillCircle(buf, size, cx, cy, r, 255);
}

function drawDisconnectedBadge(buf, size) {
  // Hollow ring, bottom-right. Visually distinct from the filled dot.
  const cx = size * 0.82;
  const cy = size * 0.75;
  const rOuter = size * 0.16;
  const rInner = size * 0.09;
  ringCircle(buf, size, cx, cy, rOuter, rInner, 255);
}

function drawThinkingBadge(buf, size) {
  // Three small dots stacked vertically, suggesting activity / ellipsis.
  const cx = size * 0.82;
  const r = size * 0.07;
  for (let i = 0; i < 3; i++) {
    const cy = size * (0.58 + i * 0.13);
    fillCircle(buf, size, cx, cy, r, 255);
  }
}

// ---- Emit ---------------------------------------------------------------

const variants = [
  { name: "trayIconTemplate", draw: drawDisconnectedBadge },
  { name: "trayIconConnectedTemplate", draw: drawConnectedBadge },
  { name: "trayIconThinkingTemplate", draw: drawThinkingBadge },
];

const SIZES = [
  { suffix: "", size: 22 },
  { suffix: "@2x", size: 44 },
];

for (const v of variants) {
  for (const s of SIZES) {
    const buf = makeBuf(s.size);
    drawWordmark(buf, s.size);
    v.draw(buf, s.size);
    const png = encodePng(s.size, s.size, buf);
    const filename = `${v.name}${s.suffix}.png`;
    const out = resolve(ASSETS, filename);
    writeFileSync(out, png);
    console.log(`wrote ${out} (${s.size}x${s.size}, ${png.length} bytes)`);
  }
}
