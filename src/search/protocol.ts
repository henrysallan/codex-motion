// Messages between the app and the search worker.

import type { PoolItem, SearchQuery, SearchResult } from './engine.ts';

export interface IndexInfo {
  // Clips the bundle covers; 0 when there is no bundle (name search only).
  count: number;
  built: string | null;
  // Text queries must embed with this model to be compared.
  model: string | null;
  dims: number;
}

export type ToSearch =
  // Where the bundle lives: a manifest URL and the base its keys resolve against.
  | { type: 'init'; manifest: string; base: string }
  | { type: 'pool'; items: PoolItem[] }
  // vector: the embedded text; undefined while it's on its way, null when
  // there is none. exclude: ids to leave out (null: none); sent only when
  // it changes.
  | { type: 'query'; seq: number; query: SearchQuery; vector: Float32Array | null | undefined; exclude?: string[] | null };

export type FromSearch =
  | { type: 'ready'; info: IndexInfo }
  | { type: 'error'; message: string }
  | { type: 'result'; seq: number; result: SearchResult };
