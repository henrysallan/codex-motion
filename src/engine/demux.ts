// Video media for the render worker: a decoder config, an index of every
// packet, and the packets' bytes, loaded as streams need them and held in
// an LRU cache.
//
// Large MP4 and MOV files are read in ranges. The first request reads the
// head of the file, which holds the `moov` box when the file was written
// with +faststart, as proxies are. The moov gives the decoder config and
// the byte range of every frame (mp4.ts), so a stream fetches only the
// packets around its playhead and a few seconds ahead: starting a 2-minute
// L1 reads ~100 KB rather than ~9 MB. Small files are read whole but
// indexed the same way, so nothing walks or copies packets one by one.
// Other files (an original being ingested can be anything a browser plays)
// are read whole and demuxed by mediabunny.
//
// Loaded packets stay loaded while their media is alive: decoders loop over
// their range forever, and feeding a decoder stays synchronous once its
// packets are in.

import { BufferSource, EncodedPacketSink, Input, MATROSKA, MP4, QTFF, StreamSource, WEBM } from 'mediabunny';
import { readBox, readSampleTable } from './mp4.ts';
import { openRanged, type RangedFile } from './storage.ts';

// First read of a file: room for the moov of a faststart MP4 (~15 KB for a
// 2-minute L1) and the start of its frames.
export const HEAD_BYTES = 64 * 1024;
// Files up to this size are read whole, in one plain request. A ranged
// start takes two requests in a row (the head, then the frames), and the
// media Worker answers plain requests from its edge cache but ranges from
// R2 (0.15-0.5 s each), so for most proxies one whole read is sooner. Past
// this, the download is what's slow, and so is reading it on the worker.
const WHOLE_BYTES = 2 * 1024 * 1024;
// Range requests in flight per file, and the most one extends to: none of
// a response is usable until all of it has arrived.
const MAX_FETCHES = 2;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
// Top-level boxes to step over looking for the moov before giving up.
const MAX_TOP_BOXES = 16;

export interface Packet {
  // Presentation time and duration in µs, rebased so the first frame is 0.
  ts: number;
  dur: number;
  key: boolean;
  // Where the packet is in the file, and its bytes once loaded.
  offset: number;
  size: number;
  data: Uint8Array | null;
}

export class Media {
  readonly config: VideoDecoderConfig;
  // Decode order.
  readonly packets: Packet[];
  // Indices of keyframes in `packets`, ascending.
  readonly keyframes: number[];
  // Bytes held for this media.
  bytes = 0;
  error: unknown = null;
  // Told the size of every batch of bytes loaded (for the cache's cap).
  onLoad: ((bytes: number) => void) | null = null;

  private readonly file: RangedFile | null;
  // Per packet: a request for it is in flight.
  private readonly requested: Uint8Array;
  private fetches = 0;
  private missing: number;
  private readonly listeners = new Set<() => void>();

  // `file` is where missing packets come from; null when every packet's
  // data is already set.
  constructor(config: VideoDecoderConfig, packets: Packet[], file: RangedFile | null) {
    if (packets.length === 0 || !packets[0].key) throw new Error('stream does not start on a keyframe');
    this.config = config;
    this.packets = packets;
    this.keyframes = [];
    for (let i = 0; i < packets.length; i++) if (packets[i].key) this.keyframes.push(i);
    this.file = file;
    this.requested = new Uint8Array(file ? packets.length : 0);
    this.missing = packets.reduce((n, p) => n + (p.data ? 0 : 1), 0);
  }

  // Whether every packet is loaded.
  get complete(): boolean {
    return this.missing === 0;
  }

