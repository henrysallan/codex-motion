// Checks for the tier scheduler: run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings } from '../../src/engine/protocol.ts';
import { plan, type Slot, type Tier } from '../../src/engine/scheduler.ts';

// A visible Feed-sized tile (240 device px tall, over l1MinHeight).
const slot = (o: Partial<Slot> = {}): Slot => ({
  x: 0,
  y: 0,
  w: 427,
  h: 240,
  visible: true,
  nearby: false,
  visibleArea: 427 * 240,
  keys: [`l1-${Math.random()}`, `l2-${Math.random()}`, null],
  current: 0,
  blocked: null,
  focused: false,
  needsVideo: false,
  fastScroll: false,
  ...o,
});

const tiers = (slots: Slot[], budget = defaultSettings.decoderBudget) => {
  const out = new Map<Slot, Tier>();
  plan(slots, defaultSettings, budget, out);
  return slots.map((s) => out.get(s) ?? 0);
};

test('tiles over l1MinHeight get L1, and big ones L2', () => {
  assert.deepEqual(tiers([slot(), slot({ h: 700, w: 1244 })]), [1, 2]);
});

test('a fast scroll starts no new video, on screen or ahead of it', () => {
  const fast = { fastScroll: true };
  assert.deepEqual(tiers([slot(fast), slot({ ...fast, visible: false, nearby: true, visibleArea: 0 }), slot({ ...fast, needsVideo: true })]), [0, 0, 0]);
});

test('a fast scroll keeps decoders that are already running, without upgrading them', () => {
  const held = slot({ fastScroll: true, current: 1 });
  const grown = slot({ fastScroll: true, current: 1, h: 700, w: 1244 });
  const leaving = slot({ fastScroll: true, current: 1, visible: false, nearby: true, visibleArea: 0 });
  assert.deepEqual(tiers([held, grown, leaving]), [1, 1, 1]);
  // Shrinking below the threshold still drops them.
  assert.deepEqual(tiers([slot({ fastScroll: true, current: 1, h: 100 })]), [0]);
});

test('promotion resumes once the scroll slows', () => {
  const s = slot({ fastScroll: true });
  assert.deepEqual(tiers([s]), [0]);
  s.fastScroll = false;
  assert.deepEqual(tiers([s]), [1]);
});
