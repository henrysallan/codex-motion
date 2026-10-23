// Local persistence in IndexedDB. Collections, placements, notes and asset
// metadata each live in their own store and are written per record, so an
// edit to one placement never rewrites a board. Media bytes live in OPFS
// (see ingest/) and the server library, never here.
//
// With Supabase configured, IndexedDB is a cache of the signed-in user's
// workspace and every edit also goes to the sync outbox.

import { type DBSchema, type IDBPDatabase, openDB } from 'idb';
import { remoteEnabled } from '../config.ts';
import { type AssetRecord, type Collection, type Note, type Placement, type User, withNoteDefaults } from './model.ts';
import { assetToRow, collectionToRow, noteToRow, placementToRow } from './remote.ts';
import { enqueue } from './sync.ts';

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
  return { assets, collections, placements, notes: notes.map(withNoteDefaults), user, seeded: !!seeded };
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

// Off while viewing someone else's public collection, which is never ours
// to save.
export const writes = { remote: remoteEnabled, local: true };

const toRow = {
  assets: (v: unknown) => assetToRow(v as AssetRecord),
  collections: (v: unknown) => collectionToRow(v as Collection),
  placements: (v: unknown) => placementToRow(v as Placement),
  notes: (v: unknown) => noteToRow(v as Note),
};

export function put(store: StoreName, value: { id: string }): void {
  if (writes.local) {
    pending.set(`${store}:${value.id}`, { store, value, key: value.id });
    schedule();
  }
  if (writes.remote) enqueue(store, value.id, toRow[store](value));
}

export function remove(store: StoreName, id: string): void {
  if (writes.local) {
    pending.set(`${store}:${id}`, { store, value: null, key: id });
    schedule();
  }
  if (writes.remote) enqueue(store, id, null);
}

// Replaces the local cache with a workspace loaded from the server.
export async function replaceCache(data: { assets: AssetRecord[]; collections: Collection[]; placements: Placement[]; notes: Note[] }): Promise<void> {
  const d = await open();
  const tx = d.transaction(['assets', 'collections', 'placements', 'notes'], 'readwrite');
  await Promise.all([tx.objectStore('collections').clear(), tx.objectStore('placements').clear(), tx.objectStore('notes').clear()]);
  // The library comes fresh from the server each time; uploads are cached.
  for (const a of data.assets) if (a.origin === 'upload') void tx.objectStore('assets').put(a);
  for (const c of data.collections) void tx.objectStore('collections').put(c);
  for (const p of data.placements) void tx.objectStore('placements').put(p);
  for (const n of data.notes) void tx.objectStore('notes').put(n);
  await tx.done;
}

// Wipes the local workspace (a different account signed in on this browser).
export async function clearLocal(): Promise<void> {
  const d = await open();
  const tx = d.transaction(['assets', 'collections', 'placements', 'notes', 'meta'], 'readwrite');
  await Promise.all(['assets', 'collections', 'placements', 'notes', 'meta'].map((s) => tx.objectStore(s as 'meta').clear()));
  await tx.done;
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const d = await open();
  return (await d.get('meta', key)) as T | undefined;
}

export async function putMeta(key: string, value: unknown): Promise<void> {
  const d = await open();
  await d.put('meta', value, key);
}

// Flush before the page goes away so the last edit isn't lost.
addEventListener('pagehide', () => void flush());
