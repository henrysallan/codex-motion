// Placement of incoming items (spec: "Adding to collections").
//
// Incoming items start as a compact grid centred on the drop point. Each
// iteration pushes every incoming item out of each overlap along the axis
// of least penetration, against existing items and other incoming ones;
// existing items never move. It stops when nothing overlaps or after 50
// iterations, then falls back to a spiral search outward from the drop
// point for any item still overlapping. A grid hash keeps each check to
// nearby items, so it stays fast on large boards.
//
// Shared by the main thread and tests; no DOM.

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  w: number;
  h: number;
}

const MARGIN = 16;
const MAX_ITERATIONS = 50;
const CELL = 256;

class GridHash {
  private readonly cells = new Map<string, number[]>();
  readonly boxes: Box[] = [];

  add(b: Box): number {
    const i = this.boxes.push(b) - 1;
    this.each(b, (key) => {
      const list = this.cells.get(key);
      if (list) list.push(i);
      else this.cells.set(key, [i]);
    });
    return i;
  }

  // Indices of boxes whose cells touch `b`'s cells.
  near(b: Box, out: Set<number>): Set<number> {
    out.clear();
    this.each(b, (key) => {
      for (const i of this.cells.get(key) ?? []) out.add(i);
    });
    return out;
  }

  private each(b: Box, fn: (key: string) => void): void {
    const x0 = Math.floor((b.x - MARGIN) / CELL);
    const x1 = Math.floor((b.x + b.w + MARGIN) / CELL);
    const y0 = Math.floor((b.y - MARGIN) / CELL);
    const y1 = Math.floor((b.y + b.h + MARGIN) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) fn(`${x},${y}`);
  }
}

// Overlap of a and b, each grown by half the margin; null when apart.
function penetration(a: Box, b: Box, margin: number): { x: number; y: number } | null {
  const px = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + margin;
  const py = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + margin;
  if (px <= 0 || py <= 0) return null;
  // Push direction: away from b's centre.
  const dx = a.x + a.w / 2 - (b.x + b.w / 2);
  const dy = a.y + a.h / 2 - (b.y + b.h / 2);
  return { x: (dx >= 0 ? 1 : -1) * px, y: (dy >= 0 ? 1 : -1) * py };
}

export function overlaps(a: Box, b: Box, margin = MARGIN): boolean {
  return penetration(a, b, margin) !== null;
}

// Lays `sizes` out as a compact grid centred on `center`.
export function compactGrid(sizes: Size[], center: { x: number; y: number }, gap = MARGIN): Box[] {
  const cols = Math.ceil(Math.sqrt(sizes.length));
  const rows: Size[][] = [];
  for (let i = 0; i < sizes.length; i += cols) rows.push(sizes.slice(i, i + cols));
  const rowH = rows.map((r) => Math.max(...r.map((s) => s.h)));
  const rowW = rows.map((r) => r.reduce((a, s) => a + s.w, 0) + gap * (r.length - 1));
  const totalW = Math.max(...rowW);
  const totalH = rowH.reduce((a, h) => a + h, 0) + gap * (rows.length - 1);
  const out: Box[] = [];
  let y = center.y - totalH / 2;
  rows.forEach((r, ri) => {
    let x = center.x - totalW / 2;
    for (const s of r) {
      out.push({ x, y: y + (rowH[ri] - s.h) / 2, w: s.w, h: s.h });
      x += s.w + gap;
    }
    y += rowH[ri] + gap;
  });
  return out;
}

// Final positions for `sizes` dropped at `drop`, given the boxes already on
// the board. Returns boxes in the order of `sizes`.
export function placeIncoming(existing: Box[], sizes: Size[], drop: { x: number; y: number }, margin = MARGIN): Box[] {
  const hash = new GridHash();
  for (const b of existing) hash.add(b);
  const items = compactGrid(sizes, drop, margin);
  const near = new Set<number>();

  let settled = false;
  for (let iter = 0; iter < MAX_ITERATIONS && !settled; iter++) {
    settled = true;
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      for (const j of hash.near(a, near)) {
        const p = penetration(a, hash.boxes[j], margin);
        if (!p) continue;
        settled = false;
        // Existing items never move: incoming takes the whole push.
        if (Math.abs(p.x) < Math.abs(p.y)) a.x += p.x;
        else a.y += p.y;
      }
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        const p = penetration(a, b, margin);
        if (!p) continue;
        settled = false;
        // Two incoming items split the push.
        if (Math.abs(p.x) < Math.abs(p.y)) {
          a.x += p.x / 2;
          b.x -= p.x / 2;
        } else {
          a.y += p.y / 2;
          b.y -= p.y / 2;
        }
      }
    }
  }
  if (settled) return items;

  // Spiral fallback: place items one by one at the nearest free spot.
  const placed = new GridHash();
  for (const b of existing) placed.add(b);
  const free = (b: Box) => {
    for (const j of placed.near(b, near)) if (overlaps(b, placed.boxes[j], margin)) return false;
    return true;
  };
  for (const a of items) {
    if (!free(a)) {
      const step = Math.max(32, Math.min(a.w, a.h) / 4);
      const ox = a.x;
      const oy = a.y;
      search: for (let ring = 1; ring < 400; ring++) {
        const r = ring * step;
        const points = Math.max(8, Math.ceil((2 * Math.PI * r) / step));
        for (let k = 0; k < points; k++) {
          const t = (k / points) * 2 * Math.PI;
          a.x = ox + Math.cos(t) * r;
          a.y = oy + Math.sin(t) * r;
          if (free(a)) break search;
        }
      }
    }
    placed.add(a);
  }
  return items;
}
