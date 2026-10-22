// Layout helpers: justified rows (the Feed, seeded boards) and "arrange
// selection" on the canvas. All sizes in world units; no DOM.

import type { Box, Size } from './relax.ts';

// Rows of uniform height that exactly fill `width`, like a photo grid.
// The last row keeps the target height rather than stretching.
export function justifiedRows(aspects: number[], width: number, rowHeight: number | (() => number), gap: number): Box[] {
  const target = typeof rowHeight === 'number' ? () => rowHeight : rowHeight;
  const out: Box[] = [];
  let y = 0;
  let row: number[] = [];
  let h = target();
  const flush = (height: number) => {
    let x = 0;
    for (const a of row) {
      out.push({ x, y, w: a * height, h: height });
      x += a * height + gap;
    }
    y += height + gap;
    row = [];
    h = target();
  };
  for (const a of aspects) {
    row.push(a);
    const sum = row.reduce((s, r) => s + r, 0);
    const gaps = gap * (row.length - 1);
    if (sum * h + gaps >= width) flush((width - gaps) / sum);
  }
  if (row.length) flush(Math.min(h, (width - gap * (row.length - 1)) / row.reduce((s, r) => s + r, 0)));
  return out;
}

// Reading order: rows top to bottom (items whose centres are within half a
// height of each other count as one row), then left to right.
function readingOrder(boxes: Box[]): number[] {
  const idx = boxes.map((_, i) => i);
  const cy = (b: Box) => b.y + b.h / 2;
  idx.sort((a, b) => cy(boxes[a]) - cy(boxes[b]));
  const rows: number[][] = [];
  for (const i of idx) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(cy(boxes[i]) - cy(boxes[row[0]])) < boxes[row[0]].h / 2) row.push(i);
    else rows.push([i]);
  }
  return rows.flatMap((r) => r.sort((a, b) => boxes[a].x - boxes[b].x));
}

// New boxes for `boxes` arranged from their bounding box's top-left:
// 'row' puts everything in one row at a common height; 'grid' wraps rows at
// a width that makes the block roughly 4:3.
export function arrange(boxes: Box[], mode: 'grid' | 'row', gap = 16): Box[] {
  if (boxes.length === 0) return [];
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const order = readingOrder(boxes);
  // Common height: the median, so one outlier doesn't resize the rest.
  const heights = boxes.map((b) => b.h).sort((a, b) => a - b);
  const h = heights[Math.floor(heights.length / 2)];
  const sizes: Size[] = order.map((i) => ({ w: (boxes[i].w / boxes[i].h) * h, h }));
  const out: Box[] = new Array(boxes.length);
  if (mode === 'row') {
    let x = x0;
    order.forEach((i, k) => {
      out[i] = { x, y: y0, w: sizes[k].w, h };
      x += sizes[k].w + gap;
    });
    return out;
  }
  const area = sizes.reduce((a, s) => a + (s.w + gap) * (h + gap), 0);
  const width = Math.max(Math.max(...sizes.map((s) => s.w)), Math.sqrt(area * (4 / 3)));
  let x = x0;
  let y = y0;
  order.forEach((i, k) => {
    if (x > x0 && x + sizes[k].w > x0 + width) {
      x = x0;
      y += h + gap;
    }
    out[i] = { x, y, w: sizes[k].w, h };
    x += sizes[k].w + gap;
  });
  return out;
}

export function bounds(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
