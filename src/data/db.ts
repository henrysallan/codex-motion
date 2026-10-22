// Local persistence in IndexedDB. Collections, placements, notes and asset
// metadata each live in their own store and are written per record, so an
// edit to one placement never rewrites a board. Media bytes live in OPFS
// (see ingest/) and the server library, never here.

import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import type { AssetRecord, Collection, Note, Placement, User } from './model.ts';

interface TraceDB extends DBSchema {
  assets: { key: string; value: AssetRecord };
  collections: { key: string; value: Collection };
  placements: { key: string; value: Placement; indexes: { collection: string } };
  notes: { key: string; value: Note; indexes: { collection: string } };
  meta: { key: string; value: unknown };
}

export type StoreName = 'assets' | 'collections' | 'placements' | 'notes';

let db: Promise<IDBPDatabase<TraceDB>> | null = null;

function open(): Promise<IDBPDatabase<TraceDB>> {
  db ??= openDB<TraceDB>('trace', 1, {
    upgrade(d) {
      d.createObjectStore('assets', { keyPath: 'id' });
      d.createObjectStore('collections', { keyPath: 'id' });
      d.createObjectStore('placements', { keyPath: 'id' }).createIndex('collection', 'collectionId');
      d.createObjectStore('notes', { keyPath: 'id' }).createIndex('collection', 'collectionId');
      d.createObjectStore('meta');
    },
  });
  return db;
}

export interface Snapshot {
  assets: AssetRecord[];
  collections: Collection[];
  placements: Placement[];
  notes: Note[];
  user: User | undefined;
  seeded: boolean;
}

export async function loadAll(): Promise<Snapshot> {
  const d = await open();
  const [assets, collections, placements, notes, user, seeded] = await Promise.all([
    d.getAll('assets'),
    d.getAll('collections'),
    d.getAll('placements'),
    d.getAll('notes'),
    d.get('meta', 'user') as Promise<User | undefined>,
    d.get('meta', 'seeded'),
  ]);
  return { assets, collections, placements, notes, user, seeded: !!seeded };
}

// Writes queue per record and flush on a short timer, so a drag that
// touches a placement sixty times a second writes it once.
const pending = new Map<string, { store: StoreName; value: unknown | null; key: string }>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  flushTimer ??= setTimeout(flush, 250);
}

export async function flush(): Promise<void> {
  flushTimer = null;
  if (pending.size === 0) return;
  const batch = [...pending.values()];
  pending.clear();
  const d = await open();
  const tx = d.transaction(['assets', 'collections', 'placements', 'notes'], 'readwrite');
  for (const { store, value, key } of batch) {
    const s = tx.objectStore(store);
    if (value === null) void s.delete(key);
    else void s.put(value as never);
  }
  await tx.done;
}

export function put(store: StoreName, value: { id: string }): void {
  pending.set(`${store}:${value.id}`, { store, value, key: value.id });
  schedule();
}

export function remove(store: StoreName, id: string): void {
  pending.set(`${store}:${id}`, { store, value: null, key: id });
  schedule();
}

export async function putMeta(key: string, value: unknown): Promise<void> {
  const d = await open();
  await d.put('meta', value, key);
}

// Flush before the page goes away so the last edit isn't lost.
addEventListener('pagehide', () => void flush());
