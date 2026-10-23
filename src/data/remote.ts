// Reads and writes against Supabase: maps local records to table rows and
// back, loads a signed-in user's workspace or a public collection, and
// pushes batches of edits in foreign-key order.

import type { AssetRecord, Collection, Note, Placement, User } from './model.ts';
import { supabase } from './supabase.ts';

type Row = Record<string, unknown>;

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : Date.now());
// Only storage keys belong in the cloud, never blob: or opfs: URLs.
const isKey = (url: string | undefined) => !!url && url.startsWith('media/');

// ---- assets ----------------------------------------------------------------------

interface Renditions {
  l0?: { key: string; format: 'bc1'; frameWidth: number; frameHeight: number; frameCount: number; bytes: number };
  l1?: { key: string; width: number; height: number; bytes: number };
  l2?: { key: string; width: number; height: number; bytes: number };
  original?: { key: string; width: number; height: number; bytes: number };
}

export function assetToRow(a: AssetRecord): Row {
  // An upload stays "processing" in the cloud until its files are there.
  const pending = a.origin === 'upload' && !a.uploaded;
  const renditions: Renditions = {};
  if (!pending) {
    if (a.l0 && isKey(a.l0.url)) renditions.l0 = { ...a.l0, key: a.l0.url };
    if (isKey(a.l1.url)) renditions.l1 = { key: a.l1.url, width: a.l1.width, height: a.l1.height, bytes: a.l1.bytes };
    if (a.l2 && isKey(a.l2.url)) renditions.l2 = { key: a.l2.url, width: a.l2.width, height: a.l2.height, bytes: a.l2.bytes };
    if (a.original && isKey(a.original.url)) renditions.original = { key: a.original.url, width: a.original.width, height: a.original.height, bytes: a.original.bytes };
  }
  for (const r of Object.values(renditions)) delete (r as { url?: string }).url;
  return {
    id: a.id,
    name: a.name,
    origin: a.origin,
    status: pending ? (a.status === 'error' ? 'error' : 'processing') : a.status,
    duration: a.duration,
    width: a.width,
    height: a.height,
    fps: a.fps,
    renditions,
    source_url: a.sourceUrl ?? null,
    source_title: a.sourceTitle ?? null,
  };
}

export function rowToAsset(r: Row): AssetRecord {
  const rd = (r.renditions ?? {}) as Renditions;
  const video = (v: Renditions['l1']) => v && { url: v.key, width: v.width, height: v.height, bytes: v.bytes };
  return {
    id: r.id as string,
    name: r.name as string,
    origin: r.origin as AssetRecord['origin'],
    status: r.status as AssetRecord['status'],
    duration: r.duration as number,
    width: r.width as number,
    height: r.height as number,
    fps: r.fps as number,
    l0: rd.l0 ? { url: rd.l0.key, format: 'bc1', frameWidth: rd.l0.frameWidth, frameHeight: rd.l0.frameHeight, frameCount: rd.l0.frameCount, bytes: rd.l0.bytes } : null,
    l1: video(rd.l1) ?? { url: '', width: r.width as number, height: r.height as number, bytes: 0 },
    l2: video(rd.l2) ?? null,
    original: video(rd.original) ?? null,
    addedBy: (r.added_by as string) ?? '',
    addedAt: ms(r.added_at),
    sourceUrl: (r.source_url as string) ?? undefined,
    sourceTitle: (r.source_title as string) ?? undefined,
    uploaded: r.status === 'ready',
  };
}

// ---- collections, placements, notes ------------------------------------------------

export function collectionToRow(c: Collection): Row {
  return {
    id: c.id,
    name: c.name,
    cover_asset_id: c.coverAssetId,
    last_drop: c.lastDrop,
    is_public: c.isPublic,
    slug: c.slug,
    created_at: iso(c.createdAt),
  };
}

export function rowToCollection(r: Row): Collection {
  return {
    id: r.id as string,
    name: r.name as string,
    coverAssetId: (r.cover_asset_id as string) ?? null,
    lastDrop: (r.last_drop as Collection['lastDrop']) ?? null,
    createdBy: r.owner_id as string,
    isPublic: !!r.is_public,
    slug: (r.slug as string) ?? null,
    createdAt: ms(r.created_at),
    updatedAt: ms(r.updated_at),
  };
}

export function placementToRow(p: Placement): Row {
  return {
    id: p.id,
    collection_id: p.collectionId,
    asset_id: p.assetId,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    rotation: p.rotation,
    z: p.z,
    in_point: p.inPoint,
    out_point: p.outPoint,
    added_at: iso(p.addedAt),
  };
}

export function rowToPlacement(r: Row): Placement {
  return {
    id: r.id as string,
    collectionId: r.collection_id as string,
    assetId: r.asset_id as string,
    x: r.x as number,
    y: r.y as number,
    w: r.w as number,
    h: r.h as number,
    rotation: (r.rotation as number) ?? 0,
    z: r.z as number,
    inPoint: (r.in_point as number) ?? null,
    outPoint: (r.out_point as number) ?? null,
    addedBy: (r.added_by as string) ?? '',
    addedAt: ms(r.added_at),
  };
}

