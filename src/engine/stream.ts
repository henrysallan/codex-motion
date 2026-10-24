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
// Packets load on demand (demux.ts): the stream asks for the next few
// seconds past its feed position each frame, and feeding pauses at a packet
// that isn't in yet until its request lands.
//
// Streams take turns to warm up, from the keyframe to their playhead
// (Warmup below).
//
// A stream belongs to no particular tile. The engine shares one per
// (source, range, clock) across every placement and view that shows it.

import type { Media, MediaCache } from './demux.ts';

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
// Packets to have loaded past the feed position: when less than the
// minimum of playback is in (or on its way), fetch on to the lead. The lead
// grows with the time the stream has played, up to the cap, so a clip that
// stays on screen loads in a few large requests, not one every 2 s.
const PREFETCH_MIN_US = 1_000_000;
const PREFETCH_LEAD_US = 3_000_000;
const PREFETCH_CAP_US = 30_000_000;

export type StreamState = 'loading' | 'ready' | 'failed' | 'closed';

// Turns for streams warming up: decoding from a keyframe up to the playhead
// before their first frame shows. Every hardware decoder's work passes
// through one thread in the GPU process, so when a scroll stops and two
// dozen streams start together, each gets a sliver of it and they all show
// late, 0.1-0.2 s after starting. Taking turns, a stream warms up in a few
// ms: the first shows almost at once and the rest follow one by one, sooner
// on the whole. Streams on screen go before prefetches, and a focused clip's
// stream doesn't wait at all: it's the one being watched. A stream only asks
// for a turn once its first packets have loaded.
export class Warmup {
  private readonly turns: number;
  private active = 0;
  private readonly waiting: VideoStream[] = [];

  constructor(turns: number) {
    this.turns = turns;
  }

  // Whether `s` may start decoding now. If not, it waits and is fed when a
  // turn frees up.
  enter(s: VideoStream): boolean {
    const i = this.waiting.indexOf(s);
    const yields = !s.onScreen && this.waiting.some((w) => w.onScreen);
    if (s.focus || (this.active < this.turns && !yields)) {
      if (i >= 0) this.waiting.splice(i, 1);
      this.active++;
      return true;
    }
    if (i < 0) this.waiting.push(s);
    return false;
  }

  // `s` is done warming up (or closed). `entered`: it held a turn.
  leave(s: VideoStream, entered: boolean): void {
    const i = this.waiting.indexOf(s);
    if (i >= 0) this.waiting.splice(i, 1);
    if (entered) this.active--;
    while (this.active < this.turns && this.waiting.length > 0) {
      const next = Math.max(0, this.waiting.findIndex((w) => w.onScreen));
      this.waiting.splice(next, 1)[0].resume();
    }
  }
}

export class VideoStream {
  readonly key: string;
  readonly createdAt: number;
  state: StreamState = 'loading';
  error: string | null = null;
  // When the decoder was first fed (performance.now() time base); 0 until
  // then, while the first packets load.
  readyAt = 0;
  // Set by the engine each frame: whether any tile still uses this stream,
  // and whether one on screen does.
  used = true;
  onScreen = false;
  // Set by the engine when it opens the stream: it plays a focused clip.
  focus = false;

  private media: Media | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly warmup: Warmup;
  // Holds a warm-up turn; has warmed up (reached its playhead once).
  private warming = false;
  private warm = false;
  private decoder: VideoDecoder | null = null;
  private readonly rangeIn: number;
  private rangeOut: number;
  private loop: number;
  // First packet at or past `rangeOut` (where prefetching wraps).
  private endIndex = 0;
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
  // Last time feeding stopped at a packet that wasn't in yet.
  private starvedAt = 0;

