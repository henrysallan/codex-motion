// Checks for how a VideoStream loads as it starts: run with `npm test`.
// WebCodecs isn't in Node, so a stand-in decoder takes the packets.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Media, type MediaCache, type Packet } from '../../src/engine/demux.ts';
import type { RangedFile } from '../../src/engine/storage.ts';
import { VideoStream, Warmup } from '../../src/engine/stream.ts';

class StandInDecoder {
  state = 'unconfigured';
  decodeQueueSize = 0;
  configure() {
    this.state = 'configured';
  }
  reset() {
    this.state = 'unconfigured';
  }
  decode() {}
  close() {
    this.state = 'closed';
  }
  addEventListener() {}
}
class StandInChunk {
  constructor(init: object) {
    Object.assign(this, init);
  }
}
Object.assign(globalThis, { VideoDecoder: StandInDecoder, EncodedVideoChunk: StandInChunk });

const FPS = 30;
const SIZE = 20_000;
const BASE = 65_536;
const at = (i: number) => BASE + i * SIZE;

// 20 s at 30 fps, a keyframe every second, every packet 20 KB, none loaded.
// Reads are logged; the first `answer` of them return bytes, the rest hang.
function media(answer: number) {
  const packets: Packet[] = Array.from({ length: 20 * FPS }, (_, i) => ({
    ts: Math.round((i * 1e6) / FPS),
    dur: Math.round(1e6 / FPS),
    key: i % FPS === 0,
    offset: at(i),
    size: SIZE,
    data: null,
  }));
  const reads: [number, number][] = [];
  const file: RangedFile = {
    size: at(packets.length),
    head: new Uint8Array(0),
    read: (start, end) => {
      reads.push([start, end]);
      return reads.length <= answer ? Promise.resolve(new Uint8Array(end - start)) : new Promise(() => {});
    },
  };
  return { media: new Media({ codec: 'avc1.64001f' }, packets, file), reads };
}

async function open(o: { focus: boolean; target: number; answer?: number }) {
  const { media: m, reads } = media(o.answer ?? 0);
  const cache = { get: () => Promise.resolve(m) } as unknown as MediaCache;
  const s = new VideoStream('k', 'u', undefined, 0, 20e6, cache, new Warmup(2), 0);
  s.focus = o.focus;
  s.update(o.target);
  // Let it open, seek and ask for packets (and take any answers).
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return { s, reads };
}

test('a stream starting cold asks for a second of video from the keyframe before its playhead', async () => {
  const { reads } = await open({ focus: false, target: 5_500_000 });
  assert.deepEqual(reads, [[at(150), at(180)]]);
});

test('a focused stream starting cold asks for the seconds after that too, at the same time', async () => {
  const { reads } = await open({ focus: true, target: 5_500_000 });
  assert.deepEqual(reads, [
    [at(150), at(180)],
    [at(180), at(240)],
  ]);
});

test('a decoder that has its packets counts as stalled until it shows a frame', async () => {
  const { s } = await open({ focus: false, target: 5_500_000, answer: 1 });
  assert.ok(s.stalledFor(performance.now() + 2000) >= 2000);
});

test('waiting for packets past the playhead does not count as a stall', async () => {
  // Fed to 6 s, but the lookahead past 5.95 s needs the next request's packets.
  const { s, reads } = await open({ focus: false, target: 5_950_000, answer: 1 });
  assert.equal(reads.length, 2);
  assert.equal(s.stalledFor(performance.now() + 2000), 0);
});
