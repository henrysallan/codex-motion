// Checks for the stream warm-up turns: run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type VideoStream, Warmup } from '../../src/engine/stream.ts';

const stream = (o: { onScreen?: boolean; focus?: boolean } = {}) => {
  const s = { onScreen: true, focus: false, resumed: 0, ...o, resume: () => s.resumed++ };
  return s as typeof s & VideoStream;
};

test('streams take turns to warm up', () => {
  const w = new Warmup(2);
  const [a, b, c] = [stream(), stream(), stream()];
  assert.equal(w.enter(a), true);
  assert.equal(w.enter(b), true);
  assert.equal(w.enter(c), false);
  w.leave(a, true);
  assert.equal(c.resumed, 1);
});

test("a focused stream warms up at once, without taking a waiting stream's turn", () => {
  const w = new Warmup(2);
  const [a, b, c] = [stream(), stream(), stream()];
  w.enter(a);
  w.enter(b);
  w.enter(c);
  const focused = stream({ focus: true });
  assert.equal(w.enter(focused), true);
  w.leave(focused, true);
  assert.equal(c.resumed, 0);
  w.leave(a, true);
  assert.equal(c.resumed, 1);
});
