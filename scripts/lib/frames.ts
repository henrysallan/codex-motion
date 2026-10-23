// Frames from a clip's proxy for the analysis passes. Everything comes from
// the L1 proxy (480p): decoding it is cheap and it's plenty for a vision
// model or an embedding.

import { ffmpeg, ffmpegPipe } from './ffmpeg.ts';

const GUTTER = 8;

// A cols x rows grid of evenly spaced frames, in time order left to right,
// top to bottom, as one JPEG. Tiles are sized from the clip's aspect so the
// sheet stays near `pixels` (about 1.3 MP, ~1,800 image tokens) whatever
// the shape.
export async function contactSheet(
  src: string,
  out: string,
  clip: { duration: number; width: number; height: number },
  { cols = 4, rows = 4, pixels = 1_300_000 } = {},
): Promise<{ width: number; height: number }> {
  const n = cols * rows;
  const aspect = clip.width / clip.height;
  const tileW = Math.max(16, Math.round(Math.sqrt((pixels / n) * aspect) / 2) * 2);
  const tileH = Math.max(16, Math.round(tileW / aspect / 2) * 2);
  const rate = n / Math.max(clip.duration, 0.1);
  await ffmpeg([
    '-i', src,
    // Mid-grey gutters keep frame edges readable on dark or grid-like footage.
    '-vf', `fps=${rate.toFixed(5)},scale=${tileW}:${tileH}:flags=area,tile=${cols}x${rows}:padding=${GUTTER}:margin=${GUTTER}:color=0x808080`,
    '-frames:v', '1', '-q:v', '4', out,
  ]);
  return { width: cols * tileW + (cols + 1) * GUTTER, height: rows * tileH + (rows + 1) * GUTTER };
}

// `n` evenly spaced frames as raw RGB, each `size` x `size` (squashed, the
// way SigLIP's processor resizes anyway).
export async function rgbFrames(src: string, clip: { duration: number }, n: number, size: number): Promise<Uint8ClampedArray[]> {
  const frameBytes = size * size * 3;
  const chunks: Buffer[] = [];
  const rate = n / Math.max(clip.duration, 0.1);
  await ffmpegPipe(
    ['-i', src, '-vf', `fps=${rate.toFixed(5)},scale=${size}:${size}:flags=bicubic`, '-frames:v', String(n), '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    (c) => chunks.push(c),
  );
  const all = Buffer.concat(chunks);
  const out: Uint8ClampedArray[] = [];
  for (let i = 0; i + frameBytes <= all.length; i += frameBytes) out.push(new Uint8ClampedArray(all.subarray(i, i + frameBytes)));
  return out;
}
