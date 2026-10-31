// Generates icons/icon{16,32,48,128}.png with zero dependencies.
// Design: rounded charcoal tile, violet play triangle, small "pull down" arrow.
// Run: node scripts/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Vector-ish rasterizer (supersampled) -----------------------------------

const BG = [22, 22, 26];
const ACCENT = [139, 92, 246];
const WHITE = [255, 255, 255];

function inRoundedRect(x, y, r) {
  // unit square [0,1] with corner radius r
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function inTriangle(px, py, a, b, c) {
  const s = (a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0]);
  const t = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
  if (s < 0 !== t < 0 && s !== 0 && t !== 0) return false;
  const d = (c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0]);
  return d === 0 || d < 0 === s + t <= 0;
}

function inRect(x, y, x0, y0, x1, y1) {
  return x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

// Returns [r,g,b,a] for a point in unit space.
function shade(x, y, size) {
  if (!inRoundedRect(x, y, 0.22)) return [0, 0, 0, 0];

  // Play triangle, slightly right of center for optical balance.
  const tri = [
    [0.36, 0.26],
    [0.36, 0.74],
    [0.78, 0.5],
  ];
  if (inTriangle(x, y, ...tri)) return [...ACCENT, 255];

  // Small "pull" arrow at the bottom-left, only when there is room.
  if (size >= 32) {
    const ax = 0.22, top = 0.56, bottom = 0.80, w = 0.035;
    if (inRect(x, y, ax - w, top, ax + w, bottom - 0.07)) return [...WHITE, 230];
    if (inTriangle(x, y, [ax - 0.10, bottom - 0.12], [ax + 0.10, bottom - 0.12], [ax, bottom])) return [...WHITE, 230];
  }

  return [...BG, 255];
}

function render(size) {
  const SS = 4; // 4x4 supersampling
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const [cr, cg, cb, ca] = shade(x, y, size);
          // premultiplied accumulate
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

for (const size of [16, 32, 48, 128]) {
  const file = join(OUT, `icon${size}.png`);
  writeFileSync(file, encodePNG(size, render(size)));
  console.log('wrote', file);
}
