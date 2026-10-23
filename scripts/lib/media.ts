// Content hashing and probing for media files, shared by the proxy builder
// and the scraper so both agree on an asset's id.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';

// An asset id: the first 16 hex digits of the file's SHA-256.
export async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex').slice(0, 16);
}

export interface Probe {
  width: number;
  height: number;
  duration: number;
  fps: number;
  codec: string | null;
  audio: boolean;
}

export async function probe(file: string): Promise<Probe> {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    const [end, start, stats, audio] = await Promise.all([
      track.computeDuration(),
      track.getFirstTimestamp(),
      track.computePacketStats(),
      input.getPrimaryAudioTrack(),
    ]);
    return { width: track.displayWidth, height: track.displayHeight, duration: end - start, fps: stats.averagePacketRate, codec: track.codec, audio: !!audio };
  } finally {
    input.dispose();
  }
}
