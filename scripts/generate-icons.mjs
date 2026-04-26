// Generates brand PNG icons from scratch — no deps, no sharp/canvas.
// Draws a solid dark background with a simple emerald "A" glyph.
// Outputs: public/icon-192.png, public/icon-512.png, public/apple-touch-icon.png
//
// Run with: node scripts/generate-icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const BG = [0x0b, 0x0d, 0x10];
const FG = [0x10, 0xb5, 0x81];

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

function encodePng(width, height, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.subarray(y * stride, (y + 1) * stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    buf[i * 3] = BG[0];
    buf[i * 3 + 1] = BG[1];
    buf[i * 3 + 2] = BG[2];
  }
  const setPx = (x, y, rgb) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const idx = (y * size + x) * 3;
    buf[idx] = rgb[0];
    buf[idx + 1] = rgb[1];
    buf[idx + 2] = rgb[2];
  };
  const cx = size / 2;
  const topY = size * 0.22;
  const botY = size * 0.78;
  const h = botY - topY;
  const baseHalf = h * 0.42;
  const strokeW = Math.max(2, Math.round(size * 0.09));
  const half = strokeW / 2;
  const drawLine = (x0, y0, x1, y1) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.ceil(Math.hypot(dx, dy)) * 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x0 + dx * t;
      const py = y0 + dy * t;
      for (let oy = -half; oy <= half; oy++) {
        for (let ox = -half; ox <= half; ox++) {
          setPx(Math.round(px + ox), Math.round(py + oy), FG);
        }
      }
    }
  };
  drawLine(cx, topY, cx - baseHalf, botY);
  drawLine(cx, topY, cx + baseHalf, botY);
  const barY = topY + h * 0.62;
  const barHalf = baseHalf * 0.55;
  drawLine(cx - barHalf, barY, cx + barHalf, barY);
  return encodePng(size, size, buf);
}

const targets = [
  ["public/icon-192.png", 192],
  ["public/icon-512.png", 512],
  ["public/apple-touch-icon.png", 180],
];
for (const [path, size] of targets) {
  const png = drawIcon(size);
  writeFileSync(path, png);
  console.log(`wrote ${path} (${size}×${size}, ${png.length} bytes)`);
}
