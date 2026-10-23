// BC1 (DXT1) block compression for L0 sprite frames.
//
// L0 stays resident for every clip on a board, so its memory sets how many
// clips a board can hold. BC1 stores 4 bits per pixel, an eighth of RGBA8, and
// the GPU samples it directly. This module is shared by the offline proxy
// builder (Node) and the in-browser ingest worker, so it has no imports and
// touches no platform APIs.
//
// Encoder: principal-axis endpoints with a small inset, one least-squares
// refinement pass, and exact single-colour tables for flat blocks (flat
// backgrounds are common in motion reference and band badly otherwise).

const BLOCK_BYTES = 8;

export function bc1ByteLength(width: number, height: number): number {
  return (width >> 2) * (height >> 2) * BLOCK_BYTES;
}

const expand5 = (v: number) => (v << 3) | (v >> 2);
const expand6 = (v: number) => (v << 2) | (v >> 4);

// For each 8-bit value, the endpoint pair (a, b) whose 2/3·a + 1/3·b
// interpolant lands closest once expanded. Built lazily: 1M evaluations.
let single5: Uint8Array | null = null;
let single6: Uint8Array | null = null;

function singleColorTable(bits: 5 | 6): Uint8Array {
  const max = (1 << bits) - 1;
  const expand = bits === 5 ? expand5 : expand6;
  const table = new Uint8Array(512);
  for (let v = 0; v < 256; v++) {
    let best = Infinity;
    for (let a = 0; a <= max; a++) {
      const ea = expand(a);
      for (let b = 0; b <= max; b++) {
        const err = Math.abs((2 * ea + expand(b)) / 3 - v);
        if (err < best) {
          best = err;
          table[v * 2] = a;
          table[v * 2 + 1] = b;
        }
      }
    }
  }
  return table;
}

const pack565 = (r: number, g: number, b: number) => (r << 11) | (g << 5) | b;

function quantize565(r: number, g: number, b: number): number {
  const q = (v: number, max: number) => Math.min(max, Math.max(0, Math.round((v * max) / 255)));
  return pack565(q(r, 31), q(g, 63), q(b, 31));
}

function unpack565(c: number, out: Float32Array, o: number): void {
  out[o] = expand5((c >> 11) & 31);
  out[o + 1] = expand6((c >> 5) & 63);
  out[o + 2] = expand5(c & 31);
}

// Scratch, reused across blocks (single-threaded callers only).
const px = new Float32Array(48);
const pal = new Float32Array(12);
const idx = new Uint8Array(16);
const bestIdx = new Uint8Array(16);

function buildPalette(c0: number, c1: number): void {
  unpack565(c0, pal, 0);
  unpack565(c1, pal, 3);
  for (let k = 0; k < 3; k++) {
    pal[6 + k] = (2 * pal[k] + pal[3 + k]) / 3;
    pal[9 + k] = (pal[k] + 2 * pal[3 + k]) / 3;
  }
}

// Picks the nearest palette entry per pixel into `idx`; returns total error.
function assignIndices(): number {
  let total = 0;
  for (let i = 0; i < 16; i++) {
    const r = px[i * 3], g = px[i * 3 + 1], b = px[i * 3 + 2];
    let best = Infinity;
    let bi = 0;
    for (let p = 0; p < 4; p++) {
      const dr = r - pal[p * 3], dg = g - pal[p * 3 + 1], db = b - pal[p * 3 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < best) {
        best = d;
        bi = p;
      }
    }
    idx[i] = bi;
    total += best;
  }
  return total;
}

// Palette weights of endpoint 0 for indices 0..3 (endpoint 1 gets 1 - w).
const W0 = [1, 0, 2 / 3, 1 / 3];

// Least-squares endpoints for the current indices. Returns [c0, c1] or null
// when the system is singular (all pixels on one index).
function refineEndpoints(): [number, number] | null {
  let aa = 0, ab = 0, bb = 0;
  const ax = [0, 0, 0], bx = [0, 0, 0];
  for (let i = 0; i < 16; i++) {
    const a = W0[idx[i]];
    const b = 1 - a;
    aa += a * a;
    ab += a * b;
    bb += b * b;
    for (let k = 0; k < 3; k++) {
      ax[k] += a * px[i * 3 + k];
      bx[k] += b * px[i * 3 + k];
    }
  }
  const det = aa * bb - ab * ab;
  if (Math.abs(det) < 1e-6) return null;
  const e0 = [0, 0, 0], e1 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    e0[k] = (bb * ax[k] - ab * bx[k]) / det;
    e1[k] = (aa * bx[k] - ab * ax[k]) / det;
  }
  return [quantize565(e0[0], e0[1], e0[2]), quantize565(e1[0], e1[1], e1[2])];
}

function writeBlock(out: Uint8Array, o: number, c0: number, c1: number, indices: Uint8Array): void {
  // Four-colour mode needs c0 > c1. Swapping endpoints mirrors the palette:
  // 0 <-> 1 and 2 <-> 3, which is an xor with 1.
  let flip = 0;
  if (c0 < c1) {
    const t = c0;
    c0 = c1;
    c1 = t;
    flip = 1;
  }
  let bits = 0;
  if (c0 !== c1) {
    for (let i = 15; i >= 0; i--) bits = (bits << 2) | (indices[i] ^ flip);
  }
  // c0 === c1 leaves every index at 0, which decodes to c0 in either mode.
  out[o] = c0 & 255;
  out[o + 1] = c0 >> 8;
  out[o + 2] = c1 & 255;
  out[o + 3] = c1 >> 8;
  out[o + 4] = bits & 255;
  out[o + 5] = (bits >>> 8) & 255;
  out[o + 6] = (bits >>> 16) & 255;
  out[o + 7] = bits >>> 24;
}