  // `rangeOut` may exceed the media; it is clamped once the packets are
  // known. `size` is the file's, if known.
  constructor(key: string, url: string, size: number | undefined, rangeInUs: number, rangeOutUs: number, cache: MediaCache, warmup: Warmup, now: number) {
    this.key = key;
    this.warmup = warmup;
    this.rangeIn = Math.max(0, Math.round(rangeInUs));
    this.rangeOut = Math.max(this.rangeIn + 1, Math.round(rangeOutUs));
    this.loop = this.rangeOut - this.rangeIn;
    this.createdAt = now;
    cache.get(url, size).then(
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

  // How long (ms) the decoder has had packets to work on without the stream
  // showing a frame: since its first feed, or since it last waited for
  // packets, whichever is later. Waiting on the network isn't the decoder's
  // doing, so it doesn't count.
  stalledFor(now: number): number {
    if (this.state !== 'ready' || this.shown || !this.readyAt) return 0;
    if (!this.media?.packets[this.feedIndex].data) return 0;
    return now - Math.max(this.readyAt, this.starvedAt);
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
    this.prefetch();
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

  // Feeds the decoder after waiting for a warm-up turn.
  resume(): void {
    this.feed();
  }

  close(): void {
    if (this.state === 'closed') return;
    if (!this.warm) this.warmed();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.releaseFrames();
    this.unsubscribe?.();
    this.unsubscribe = null;
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

  private open(media: Media): void {
    if (this.state !== 'loading') return;
    this.media = media;
    const last = media.packets[media.packets.length - 1];
    const end = last.ts + last.dur;
    if (this.rangeOut > end) this.rangeOut = Math.max(this.rangeIn + 1, end);
    this.loop = this.rangeOut - this.rangeIn;
    this.endIndex = media.indexAt(this.rangeOut);
    this.unsubscribe = media.subscribe(() => this.onLoad());
    try {
      this.decoder = new VideoDecoder({ output: (f) => this.onFrame(f), error: (e) => this.fail(e) });
      this.decoder.addEventListener('dequeue', () => this.feed());
      this.state = 'ready';
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
      if (!p.data) {
        // Not in yet: ask now rather than next frame. onLoad feeds on.
        this.starvedAt = performance.now();
        this.prefetch();
        break;
      }
      if (!this.warm && !this.warming) {
        if (!this.warmup.enter(this)) break;
        this.warming = true;
      }
      const ts = this.feedLoop * this.loop + (p.ts - this.rangeIn);
      if (p.ts < this.rangeIn - PREROLL_SLACK_US) this.preroll.add(ts);
      decoder.decode(new EncodedVideoChunk({ type: p.key ? 'key' : 'delta', timestamp: ts, duration: p.dur, data: p.data }));
      if (!this.readyAt) this.readyAt = performance.now();
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

  // Asks the media for the packets the decoder needs next: from the feed
  // position through PREFETCH_MIN_US of playback, on into the next loop when
  // the range ends sooner, topped up to the lead when a request has to go
  // out anyway. While the feed packet itself isn't in (just opened, or after
  // a seek) it asks for the minimum only, which reaches past the playhead
  // (keyframes are at most a second apart) and arrives sooner. A focused
  // stream asks for the lead too, in a second request beside it: its clock
  // keeps playing while it waits, and at a second of video per round trip a
  // slow link never catches the playhead.
  private prefetch(): void {
    const media = this.media;
    if (this.state !== 'ready' || !media || media.complete) return;
    const { packets } = media;
    const played = this.readyAt ? (performance.now() - this.readyAt) * 1000 : 0;
    const max = packets[this.feedIndex].data ? Math.min(PREFETCH_CAP_US, Math.max(PREFETCH_LEAD_US, played)) : PREFETCH_MIN_US;
    let index = this.feedIndex;
    // Playback covered by earlier passes.
    let covered = 0;
    for (let pass = 0; pass < 2 && covered < PREFETCH_MIN_US; pass++) {
      const from = packets[index].ts;
      const to = Math.min(this.endIndex, media.indexAt(from + PREFETCH_MIN_US - covered));
      const extend = Math.min(this.endIndex, media.indexAt(from + max - covered));
      media.load(index, Math.max(to, index + 1), extend);
      if (this.focus && pass === 0 && !packets[this.feedIndex].data && to < this.endIndex) {
        media.load(to, Math.min(this.endIndex, media.indexAt(from + PREFETCH_LEAD_US)));
      }
      covered += this.rangeOut - Math.max(from, this.rangeIn);
      index = this.keyframeBefore(this.rangeIn);
    }
  }

  private onLoad(): void {
    if (this.state !== 'ready') return;
    if (this.media!.error) this.fail(this.media!.error);
    else this.feed();
  }

  private onFrame(frame: VideoFrame): void {
    if (this.state !== 'ready' || this.preroll.delete(frame.timestamp)) {
      frame.close();
      return;
    }
    this.frames.push(frame);
    this.trim();
    if (!this.warm && this.presentable()) this.warmed();
    this.feed();
  }

  // Done warming up: hands the turn on. Later seeks don't take turns.
  private warmed(): void {
    this.warm = true;
    this.warmup.leave(this, this.warming);
    this.warming = false;
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
