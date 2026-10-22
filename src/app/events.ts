// A small typed event bus for things that cross panes: clips added to a
// collection (the canvas animates them in), and drags that carry clips
// from the Feed onto the canvas.

import type { Point } from '../data/model.ts';

export interface Events {
  // New placements, and where they should appear to fly in from.
  added: { collectionId: string; ids: string[]; from: Point | null };
}

type Handler<T> = (payload: T) => void;
const handlers: { [K in keyof Events]?: Set<Handler<Events[K]>> } = {};

export function on<K extends keyof Events>(type: K, fn: Handler<Events[K]>): () => void {
  const set = (handlers[type] ??= new Set()) as Set<Handler<Events[K]>>;
  set.add(fn);
  return () => set.delete(fn);
}

export function emit<K extends keyof Events>(type: K, payload: Events[K]): void {
  for (const fn of (handlers[type] ?? []) as Set<Handler<Events[K]>>) fn(payload);
}

// A drag of Feed clips in progress. Drop targets register a hit test; the
// first that accepts the pointer position takes the drop.
export interface DropTarget {
  accepts(clientX: number, clientY: number): boolean;
  drop(assetIds: string[], clientX: number, clientY: number): void;
  hover?(clientX: number, clientY: number, over: boolean): void;
}

export const dropTargets = new Set<DropTarget>();
