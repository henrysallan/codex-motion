// One looping WebCodecs decode of one source range, slaved to a clock.
//
// Time is "virtual": loop k of a range [in, out) covers [k·L, (k+1)·L) µs
// with L = out - in, so the clock maps straight onto chunk timestamps and
// decoder output stays monotonic across loop restarts. The stream feeds
// packets until it has decoded a short lookahead past the playhead, keeps
// only the newest frame at or before the playhead plus what's queued after
// it, and seeks (reset, back to the nearest keyframe) when the playhead
// jumps: a hover scrub, an unpause after a long gap, or falling behind.
//
// Each loop starts decoding at the keyframe before `in`; frames before `in`
// are decoded (they're references) but discarded. Decoded frames are closed
// as soon as they're behind the playhead: hardware decoders run from small
// surface pools and stall if frames are held.
//
// A stream belongs to no particular tile. The engine shares one per
// (source, range, clock) across every placement and view that shows it.

import type { Demuxed, MediaCache } from './demux.ts';

const LOOKAHEAD_US = 200_000;
const MAX_QUEUED_DECODES = 3;
const MAX_HELD_FRAMES = 6;
// Playhead this far beyond what has been fed: seek rather than decode through
// (with 1 s GOPs there is always a keyframe in between).
const SEEK_AHEAD_US = 1_000_000;
// Playhead this far before the oldest held frame: it moved backwards, seek.
const SEEK_BEHIND_US = 50_000;
// A slightly late frame is better than flashing back to the sprite.
const LATE_TOLERANCE_US = 120_000;
// Frames starting this far before `in` belong to the pre-roll.
const PREROLL_SLACK_US = 500;

export type StreamState = 'loading' | 'ready' | 'failed' | 'closed';

export class VideoStream {
  readonly key: string;
  readonly createdAt: number;
  state: StreamState = 'loading';
  error: string | null = null;
  // When the decoder was configured (performance.now() time base).
  readyAt = 0;
  // Set by the engine each frame: whether any tile still uses this stream.
  used = true;

  private media: Demuxed | null = null;
  private decoder: VideoDecoder | null = null;
  private readonly rangeIn: number;
  private rangeOut: number;
  private loop: number;
  private frames: VideoFrame[] = [];
  // Last frame shown before a seek, kept on screen until the seek lands.
  private hold: VideoFrame | null = null;
  private target = 0;
  // Next packet to feed, as (loop index, packet index).
  private feedLoop = 0;
  private feedIndex = 0;
  // Virtual end time of the last fed packet.
  private fedEnd = 0;
  // Virtual timestamps of fed pre-roll packets, whose frames are dropped.
  private readonly preroll = new Set<number>();
  // Whether a frame has been presented since the stream opened.
  private shown = false;

  // `rangeOut` may exceed the media; it is clamped once the packets are known.
  constructor(key: string, url: string, rangeInUs: number, rangeOutUs: number, cache: MediaCache, now: number) {
    this.key = key;
    this.rangeIn = Math.max(0, Math.round(rangeInUs));
    this.rangeOut = Math.max(this.rangeIn + 1, Math.round(rangeOutUs));
    this.loop = this.rangeOut - this.rangeIn;
    this.createdAt = now;
    cache.get(url).then(
      (media) => this.open(media),
      (e: unknown) => this.fail(e),
    );
  }

  // Whether the stream has presented a frame yet.
  get started(): boolean {
    return this.shown;
  }

  get decoding(): boolean {
    return this.state === 'loading' || this.state === 'ready';
  }

  // Advances the playhead (virtual µs) and tops up the decoder.
  update(target: number): void {
    this.target = target;
    if (this.state !== 'ready') return;
    this.trim();
    const oldest = this.frames[0]?.timestamp;
    if ((oldest !== undefined && target < oldest - SEEK_BEHIND_US) || target > this.fedEnd + SEEK_AHEAD_US) {
      this.seek(target);
    } else {
      this.feed();
    }
  }

  // The frame to draw for the current playhead, or null before the stream
  // has anything worth showing. Once it has shown a frame it keeps showing
  // its best one (a slightly stale frame beats flashing back to the sprite).
  current(): VideoFrame | null {
    const f = this.presentable();
    if (f) {
      this.shown = true;
      return f;
    }
    return this.hold ?? (this.shown ? (this.frames[0] ?? null) : null);
  }

  // Whether the frame `current()` returns is the right one for the playhead,
  // as opposed to a stale or held frame while the decoder catches up.
  onTime(): boolean {
    const f = this.frames[0];
    return !!f && f.timestamp <= this.target && (this.frames.length > 1 || f.timestamp + (f.duration ?? 0) > this.target);
  }