function encodeBlock(out: Uint8Array, o: number): void {
  // Flat block: exact single-colour endpoints, every pixel on index 2.
  let flat = true;
  for (let i = 3; i < 48 && flat; i++) if (px[i] !== px[i % 3]) flat = false;
  if (flat) {
    single5 ??= singleColorTable(5);
    single6 ??= singleColorTable(6);
    const r = px[0], g = px[1], b = px[2];
    const c0 = pack565(single5[r * 2], single6[g * 2], single5[b * 2]);
    const c1 = pack565(single5[r * 2 + 1], single6[g * 2 + 1], single5[b * 2 + 1]);
    idx.fill(2);
    writeBlock(out, o, c0, c1, idx);
    return;
  }

  // Mean and covariance.
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < 16; i++) {
    mr += px[i * 3];
    mg += px[i * 3 + 1];
    mb += px[i * 3 + 2];
  }
  mr /= 16;
  mg /= 16;
  mb /= 16;
  let crr = 0, crg = 0, crb = 0, cgg = 0, cgb = 0, cbb = 0;
  for (let i = 0; i < 16; i++) {
    const r = px[i * 3] - mr, g = px[i * 3 + 1] - mg, b = px[i * 3 + 2] - mb;
    crr += r * r;
    crg += r * g;
    crb += r * b;
    cgg += g * g;
    cgb += g * b;
    cbb += b * b;
  }

  // Principal axis by power iteration.
  let vr = 1, vg = 1, vb = 1;
  for (let it = 0; it < 8; it++) {
    const nr = crr * vr + crg * vg + crb * vb;
    const ng = crg * vr + cgg * vg + cgb * vb;
    const nb = crb * vr + cgb * vg + cbb * vb;
    const len = Math.hypot(nr, ng, nb);
    if (len < 1e-9) break;
    vr = nr / len;
    vg = ng / len;
    vb = nb / len;
  }

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 16; i++) {
    const t = (px[i * 3] - mr) * vr + (px[i * 3 + 1] - mg) * vg + (px[i * 3 + 2] - mb) * vb;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  // Inset the endpoints by 1/16 of the range: the extremes are usually lone
  // pixels, and pulling in lowers the error of everything between them.
  const inset = (hi - lo) / 16;
  lo += inset;
  hi -= inset;

  let c0 = quantize565(mr + vr * hi, mg + vg * hi, mb + vb * hi);
  let c1 = quantize565(mr + vr * lo, mg + vg * lo, mb + vb * lo);
  buildPalette(c0, c1);
  let err = assignIndices();
  bestIdx.set(idx);

  const refined = refineEndpoints();
  if (refined && (refined[0] !== c0 || refined[1] !== c1)) {
    buildPalette(refined[0], refined[1]);
    const e = assignIndices();
    if (e < err) {
      err = e;
      c0 = refined[0];
      c1 = refined[1];
      bestIdx.set(idx);
    }
  }
  writeBlock(out, o, c0, c1, bestIdx);
}

// Compresses RGBA8 pixels (alpha ignored) into BC1 blocks. Width and height
// must be multiples of 4.
export function encodeBC1(rgba: Uint8Array, width: number, height: number, out?: Uint8Array): Uint8Array {
  if (width % 4 || height % 4) throw new Error(`BC1 needs 4-aligned sizes, got ${width}x${height}`);
  const dst = out ?? new Uint8Array(bc1ByteLength(width, height));
  const bw = width >> 2;
  const bh = height >> 2;
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      for (let y = 0; y < 4; y++) {
        let s = ((by * 4 + y) * width + bx * 4) * 4;
        for (let x = 0; x < 4; x++, s += 4) {
          const p = (y * 4 + x) * 3;
          px[p] = rgba[s];
          px[p + 1] = rgba[s + 1];
          px[p + 2] = rgba[s + 2];
        }
      }
      encodeBlock(dst, o);
      o += BLOCK_BYTES;
    }
  }
  return dst;
}

// Expands BC1 blocks to RGBA8, for devices without BC texture support.
export function decodeBC1(blocks: Uint8Array, width: number, height: number, out?: Uint8Array): Uint8Array {
  const dst = out ?? new Uint8Array(width * height * 4);
  const bw = width >> 2;
  const bh = height >> 2;
  const palette = new Float32Array(16);
  let o = 0;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++, o += BLOCK_BYTES) {
      const c0 = blocks[o] | (blocks[o + 1] << 8);
      const c1 = blocks[o + 2] | (blocks[o + 3] << 8);
      const bits = (blocks[o + 4] | (blocks[o + 5] << 8) | (blocks[o + 6] << 16) | (blocks[o + 7] << 24)) >>> 0;
      unpack565(c0, palette, 0);
      unpack565(c1, palette, 4);
      palette[3] = palette[7] = palette[11] = 255;
      for (let k = 0; k < 3; k++) {
        if (c0 > c1) {
          palette[8 + k] = (2 * palette[k] + palette[4 + k]) / 3;
          palette[12 + k] = (palette[k] + 2 * palette[4 + k]) / 3;
        } else {
          palette[8 + k] = (palette[k] + palette[4 + k]) / 2;
          palette[12 + k] = 0;
        }
      }
      palette[15] = c0 > c1 ? 255 : 0;
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const p = ((bits >>> (2 * (y * 4 + x))) & 3) * 4;
          const d = ((by * 4 + y) * width + bx * 4 + x) * 4;
          dst[d] = palette[p] + 0.5;
          dst[d + 1] = palette[p + 1] + 0.5;
          dst[d + 2] = palette[p + 2] + 0.5;
          dst[d + 3] = palette[p + 3];
        }
      }
    }
  }
  return dst;
}
