// Checks for the L0 atlas cell allocator: run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATLAS_SIZE, type AtlasEntry, CellAllocator } from '../../src/engine/cells.ts';

const FRAMES = 24;
// 16:9 and 4:5 sprite frames, 128 px tall.
const WIDE = 228;
const TALL = 104;

const alloc = (o: Partial<{ layers: number; softCap: number; hardCap: number }> = {}) => {
  const grows: [number, number][] = [];
  const a = new CellAllocator({ layers: 4, softCap: 16, hardCap: 32, ...o, onGrow: (from, to) => grows.push([from, to]) });
  return { a, grows };
};

// No two frames of any resident sprites share texels, and every frame is
// inside its layer.
function assertDisjoint(entries: AtlasEntry[], layers: number) {
  const rects = entries.flatMap((e) => e.frames.map((f) => ({ ...f, w: e.frameWidth, h: e.frameHeight, key: e.key })));
  for (const r of rects) {
    assert.ok(r.layer >= 0 && r.layer < layers, `layer ${r.layer} of ${layers}`);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= ATLAS_SIZE && r.y + r.h <= ATLAS_SIZE, `frame out of layer: ${JSON.stringify(r)}`);
    assert.equal(r.x % 4, 0);
    assert.equal(r.y % 4, 0);
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const p = rects[i];
      const q = rects[j];
      const overlap = p.layer === q.layer && p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
      assert.ok(!overlap, `${p.key} and ${q.key} overlap`);
    }
  }
}

test('cells hold every frame without overlap, packing a class into its layers', () => {
  const { a } = alloc();
  const entries: AtlasEntry[] = [];
  for (let i = 0; i < 12; i++) entries.push(a.allocate(`w${i}`, WIDE, 128, FRAMES)!);
  for (let i = 0; i < 12; i++) entries.push(a.allocate(`t${i}`, TALL, 128, FRAMES)!);
  assert.equal(a.size, 24);
  assertDisjoint(entries, a.layerCount);
  // 12 sprites take 288 cells: 3 layers of 8 x 16 16:9 cells, but one of
  // 19 x 16 4:5 cells.
  assert.equal(a.layersInUse, 3 + 1);
  assert.equal(a.allocate('w0', WIDE, 128, FRAMES), entries[0], 'same key returns the resident entry');
});

test('the texture doubles up to the soft cap, then evicts the least recently used', () => {
  const { a, grows } = alloc({ softCap: 16 });
  // 16 layers of 16:9 cells hold 16 * 128 / 24 = 85 sprites.
  for (let i = 0; i < 85; i++) {
    a.clock++;
    assert.ok(a.allocate(`s${i}`, WIDE, 128, FRAMES));
  }
  assert.deepEqual(grows, [[4, 8], [8, 16]]);
  assert.equal(a.evictions, 0);
  a.clock++;
  assert.ok(a.allocate('next', WIDE, 128, FRAMES));
  assert.equal(a.layerCount, 16, 'stays at the cap');
  assert.equal(a.evictions, 1);
  assert.equal(a.get('s0'), undefined, 'oldest went first');
  assert.ok(a.get('s1'));
});

test('sprites in use this frame are never evicted; past the cap the texture grows instead', () => {
  const { a, grows } = alloc({ softCap: 8, hardCap: 48 });
  const keys: string[] = [];
  for (let i = 0; i < 42; i++) {
    keys.push(`s${i}`);
    a.allocate(`s${i}`, WIDE, 128, FRAMES);
  }
  // A new frame in which every resident sprite is touched (a board).
  a.clock++;
  for (const k of keys) a.get(k)!.usedAt = a.clock;
  const more = a.allocate('more', WIDE, 128, FRAMES);
  assert.ok(more);
  assert.equal(a.evictions, 0);
  assert.equal(a.size, 43);
  assert.ok(a.layerCount > 8, 'grew past the soft cap');
  assert.deepEqual(grows.at(-1), [8, 40]);
});

test('refuses only at the hard cap with everything in use', () => {
  const { a } = alloc({ layers: 1, softCap: 1, hardCap: 1 });
  // One 16:9 layer holds 5 sprites (128 cells / 24).
  for (let i = 0; i < 5; i++) assert.ok(a.allocate(`s${i}`, WIDE, 128, FRAMES));
  for (const k of a.keys()) a.get(k)!.usedAt = a.clock;
  assert.equal(a.allocate('x', WIDE, 128, FRAMES), null);
  // Once idle, the oldest makes room.
  a.clock++;
  assert.ok(a.allocate('x', WIDE, 128, FRAMES));
  assert.equal(a.size, 5);
});

test('a layer of idle sprites goes to another class when that is older', () => {
  const { a } = alloc({ layers: 2, softCap: 2, hardCap: 2 });
  // Layer 0: 16:9 sprites, used long ago. Layer 1: 4:5 sprites, recent.
  for (let i = 0; i < 5; i++) a.allocate(`w${i}`, WIDE, 128, FRAMES);
  a.clock += 10;
  for (let i = 0; i < 12; i++) a.allocate(`t${i}`, TALL, 128, FRAMES);
  a.clock++;
  // A square sprite has no layer of its own and none free: the stale 16:9
  // layer is cleared for it rather than the newer 4:5 sprites.
  const sq = a.allocate('sq', 128, 128, FRAMES);
  assert.ok(sq);
  assert.equal(sq.frames[0].layer, 0);
  for (let i = 0; i < 5; i++) assert.equal(a.get(`w${i}`), undefined);
  for (let i = 0; i < 12; i++) assert.ok(a.get(`t${i}`));
  assertDisjoint([...a.keys()].map((k) => a.get(k)!), a.layerCount);
});

test('released layers return to the pool, and churn never overlaps frames', () => {
  const { a } = alloc({ softCap: 12, hardCap: 12 });
  const widths = [228, 104, 128, 212, 96, 72, 512, 172];
  let n = 0;
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let round = 0; round < 2000; round++) {
    a.clock++;
    const w = widths[Math.floor(rnd() * widths.length)];
    const frames = rnd() < 0.1 ? 1 + Math.floor(rnd() * 23) : FRAMES;
    assert.ok(a.allocate(`k${n++}`, w, 128, frames), `round ${round}`);
    if (rnd() < 0.2) {
      const keys = [...a.keys()];
      a.release(keys[Math.floor(rnd() * keys.length)]);
    }
  }
  assert.equal(a.layerCount, 12);
  assertDisjoint([...a.keys()].map((k) => a.get(k)!), a.layerCount);
  for (const k of [...a.keys()]) a.release(k);
  assert.equal(a.size, 0);
  assert.equal(a.layersInUse, 0);
});