  close(): void {
    if (this.state === 'closed') return;
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.releaseFrames();
    this.media = null;
    this.state = 'closed';
  }

  // frames[0] if it is at the playhead (covers it, or is within tolerance).
  private presentable(): VideoFrame | null {
    const f = this.frames[0];
    if (!f) return null;
    const covers = f.timestamp <= this.target && (this.frames.length > 1 || f.timestamp + (f.duration ?? 0) > this.target);
    return covers || Math.abs(this.target - f.timestamp) < LATE_TOLERANCE_US ? f : null;
  }

  private open(media: Demuxed): void {
    if (this.state !== 'loading') return;
    this.media = media;
    const last = media.packets[media.packets.length - 1];
    const end = last.ts + last.dur;
    if (this.rangeOut > end) this.rangeOut = Math.max(this.rangeIn + 1, end);
    this.loop = this.rangeOut - this.rangeIn;
    try {
      this.decoder = new VideoDecoder({ output: (f) => this.onFrame(f), error: (e) => this.fail(e) });
      this.decoder.addEventListener('dequeue', () => this.feed());
      this.state = 'ready';
      this.readyAt = performance.now();
      this.seek(this.target);
    } catch (e) {
      this.fail(e);
    }
  }

  private configure(): void {
    this.decoder!.configure({ ...this.media!.config, optimizeForLatency: true, hardwareAcceleration: 'no-preference' });
  }

  // Index of the last keyframe at or before source time `t` (µs).
  private keyframeBefore(t: number): number {
    const { packets, keyframes } = this.media!;
    let lo = 0;
    let hi = keyframes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (packets[keyframes[mid]].ts <= t) lo = mid;
      else hi = mid - 1;
    }
    return keyframes[lo];
  }

  private seek(target: number): void {
    const decoder = this.decoder!;
    if (decoder.state === 'configured') decoder.reset();
    this.configure();
    this.preroll.clear();

    // Keep whatever is on screen until the new position decodes.
    const onScreen = this.current();
    for (const f of this.frames) if (f !== onScreen) f.close();
    if (this.hold && this.hold !== onScreen) this.hold.close();
    this.frames = [];
    this.hold = onScreen;

    const loopIndex = Math.floor(target / this.loop);
    const source = this.rangeIn + (target - loopIndex * this.loop);
    this.feedLoop = loopIndex;
    this.feedIndex = this.keyframeBefore(source);
    this.fedEnd = loopIndex * this.loop + Math.max(0, this.media!.packets[this.feedIndex].ts - this.rangeIn);
    this.feed();
  }

  private feed(): void {
    const decoder = this.decoder;
    if (this.state !== 'ready' || !decoder || decoder.state !== 'configured') return;
    const { packets } = this.media!;
    while (
      decoder.decodeQueueSize < MAX_QUEUED_DECODES &&
      this.frames.length < MAX_HELD_FRAMES &&
      this.fedEnd < this.target + LOOKAHEAD_US
    ) {
      const p = packets[this.feedIndex];
      const ts = this.feedLoop * this.loop + (p.ts - this.rangeIn);
      if (p.ts < this.rangeIn - PREROLL_SLACK_US) this.preroll.add(ts);
      decoder.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: ts, duration: p.dur, data: p.data }));
      this.fedEnd = Math.max(this.fedEnd, ts + p.dur);
      // At the end of the range (or the packets) start the next loop from
      // the keyframe before `in`. Packet 0 is always a keyframe.
      this.feedIndex++;
      if (this.feedIndex >= packets.length || packets[this.feedIndex].ts >= this.rangeOut) {
        this.feedIndex = this.keyframeBefore(this.rangeIn);
        this.feedLoop++;
      }
    }
  }

  private onFrame(frame: VideoFrame): void {
    if (this.state !== 'ready' || this.preroll.delete(frame.timestamp)) {
      frame.close();
      return;
    }
    this.frames.push(frame);
    this.trim();
    this.feed();
  }

  // Drops frames the playhead has passed, keeping the newest one at or
  // before it. Releases the held frame once something current replaces it.
  private trim(): void {
    const frames = this.frames;
    while (frames.length >= 2 && frames[1].timestamp <= this.target) frames.shift()!.close();
    if (this.hold && this.presentable()) {
      this.hold.close();
      this.hold = null;
    }
  }

  private releaseFrames(): void {
    for (const f of this.frames) f.close();
    this.frames = [];
    this.hold?.close();
    this.hold = null;
  }

  private fail(e: unknown): void {
    if (this.state === 'closed') return;
    this.error = e instanceof Error ? e.message : String(e);
    this.close();
    this.state = 'failed';
  }
}
