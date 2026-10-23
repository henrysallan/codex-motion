// The data model from the spec, as stored locally. The shapes mirror the
// planned Postgres tables so a sync layer can push them unchanged: every
// record is saved whole, last writer wins.

import type { Asset } from '../media/library.ts';

export interface AssetRecord extends Asset {
  origin: 'library' | 'upload' | 'scraper';
  status: 'ready' | 'processing' | 'error';
  // While processing: 0..1.
  progress?: number;
  error?: string;
  addedBy: string;
  addedAt: number;
  sourceUrl?: string;
  sourceTitle?: string;
  // Uploads: whether every rendition is in cloud storage yet. Until then
  // the cloud row says "processing", so other devices don't fetch them.
  uploaded?: boolean;
}

export interface Point {
  x: number;
  y: number;
}

export interface Collection {
  id: string;
  name: string;
  // Null: the first placement stands in.
  coverAssetId: string | null;
  // Where the last batch of added items settled, in canvas coordinates.
  lastDrop: Point | null;
  // The owner: only they can edit it.
  createdBy: string;
  // Published read-only at /c/<slug>.
  isPublic: boolean;
  slug: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Placement {
  id: string;
  collectionId: string;
  assetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  z: number;
  // Source range in seconds; null plays the whole clip.
  inPoint: number | null;
  outPoint: number | null;
  addedBy: string;
  addedAt: number;
}

export type TextSize = 'h1' | 'h2' | 'h3' | 'body';

// Formatting applies to a whole text box.
export interface NoteFormat {
  size: TextSize;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

// A text box on the board. Text wraps at its width; it is at least `h` tall
// and grows to fit its text (null: as tall as the text).
export interface Note extends NoteFormat {
  id: string;
  collectionId: string;
  x: number;
  y: number;
  w: number;
  h: number | null;
  text: string;
  z: number;
}

export const DEFAULT_FORMAT: NoteFormat = { size: 'body', bold: false, italic: false, underline: false };

// Notes saved before boxes had a height or formatting.
export function withNoteDefaults(n: Partial<Note> & Pick<Note, 'id' | 'collectionId' | 'x' | 'y' | 'w' | 'text' | 'z'>): Note {
  return { ...DEFAULT_FORMAT, h: null, ...n };
}

export interface User {
  id: string;
  name: string;
  color: string;
  avatarUrl?: string | null;
  // Default destination for items added from the Feed.
  activeTargetId: string | null;
}

export const newId = () => crypto.randomUUID();
