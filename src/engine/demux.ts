// Fetches and demuxes proxy MP4s into packet lists held in memory, with an
// LRU cap. Proxies are small (an L1 is ~1 MB) and decoders loop over them
// forever, so reading every packet up front keeps the per-frame decode path
// synchronous: no awaits between "the playhead moved" and "decode()".

import { BufferSource, EncodedPacketSink, Input, MP4, QTFF, WEBM, MATROSKA } from 'mediabunny';
import { loadBytes } from './storage.ts';

export interface Packet {
  // Presentation time and duration in µs, rebased so the first frame is 0.
  ts: number;
  dur: number;
  key: boolean;
  data: Uint8Array;
}

export interface Demuxed {
  config: VideoDecoderConfig;
  packets: Packet[];
  // Indices of keyframes in `packets`, ascending.
  keyframes: number[];
  bytes: number;
}

async function demux(url: string): Promise<Demuxed> {
  const buffer = await loadBytes(url);
  // Proxies are MP4; an original being ingested can be anything a browser plays.
  const input = new Input({ formats: [MP4, QTFF, WEBM, MATROSKA], source: new BufferSource(buffer) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`${url}: no video track`);
    const config = await track.getDecoderConfig();
    if (!config) throw new Error(`${url}: codec not decodable here`);
    const packets: Packet[] = [];
    const keyframes: number[] = [];
    for await (const p of new EncodedPacketSink(track).packets()) {
      if (p.type === 'key') keyframes.push(packets.length);
      packets.push({ ts: Math.round(p.timestamp * 1e6), dur: Math.round(p.duration * 1e6), key: p.type === 'key', data: p.data });
    }
    if (packets.length === 0 || keyframes[0] !== 0) throw new Error(`${url}: stream does not start on a keyframe`);
    const t0 = packets[0].ts;
    for (const p of packets) p.ts -= t0;
    return { config, packets, keyframes, bytes: buffer.byteLength };
  } finally {
    input.dispose();
  }
}

export class MediaCache {
  private entries = new Map<string, { promise: Promise<Demuxed>; bytes: number }>();
  private total = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get(url: string): Promise<Demuxed> {
    const hit = this.entries.get(url);
    if (hit) {
      // Re-insert to mark as most recently used.
      this.entries.delete(url);
      this.entries.set(url, hit);
      return hit.promise;
    }
    const entry = { promise: demux(url), bytes: 0 };
    this.entries.set(url, entry);
    entry.promise.then(
      (d) => {
        entry.bytes = d.bytes;
        this.total += d.bytes;
        this.evict();
      },
      () => this.entries.delete(url),
    );
    return entry.promise;
  }

  get bytes(): number {
    return this.total;
  }

  // Streams keep their own reference to a Demuxed, so evicting one in use
  // only drops it from the cache, never from under a decoder.
  private evict(): void {
    for (const [url, e] of this.entries) {
      if (this.total <= this.maxBytes) break;
      if (e.bytes === 0) continue;
      this.entries.delete(url);
      this.total -= e.bytes;
    }
  }
}