export const noteToRow = (n: Note): Row => ({ id: n.id, collection_id: n.collectionId, x: n.x, y: n.y, w: n.w, text: n.text, z: n.z });

export const rowToNote = (r: Row): Note => ({
  id: r.id as string,
  collectionId: r.collection_id as string,
  x: r.x as number,
  y: r.y as number,
  w: r.w as number,
  text: r.text as string,
  z: r.z as number,
});

// ---- loading ---------------------------------------------------------------------

// Pages past PostgREST's row limit.
async function all(table: string, filter?: (q: ReturnType<typeof select>) => ReturnType<typeof select>): Promise<Row[]> {
  const out: Row[] = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let q = select(table);
    if (filter) q = filter(q);
    const { data, error } = await q.range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data as Row[]));
    if (!data || data.length < page) return out;
  }
}

function select(table: string) {
  return supabase!.from(table).select('*');
}

// Chunks long id lists so filter URLs stay short.
async function byIds(table: string, column: string, ids: string[]): Promise<Row[]> {
  const out: Row[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    out.push(...(await all(table, (q) => q.in(column, chunk))));
  }
  return out;
}

export interface Workspace {
  user: User;
  assets: AssetRecord[];
  collections: Collection[];
  placements: Placement[];
  notes: Note[];
}

export async function fetchWorkspace(userId: string): Promise<Workspace> {
  const [profile, assets, collections] = await Promise.all([
    supabase!.from('profiles').select('*').eq('id', userId).maybeSingle(),
    all('assets'),
    all('collections', (q) => q.eq('owner_id', userId)),
  ]);
  const ids = collections.map((c) => c.id as string);
  const [placements, notes] = await Promise.all([byIds('placements', 'collection_id', ids), byIds('notes', 'collection_id', ids)]);
  const p = (profile.data ?? {}) as Row;
  return {
    user: {
      id: userId,
      name: (p.name as string) || 'You',
      color: (p.color as string) ?? '#4f7cff',
      avatarUrl: (p.avatar_url as string) ?? null,
      activeTargetId: (p.active_target_id as string) ?? null,
    },
    assets: assets.map(rowToAsset),
    collections: collections.map(rowToCollection),
    placements: placements.map(rowToPlacement),
    notes: notes.map(rowToNote),
  };
}

export interface PublicCollection {
  collection: Collection;
  owner: { name: string; avatarUrl: string | null };
  assets: AssetRecord[];
  placements: Placement[];
  notes: Note[];
}

export async function fetchPublic(slug: string): Promise<PublicCollection | null> {
  const { data, error } = await supabase!.from('collections').select('*').eq('slug', slug).eq('is_public', true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const collection = rowToCollection(data as Row);
  const [placements, notes, owner] = await Promise.all([
    byIds('placements', 'collection_id', [collection.id]),
    byIds('notes', 'collection_id', [collection.id]),
    supabase!.from('profiles').select('name, avatar_url').eq('id', collection.createdBy).maybeSingle(),
  ]);
  const assetIds = [...new Set(placements.map((p) => p.asset_id as string))];
  const assets = await byIds('assets', 'id', assetIds);
  return {
    collection,
    owner: { name: (owner.data?.name as string) ?? '', avatarUrl: (owner.data?.avatar_url as string) ?? null },
    assets: assets.map(rowToAsset),
    placements: placements.map(rowToPlacement),
    notes: notes.map(rowToNote),
  };
}

// ---- writing -----------------------------------------------------------------------

export type Table = 'assets' | 'collections' | 'placements' | 'notes' | 'profiles';

export interface Op {
  table: Table;
  id: string;
  // Null deletes.
  row: Row | null;
}

const UPSERT_ORDER: Table[] = ['profiles', 'assets', 'collections', 'placements', 'notes'];
const DELETE_ORDER: Table[] = ['notes', 'placements', 'collections'];

async function check<T extends { error: { message: string } | null }>(p: PromiseLike<T>, what: string): Promise<void> {
  const { error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
}

// Applies a batch: upserts parents before children, deletes children first.
export async function push(ops: Op[]): Promise<void> {
  const db = supabase!;
  for (const table of UPSERT_ORDER) {
    const rows = ops.filter((o) => o.table === table && o.row).map((o) => o.row!);
    if (rows.length === 0) continue;
    if (table === 'assets') {
      // An asset may already exist, added by someone else: insert what's
      // missing, then update only the ones this user owns (RLS skips the rest).
      await check(db.from('assets').upsert(rows, { onConflict: 'id', ignoreDuplicates: true }), 'assets');
      for (const r of rows) await check(db.from('assets').update(r).eq('id', r.id as string), 'assets');
    } else if (table === 'profiles') {
      for (const r of rows) await check(db.from('profiles').update(r).eq('id', r.id as string), 'profiles');
    } else {
      await check(db.from(table).upsert(rows, { onConflict: 'id' }), table);
    }
  }
  for (const table of DELETE_ORDER) {
    const ids = ops.filter((o) => o.table === table && !o.row).map((o) => o.id);
    if (ids.length) await check(db.from(table).delete().in('id', ids), table);
  }
}

export function profileToRow(u: User): Row {
  return { id: u.id, name: u.name, color: u.color, active_target_id: u.activeTargetId };
}
