// The Feed's view options (the menu in ViewMenu.tsx) and the two layouts
// they pick between: justified rows of tiles ("grid"), or a database list
// with a thumbnail and a few lines of metadata per clip, in one or two
// columns ("list"). Geometry only; FeedPane mounts the cells.

import { justifiedRows } from '../layout/arrange.ts';
import type { Box } from '../layout/relax.ts';

export type FeedView = 'grid' | 'list';

export interface FeedLayout {
  view: FeedView;
  // Multiples of the default size: the grid's row height, the list's
  // thumbnail height. Each view keeps its own.
  gridSize: number;
  listSize: number;
  // The grid's gutter, 0..1. The default 0.1 is the original 6px gap at the
  // default size; 1 is half a row. It scales with the size.
  gutter: number;
  columns: 1 | 2;
}

export const defaultFeedLayout: FeedLayout = { view: 'grid', gridSize: 1, listSize: 1, gutter: 0.1, columns: 1 };

export const SIZE_MIN = 0.5;
export const SIZE_MAX = 3;

const PAD = 12;
const ROW_H = 120;
// List: thumbnail height and shape at the default size, the inset around it
// (the row's hover and selection area), the gaps between rows and columns,
// and the least room the text gets.
const THUMB_H = 54;
const THUMB_ASPECT = 16 / 9;
export const ROW_INSET = 4;
const ROW_GAP = 2;
const COLUMN_GAP = 8;
const MIN_TEXT = 140;

// A clip's place: the cell is its hit area (a grid tile, a list row); the
// media box is where the engine draws it, cropped to fill in the list.
export interface FeedCell extends Box {
  media: Box;
}

export const gridGap = (l: FeedLayout) => l.gutter * ROW_H * l.gridSize * 0.5;

// Cells in `aspects` order and the content height, for a pane `width` wide.
export function feedCells(aspects: number[], width: number, l: FeedLayout): { cells: FeedCell[]; height: number } {
  return l.view === 'list' ? listCells(aspects, width, l) : gridCells(aspects, width, l);
}

function gridCells(aspects: number[], width: number, l: FeedLayout) {
  const gap = gridGap(l);
  // Wide gutters get a margin to match.
  const pad = Math.max(PAD, gap);
  const top = 2 + pad - PAD;
  const inner = width - pad * 2;
  if (inner <= 0) return { cells: [], height: 0 };
  const boxes = justifiedRows(aspects, inner, ROW_H * l.gridSize, gap);
  const cells = boxes.map((b) => {
    const box = { x: b.x + pad, y: b.y + top, w: b.w, h: b.h };
    return { ...box, media: box };
  });
  const last = boxes[boxes.length - 1];
  return { cells, height: last ? top + last.y + last.h + pad : 0 };
}

function listCells(aspects: number[], width: number, l: FeedLayout) {
  const inner = width - PAD * 2;
  if (inner <= 0) return { cells: [], height: 0 };
  const cols = l.columns;
  const colW = (inner - COLUMN_GAP * (cols - 1)) / cols;
  // The thumbnail leaves the text MIN_TEXT, unless that would shrink it
  // under 40% of a narrow column. Narrowed, it crops squarer (down to 1:1)
  // before it gets shorter, so the row keeps its lines.
  const thumbW = Math.min(THUMB_H * l.listSize * THUMB_ASPECT, Math.max(colW * 0.4, colW - MIN_TEXT));
  const thumbH = Math.min(THUMB_H * l.listSize, thumbW);
  const rowH = thumbH + ROW_INSET * 2;
  const cells = aspects.map((_, i) => {
    const x = PAD + (i % cols) * (colW + COLUMN_GAP);
    const y = 2 + Math.floor(i / cols) * (rowH + ROW_GAP);
    return { x, y, w: colW, h: rowH, media: { x: x + ROW_INSET, y: y + ROW_INSET, w: thumbW, h: thumbH } };
  });
  const rows = Math.ceil(aspects.length / cols);
  return { cells, height: rows ? 2 + rows * (rowH + ROW_GAP) - ROW_GAP + PAD : 0 };
}
