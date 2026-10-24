// Animated GIFs as video: read a GIF's frame count, delays and size from its
// block structure (no decoding), and convert one to an H.264 MP4 that keeps
// its timing. Transparent areas go white, as on most of the pages they sit on.

import { ffmpeg } from './ffmpeg.ts';

export interface GifInfo {
  width: number;
  height: number;
  frames: number;
  // Seconds each frame shows for, as browsers time them.
  delays: number[];
  duration: number;
  transparent: boolean;
}

// Null when the bytes aren't a GIF or end before the first frame.
export function readGif(buf: Uint8Array): GifInfo | null {
  const ascii = String.fromCharCode(...buf.subarray(0, 6));
  if (ascii !== 'GIF87a' && ascii !== 'GIF89a') return null;
  const u16 = (i: number) => buf[i] | (buf[i + 1] << 8);
  const table = (packed: number) => (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  const width = u16(6);
  const height = u16(8);
  let i = 13 + table(buf[10]);
  const delays: number[] = [];
  let delay = 0;
  let transparent = false;
  // Data sub-blocks: a length byte, that many bytes, until a zero length.
  const skipBlocks = () => {
    while (i < buf.length && buf[i] !== 0) i += buf[i] + 1;
    i++;
  };
  while (i < buf.length) {
    const b = buf[i++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[i++];
      if (label === 0xf9 && buf[i] >= 4) {
        delay = u16(i + 2) / 100;
        if (buf[i + 1] & 1) transparent = true;
      }
      skipBlocks();
    } else if (b === 0x2c) {
      i += 8;
      i += 1 + table(buf[i]) + 1; // packed byte, local colour table, LZW code size
      skipBlocks();
      // Browsers show 0 and 10 ms delays at 100 ms; so does ffmpeg.
      delays.push(delay <= 0.01 ? 0.1 : delay);
      delay = 0;
    } else {
      break;
    }
  }
  if (!delays.length) return null;
  return { width, height, frames: delays.length, delays, duration: delays.reduce((s, d) => s + d, 0), transparent };
}

// Why a GIF isn't worth keeping as a clip (a still, an icon, a loader), or null.
export function gifRejection(g: GifInfo): string | null {
  if (g.frames < 2) return 'a still GIF';
  if (Math.max(g.width, g.height) < 200 || Math.min(g.width, g.height) < 80) return `a small GIF (${g.width}×${g.height}), likely an icon or loader`;
  if (g.duration < 0.2) return 'a GIF too short to be animation';
  return null;
}

// A constant frame rate that fits the shortest delay exactly (delays are
// whole hundredths, so 8 → 12.5 fps), as ffmpeg's "100/8"; at most 50 fps.
export function gifFps(g: GifInfo): string {
  return `100/${Math.max(2, Math.round(Math.min(...g.delays) * 100))}`;
}

export function gifFilter(g: GifInfo): string {
  const tail = `fps=${gifFps(g)},pad=ceil(iw/2)*2:ceil(ih/2)*2:color=white,format=yuv420p`;
  // A white copy of each frame underneath it, so the timing stays the GIF's own.
  if (g.transparent) return `[0:v]format=rgba,split[bg][fg];[bg]lutrgb=r=255:g=255:b=255:a=255[white];[white][fg]overlay=format=auto,${tail}`;
  return `[0:v]${tail}`;
}

export async function gifToMp4(src: string, dest: string, g: GifInfo): Promise<void> {
  await ffmpeg(['-i', src, '-filter_complex', gifFilter(g), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', dest]);
}
