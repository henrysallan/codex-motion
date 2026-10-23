// L0 sprite container (.trl0): a 16-byte header, then `frameCount` frames of
// GPU-ready blocks, back to back, each frame row-major. Frames sample the
// whole clip evenly: frame i shows time (i + 0.5) / frameCount of the loop.
//
// The payload may be deflate-raw compressed (flag bit 0); BC1 shrinks by
// roughly a third more, which matters for "L0 syncs first". Compression is
// left to callers (zlib in Node, DecompressionStream in the browser) so this
// module stays platform-free.
//
//   0  u32  magic 'TRL0'
//   4  u16  version (1)
//   6  u8   format (1 = BC1)
//   7  u8   flags (bit 0: payload deflate-raw)
//   8  u16  frame width  (multiple of 4)
//  10  u16  frame height (multiple of 4)
//  12  u16  frame count
//  14  u16  reserved

export const L0_HEADER_BYTES = 16;
export const L0_FRAME_HEIGHT = 128;
export const L0_MAX_FRAMES = 24;

// Sprite frame size for a clip: 128 px tall, width to aspect, both
// multiples of 4 (BC1 blocks).
export function spriteFrameSize(width: number, height: number): { width: number; height: number } {
  const h = L0_FRAME_HEIGHT;
  const w = Math.min(512, Math.max(16, Math.round((h * width) / height / 4) * 4));
  return { width: w, height: h };
}

const MAGIC = 0x304c5254; // 'TRL0' read as little-endian u32
const VERSION = 1;

export type L0Format = 'bc1';

export interface L0Header {
  format: L0Format;
  compressed: boolean;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
}

export function writeL0Header(h: L0Header): Uint8Array {
  const buf = new Uint8Array(L0_HEADER_BYTES);
  const v = new DataView(buf.buffer);
  v.setUint32(0, MAGIC, true);
  v.setUint16(4, VERSION, true);
  v.setUint8(6, 1);
  v.setUint8(7, h.compressed ? 1 : 0);
  v.setUint16(8, h.frameWidth, true);
  v.setUint16(10, h.frameHeight, true);
  v.setUint16(12, h.frameCount, true);
  return buf;
}

export function readL0Header(bytes: Uint8Array): L0Header {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < L0_HEADER_BYTES || v.getUint32(0, true) !== MAGIC) throw new Error('not an L0 sprite file');
  const version = v.getUint16(4, true);
  if (version !== VERSION) throw new Error(`unsupported L0 version ${version}`);
  const format = v.getUint8(6);
  if (format !== 1) throw new Error(`unsupported L0 format ${format}`);
  return {
    format: 'bc1',
    compressed: (v.getUint8(7) & 1) === 1,
    frameWidth: v.getUint16(8, true),
    frameHeight: v.getUint16(10, true),
    frameCount: v.getUint16(12, true),
  };
}
