// Checks for the placement algorithms: run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrange, justifiedRows } from '../../src/app/layout/arrange.ts';
import { type Box, compactGrid, overlaps, placeIncoming } from '../../src/app/layout/relax.ts';

const anyOverlap = (boxes: Box[], margin: number) => {
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (overlaps(boxes[i], boxes[j], margin - 0.01)) return [i, j];
  return null;
};

test('compact grid is centred on the drop point', () => {
  const g = compactGrid([{ w: 100, h: 50 }, { w: 100, h: 50 }, { w: 100, h: 50 }, { w: 100, h: 50 }], { x: 0, y: 0 }, 10);
  const cx = (Math.min(...g.map((b) => b.x)) + Math.max(...g.map((b) => b.x + b.w))) / 2;
  const cy = (Math.min(...g.map((b) => b.y)) + Math.max(...g.map((b) => b.y + b.h))) / 2;
  assert.ok(Math.abs(cx) < 1e-9 && Math.abs(cy) < 1e-9);
  assert.equal(anyOverlap(g, 10), null);
});

test('incoming items relax off a crowded board without moving it', () => {
  // A dense 10x10 board around the origin.
  const existing: Box[] = [];
  for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) existing.push({ x: i * 220, y: j * 140, w: 200, h: 120 });
  const before = JSON.stringify(existing);
  const sizes = Array.from({ length: 9 }, () => ({ w: 160, h: 90 }));
  const placed = placeIncoming(existing, sizes, { x: 1000, y: 700 });
  assert.equal(JSON.stringify(existing), before, 'existing items moved');
  assert.equal(anyOverlap([...existing, ...placed], 16), null);
});

test('drop on empty space keeps items at the drop point', () => {
  const placed = placeIncoming([{ x: 0, y: 0, w: 100, h: 100 }], [{ w: 50, h: 50 }], { x: 1000, y: 1000 });
  assert.deepEqual(placed[0], { x: 975, y: 975, w: 50, h: 50 });
});

test('relaxation stays near the drop point', () => {
  const existing = [{ x: -100, y: -100, w: 200, h: 200 }];
  const [p] = placeIncoming(existing, [{ w: 100, h: 100 }], { x: 0, y: 0 });
  assert.ok(Math.hypot(p.x + 50, p.y + 50) < 220, `landed at ${p.x},${p.y}`);
  assert.equal(anyOverlap([...existing, p], 16), null);
});

test('justified rows fill the width', () => {
  const rows = justifiedRows([1.78, 0.56, 1, 1.78, 1.25, 0.8, 1.78, 2.39], 1000, 200, 10);
  const firstRow = rows.filter((b) => b.y === 0);
  const right = Math.max(...firstRow.map((b) => b.x + b.w));
  assert.ok(Math.abs(right - 1000) < 1e-6);
});

test('arrange as a row shares one height and keeps order', () => {
  const boxes = [
    { x: 300, y: 0, w: 160, h: 90 },
    { x: 0, y: 10, w: 100, h: 100 },
  ];
  const out = arrange(boxes, 'row', 10);
  assert.equal(out[0].h, out[1].h);
  assert.ok(out[1].x < out[0].x, 'left item stays first');
  assert.equal(anyOverlap(out, 10), null);
});
