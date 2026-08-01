/**
 * Generates PWA icons (icon-192.png, icon-512.png) — no dependencies.
 * Design: near-black rounded square, green play triangle, subtle glow ring.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dir, '..', 'public');

// CRC32 table
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function roundedRectContains(x, y, size, radius) {
  const r = radius;
  if (x >= r && x <= size - r) return true;
  if (y >= r && y <= size - r) return true;
  const cx = x < r ? r : size - r;
  const cy = y < r ? r : size - r;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function drawIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  // Play triangle geometry (centered, slightly right-biased like classic play icons)
  const triA = { x: size * 0.38, y: size * 0.30 };
  const triB = { x: size * 0.38, y: size * 0.70 };
  const triC = { x: size * 0.74, y: size * 0.50 };

  const inTriangle = (px, py) => {
    const d1 = (px - triB.x) * (triA.y - triB.y) - (triA.x - triB.x) * (py - triB.y);
    const d2 = (px - triC.x) * (triB.y - triC.y) - (triB.x - triC.x) * (py - triC.y);
    const d3 = (px - triA.x) * (triC.y - triA.y) - (triC.x - triA.x) * (py - triA.y);
    const neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(neg && pos);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = roundedRectContains(x, y, size, radius);
      // Anti-alias edges with 2x supersampling feel via distance check
      const inside2 = roundedRectContains(x - 0.5, y - 0.5, size, radius);
      const alpha = inside && inside2 ? 255 : inside || inside2 ? 128 : 0;
      // Background gradient (top-left lighter)
      const t = (x + y) / (2 * size);
      buf[i] = Math.round(18 - 6 * t);       // R ~ #121417 → #0c0e11
      buf[i + 1] = Math.round(20 - 6 * t);
      buf[i + 2] = Math.round(29 - 8 * t);
      buf[i + 3] = alpha;
      if (inside && inTriangle(x, y)) {
        buf[i] = 31; buf[i + 1] = 208; buf[i + 2] = 106; buf[i + 3] = 255; // var(--accent)
      }
    }
  }
  return encodePng(size, buf);
}

for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), drawIcon(size));
  console.log(`✅ wrote public/icon-${size}.png`);
}