  // Index of the first packet at or after `ts` (µs), or packets.length.
  indexAt(ts: number): number {
    const { packets } = this;
    let lo = 0;
    let hi = packets.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (packets[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Makes sure packets [from, to) are loaded or on their way. A request
  // that has to go out anyway runs on through `extend`, so a stream reading
  // ahead fetches a few seconds at a time instead of a packet per frame.
  // Cheap when nothing is missing: streams call it every frame.
  load(from: number, to: number, extend = to): void {
    if (this.missing === 0 || this.error || !this.file || this.fetches >= MAX_FETCHES) return;
    const { packets, requested } = this;
    let i = from;
    while (i < to && (packets[i].data || requested[i])) i++;
    if (i >= to) return;
    const end = Math.min(packets.length, Math.max(to, extend));
    let j = i + 1;
    let bytes = packets[i].size;
    while (j < end && !packets[j].data && !requested[j] && (j < to || bytes < MAX_FETCH_BYTES)) bytes += packets[j++].size;
    void this.fetch(i, j);
  }

  // Calls `fn` after each request lands or fails. Returns the unsubscribe.
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Points the packets in [from, to) that lie inside `bytes` (file offset
  // `base`) at their data.
  fill(bytes: Uint8Array, base: number, from = 0, to = this.packets.length): void {
    let loaded = 0;
    for (let k = from; k < to; k++) {
      const p = this.packets[k];
      const at = p.offset - base;
      if (p.data || at < 0 || at + p.size > bytes.length) continue;
      p.data = bytes.subarray(at, at + p.size);
      loaded += p.size;
      this.missing--;
    }
    if (loaded === 0) return;
    this.bytes += loaded;
    this.onLoad?.(loaded);
  }

  private async fetch(from: number, to: number): Promise<void> {
    const { packets, requested } = this;
    let start = Infinity;
    let end = 0;
    for (let k = from; k < to; k++) {
      requested[k] = 1;
      start = Math.min(start, packets[k].offset);
      end = Math.max(end, packets[k].offset + packets[k].size);
    }
    this.fetches++;
    try {
      this.fill(await this.file!.read(start, end), start, from, to);
    } catch (e) {
      this.error = e;
    } finally {
      requested.fill(0, from, to);
      this.fetches--;
    }
    for (const fn of this.listeners) fn();
  }
}

// Reads the moov box of an MP4/MOV from its head, or from further in when
// the file wasn't written with +faststart. Null when the top-level boxes
// don't look like an MP4's.
async function findMoov(file: RangedFile): Promise<{ bytes: Uint8Array; start: number } | null> {
  let buf = file.head;
  let base = 0;
  let at = 0;
  for (let n = 0; n < MAX_TOP_BOXES && at < file.size; n++) {
    let box = readBox(buf, at, base, file.size);
    if (!box) {
      buf = await file.read(at, Math.min(file.size, at + 16));
      base = at;
      box = readBox(buf, at, base, file.size);
      if (!box) return null;
    }
    if (!/^[\x20-\x7e]{4}$/.test(box.type)) return null;
    if (box.type === 'moov') {
      const inBuf = box.end - base <= buf.length;
      return { bytes: inBuf ? buf.subarray(box.start - base, box.end - base) : await file.read(box.start, box.end), start: box.start };
    }
    at = box.end;
  }
  return null;
}

// The packet index of an MP4/MOV's primary video track, with the packets
// already in the head filled in. Null when the file isn't one, or keeps its
// samples in fragments.
async function openMp4(url: string, file: RangedFile): Promise<Media | null> {
  const moov = await findMoov(file);
  if (!moov) return null;
  // mediabunny reads the decoder config from the boxes already read.
  const moovEnd = moov.start + moov.bytes.length;
  const source = new StreamSource({
    getSize: () => file.size,
    read: (start, end) => {
      if (end <= file.head.length) return file.head.subarray(start, end);
      if (start >= moov.start && end <= moovEnd) return moov.bytes.subarray(start - moov.start, end - moov.start);
      return file.read(start, end);
    },
    prefetchProfile: 'none',
  });
  const input = new Input({ formats: [MP4, QTFF], source });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`${url}: no video track`);
    const config = await track.getDecoderConfig();
    if (!config) throw new Error(`${url}: codec not decodable here`);
    const table = readSampleTable(moov.bytes, track.id);
    if (!table) return null;
    const scale = 1e6 / table.timescale;
    const t0 = Math.round(table.pts[0] * scale);
    const packets: Packet[] = [];
    for (let i = 0; i < table.sizes.length; i++) {
      packets.push({
        ts: Math.round(table.pts[i] * scale) - t0,
        dur: Math.round(table.durations[i] * scale),
        key: table.keys[i] === 1,
        offset: table.offsets[i],
        size: table.sizes[i],
        data: null,
      });
    }
    const media = new Media(config, packets, file);
    media.fill(file.head, 0);
    return media;
  } finally {
    input.dispose();
  }
}

// Reads a whole file and demuxes every packet with mediabunny.
async function openWhole(url: string, buffer: Uint8Array): Promise<Media> {
  const input = new Input({ formats: [MP4, QTFF, WEBM, MATROSKA], source: new BufferSource(buffer) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error(`${url}: no video track`);
    const config = await track.getDecoderConfig();
    if (!config) throw new Error(`${url}: codec not decodable here`);
    const packets: Packet[] = [];
    for await (const p of new EncodedPacketSink(track).packets()) {
      packets.push({ ts: Math.round(p.timestamp * 1e6), dur: Math.round(p.duration * 1e6), key: p.type === 'key', offset: 0, size: p.data.byteLength, data: p.data });
    }
    if (packets.length === 0) throw new Error(`${url}: no packets`);
    const t0 = packets[0].ts;
    for (const p of packets) p.ts -= t0;
    const media = new Media(config, packets, null);
    media.bytes = buffer.byteLength;
    return media;
  } finally {
    input.dispose();
  }
}

// Opens a file whose first HEAD_BYTES (or all, if shorter) are `file.head`.
// `name` is for errors.
export async function openFile(name: string, file: RangedFile): Promise<Media> {
  try {
    const media = await openMp4(name, file);
    if (media) return media;
  } catch {
    // Not an MP4 the index understands; mediabunny may still read it whole.
  }
  return openWhole(name, file.head.length >= file.size ? file.head : await file.read(0, file.size));
}

// `size`: the file's size if known.
async function open(url: string, size: number | undefined): Promise<Media> {
  return openFile(url, await openRanged(url, size !== undefined && size <= WHOLE_BYTES ? Infinity : HEAD_BYTES));
}

export class MediaCache {
  private entries = new Map<string, { promise: Promise<Media>; media: Media | null; bytes: number }>();
  private total = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  // `size`: the file's size, if the library knows it.
  get(url: string, size?: number): Promise<Media> {
    const hit = this.entries.get(url);
    if (hit && !hit.media?.error) {
      // Re-insert to mark as most recently used.
      this.entries.delete(url);
      this.entries.set(url, hit);
      return hit.promise;
    }
    if (hit) this.drop(url);
    const entry = { promise: open(url, size), media: null as Media | null, bytes: 0 };
    this.entries.set(url, entry);
    entry.promise.then(
      (media) => {
        if (this.entries.get(url) !== entry) return;
        entry.media = media;
        const grow = (bytes: number) => {
          if (this.entries.get(url) !== entry) return;
          entry.bytes += bytes;
          this.total += bytes;
          this.evict();
        };
        media.onLoad = grow;
        grow(media.bytes);
      },
      () => {
        if (this.entries.get(url) === entry) this.entries.delete(url);
      },
    );
    return entry.promise;
  }

  get bytes(): number {
    return this.total;
  }

  private drop(url: string): void {
    const e = this.entries.get(url);
    if (!e) return;
    this.entries.delete(url);
    this.total -= e.bytes;
  }

  // Streams keep their own reference to a Media, so evicting one in use
  // only drops it from the cache (and its later loads from the count),
  // never from under a decoder.
  private evict(): void {
    for (const [url, e] of this.entries) {
      if (this.total <= this.maxBytes) break;
      if (e.bytes === 0) continue;
      this.drop(url);
    }
  }
}
