// Assigns a tier to every visible item, across all views, each frame.
//
// An item asks for a tier from its on-screen height (device px, with
// hysteresis so zooming near a threshold doesn't flap). Items asking for
// video are ranked by visible area and granted decoders until the budget
// runs out; the rest stay on L0, which is always there. The budget counts
// decoders, not tiles: items showing the same source range on the same
// clock share one stream, so the second one is free. Items just outside a
// view in the pan direction get leftover budget so they are already
// decoding when they arrive. Holders get a bonus so two similar items don't
// trade a decoder back and forth. A focused item takes its original first.

import type { EngineSettings } from './protocol.ts';

// 0 sprite, 1 L1, 2 L2, 3 original.
export type Tier = 0 | 1 | 2 | 3;

export interface Slot {
  // Device-px rect in its view.
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
  // Inside the prefetch margin but not on screen.
  nearby: boolean;
  visibleArea: number;
  // Stream key per video tier (L1, L2, original), null where the asset has
  // no such rendition.
  keys: [string | null, string | null, string | null];
  // Tier the item is currently being given (for hysteresis).
  current: Tier;
  // Lowest tier that has failed to decode for this asset; it and everything
  // above it are off the table.
  blocked: Tier | null;
  focused: boolean;
  // No sprite yet (an upload mid-ingest): only video can show anything.
  needsVideo: boolean;
}

const HYSTERESIS = 0.85;
const INCUMBENT_BONUS = 1.25;
const MAX_PREFETCH = 4;

function wants(s: Slot, settings: EngineSettings): Tier {
  let tier: Tier = 0;
  if (s.focused) tier = 3;
  else {
    const h = s.h;
    if (h >= settings.l1MinHeight || (s.current >= 1 && h >= settings.l1MinHeight * HYSTERESIS)) tier = 1;
    if (h >= settings.l2MinHeight || (s.current >= 2 && h >= settings.l2MinHeight * HYSTERESIS)) tier = 2;
  }
  if (s.needsVideo && tier === 0) tier = 1;
  if (s.blocked !== null && tier >= s.blocked) tier = (s.blocked - 1) as Tier;
  return tier;
}

// Fills `out` with each slot's granted tier (slots granted nothing are left
// out). `budget` is the effective decoder budget, which the engine may hold
// below settings.decoderBudget while the device is overloaded.
export function plan(slots: Slot[], settings: EngineSettings, budget: number, out: Map<Slot, Tier>): void {
  out.clear();
  const granted = new Set<string>();
  let units = budget;
  const cost = (t: Tier) => (t >= 2 ? settings.l2Cost : 1);

  // Grants the best tier at or below `want` that is affordable or already
  // being decoded for someone else.
  const grant = (s: Slot, want: Tier, maxTier: Tier = 3): boolean => {
    for (let t = Math.min(want, maxTier) as Tier; t >= 1; t--) {
      const key = s.keys[t - 1];
      if (!key) continue;
      if (granted.has(key)) {
        out.set(s, t);
        return true;
      }
      if (units >= cost(t)) {
        granted.add(key);
        units -= cost(t);
        out.set(s, t);
        return true;
      }
    }
    return false;
  };

  const visible: { slot: Slot; want: Tier; score: number }[] = [];
  const nearby: { slot: Slot; want: Tier; score: number }[] = [];
  for (const s of slots) {
    if (!s.visible && !s.nearby) continue;
    const want = wants(s, settings);
    if (want === 0) continue;
    const bonus = s.current > 0 ? INCUMBENT_BONUS : 1;
    const score = s.focused ? Infinity : s.needsVideo ? 1e12 : (s.visible ? s.visibleArea : s.w * s.h) * bonus;
    (s.visible ? visible : nearby).push({ slot: s, want, score });
  }
  visible.sort((a, b) => b.score - a.score);
  for (const c of visible) grant(c.slot, c.want);

  if (!settings.prefetch) return;
  // Prefetch starts at L1 (cheap, upgraded once on screen); an item that
  // just left the view keeps what it has so panning back is instant.
  nearby.sort((a, b) => b.score - a.score);
  let prefetched = 0;
  for (const c of nearby) {
    if (prefetched >= MAX_PREFETCH) break;
    const keep = c.slot.current >= 2 && c.want >= 2 ? c.slot.current : 1;
    if (grant(c.slot, c.want, keep as Tier)) prefetched++;
  }
}
