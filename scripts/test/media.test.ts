// Checks for the render worker's MP4 index and ranged media loading, against
// files muxed by mediabunny: run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BufferSource, BufferTarget, EncodedPacket, EncodedPacketSink, EncodedVideoPacketSource, Input, MP4, Mp4OutputFormat, Output } from 'mediabunny';
import { HEAD_BYTES, type Media, openFile } from '../../src/engine/demux.ts';
import { readBox, readSampleTable } from '../../src/engine/mp4.ts';
import type { RangedFile } from '../../src/engine/storage.ts';

// avcC of an 854x480 H.264 High proxy.
const AVCC = Uint8Array.from(Buffer.from('0164001fffe100206764001facb201b07bcdffe0a000a02d4040405000003e90000ea600f183248001000668ebc3cb22c0fdf8f800', 'hex'));
const FPS = 30;

// One length-prefixed NAL unit per packet, its bytes unique to the packet so
// a misplaced range shows.
function packetData(i: number, size: number, key: boolean): Uint8Array {
  const data = new Uint8Array(size);
  new DataView(data.buffer).setUint32(0, size - 4);
  data[4] = key ? 0x65 : 0x41;
  for (let k = 5; k < size; k++) data[k] = (i * 31 + k) & 255;
  return data;
}

// `count` packets at 30 fps, a keyframe every second, sizes varying.
async function makeMp4(count: number, fastStart: false | 'in-memory' | 'fragmented'): Promise<Uint8Array> {
  const output = new Output({ format: new Mp4OutputFormat({ fastStart }), target: new BufferTarget() });
  const source = new EncodedVideoPacketSource('avc');
  output.addVideoTrack(source, { frameRate: FPS });
  await output.start();
  for (let i = 0; i < count; i++) {
    const key = i % FPS === 0;
    const meta = i === 0 ? { decoderConfig: { codec: 'avc1.64001f', codedWidth: 854, codedHeight: 480, description: AVCC } } : undefined;
    await source.add(new EncodedPacket(packetData(i, 1500 + ((i * 7919) % 4000), key), key ? 'key' : 'delta', i / FPS, 1 / FPS), meta);
  }
  await output.finalize();
  return new Uint8Array(output.target.buffer!);
}

async function mediabunnyPackets(bytes: Uint8Array) {
  const input = new Input({ formats: [MP4], source: new BufferSource(bytes) });
  const track = (await input.getPrimaryVideoTrack())!;
  const packets: EncodedPacket[] = [];
  for await (const p of new EncodedPacketSink(track).packets()) packets.push(p);
  return { track, packets };
}

// A file read from memory, logging every read after the head.
function memoryFile(bytes: Uint8Array): { file: RangedFile; reads: [number, number][] } {
  const reads: [number, number][] = [];
  return {
    reads,
    file: {
      size: bytes.length,
      head: bytes.slice(0, HEAD_BYTES),
      read: async (start, end) => {
        reads.push([start, end]);
        return bytes.slice(start, end);
      },
    },
  };
}

function moovOf(bytes: Uint8Array): Uint8Array {
  for (let at = 0; at < bytes.length; ) {
    const box = readBox(bytes, at)!;
    if (box.type === 'moov') return bytes.subarray(box.start, box.end);
    at = box.end;
  }
  throw new Error('no moov');
}

// Loads packets [from, to) and waits for the request to land.
function load(media: Media, from: number, to: number, extend = to): Promise<void> {
  return new Promise((resolve) => {
    const off = media.subscribe(() => {
      off();
      resolve();
    });
    media.load(from, to, extend);
  });
}

for (const fastStart of ['in-memory', false] as const) {
  test(`sample table matches mediabunny's packets (fastStart: ${fastStart})`, async () => {
    const bytes = await makeMp4(95, fastStart);
    const { track, packets } = await mediabunnyPackets(bytes);
    const table = readSampleTable(moovOf(bytes), track.id)!;
    assert.equal(table.sizes.length, packets.length);
    packets.forEach((p, i) => {
      assert.equal(table.pts[i] / table.timescale, p.timestamp, `pts ${i}`);
      assert.equal(table.durations[i] / table.timescale, p.duration, `duration ${i}`);
      assert.equal(table.keys[i] === 1, p.type === 'key', `key ${i}`);
      assert.deepEqual(bytes.subarray(table.offsets[i], table.offsets[i] + table.sizes[i]), p.data, `bytes ${i}`);
    });
  });
}

test('a faststart file opens from its head alone, and loads packets in ranges', async () => {
  const bytes = await makeMp4(600, 'in-memory');
  assert.ok(bytes.length > 4 * HEAD_BYTES);
  const { packets } = await mediabunnyPackets(bytes);
  const { file, reads } = memoryFile(bytes);
  const media = await openFile('test', file);
  assert.deepEqual(reads, []);
  assert.equal(media.config.codec, 'avc1.64001f');
  assert.equal(media.packets.length, 600);
  assert.deepEqual(media.keyframes, [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360, 390, 420, 450, 480, 510, 540, 570]);
  assert.equal(media.packets[45].ts, 1_500_000);
  assert.equal(media.indexAt(1_500_000), 45);
  assert.equal(media.complete, false);
  // The packets that fit in the head come with it.
  assert.ok(media.packets[0].data);
  assert.equal(media.packets[599].data, null);

  // One request for 300..329, then nothing more while those are in.
  await load(media, 300, 310, 330);
  assert.equal(reads.length, 1);
  for (let i = 300; i < 330; i++) assert.deepEqual(media.packets[i].data, packets[i].data, `packet ${i}`);
  assert.equal(media.packets[330].data, null);
  media.load(300, 330);
  assert.equal(reads.length, 1);

  // Everything, a request at a time.
  for (let i = 0; i < 600; i++) if (!media.packets[i].data) await load(media, i, 600);
  assert.equal(media.complete, true);
  media.packets.forEach((p, i) => assert.deepEqual(p.data, packets[i].data, `packet ${i}`));
});

test('a file with its moov at the end opens with a couple of reads', async () => {
  const bytes = await makeMp4(600, false);
  const { packets } = await mediabunnyPackets(bytes);
  const { file, reads } = memoryFile(bytes);
  const media = await openFile('test', file);
  assert.ok(reads.length <= 2, JSON.stringify(reads));
  assert.equal(media.packets.length, 600);
  await load(media, 500, 510);
  assert.deepEqual(media.packets[505].data, packets[505].data);
});

test('a file no longer than the head is complete when opened', async () => {
  const bytes = await makeMp4(10, 'in-memory');
  assert.ok(bytes.length < HEAD_BYTES);
  const { file, reads } = memoryFile(bytes);
  const media = await openFile('test', file);
  assert.equal(media.complete, true);
  assert.deepEqual(reads, []);
});

test('a fragmented MP4 is read whole', async () => {
  const bytes = await makeMp4(300, 'fragmented');
  const { packets } = await mediabunnyPackets(bytes);
  const { file, reads } = memoryFile(bytes);
  const media = await openFile('test', file);
  assert.deepEqual(reads.at(-1), [0, bytes.length]);
  assert.equal(media.complete, true);
  assert.equal(media.packets.length, packets.length);
  assert.deepEqual(media.packets[123].data, packets[123].data);
});
