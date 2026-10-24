// Reads and writes against Supabase: maps local records to table rows and
// back, loads a signed-in user's workspace or a public collection, and
// pushes batches of edits in foreign-key order.

import { type AssetRecord, type Collection, DEFAULT_FORMAT, type Folder, type Frame, type FrameColor, type Note, type Placement, type TextSize, type User } from './model.ts';
import { supabase } from './supabase.ts';

type Row = Record<string, unknown>;

const iso = (ms: number) => new Date(ms).toISOString();
const ms = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : Date.now());
// Only storage keys belong in the cloud, never blob: or opfs: URLs.
const isKey = (url: string | undefined) => !!url && url.startsWith('media/');
// The files the media Worker stores for an asset. A row's rendition is used
// only if its key names one of that row's own files: keys become URLs, and
// an uploader mustn't be able to point viewers at another server.
const RENDITION_KEY = /^media\/([0-9a-f]{16})\/(l0\.trl0|l1\.mp4|l2\.mp4|original\.[a-z0-9]{1,8})$/;
const ownsKey = (id: unknown, r: { key?: unknown } | undefined) => typeof r?.key === 'string' && RENDITION_KEY.exec(r.key)?.[1] === id;

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
    in_feed: a.origin === 'upload' && !!a.inFeed,
  };
}

export function rowToAsset(r: Row): AssetRecord {
  const stored = (r.renditions ?? {}) as Renditions;
  const rd: Renditions = {
    l0: ownsKey(r.id, stored.l0) ? stored.l0 : undefined,
    l1: ownsKey(r.id, stored.l1) ? stored.l1 : undefined,
    l2: ownsKey(r.id, stored.l2) ? stored.l2 : undefined,
    original: ownsKey(r.id, stored.original) ? stored.original : undefined,
  };
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
    inFeed: !!r.in_feed,
    // Only in rows selected with them (see COLUMNS).
    ...(r.source ? { source: r.source as AssetRecord['source'] } : {}),
    ...(r.analysis ? { analysis: r.analysis as AssetRecord['analysis'] } : {}),
  };
}

// ---- folders, collections, placements, notes ----------------------------------------

export const folderToRow = (f: Folder): Row => ({
  id: f.id,
  name: f.name,
  parent_id: f.parentId,
  created_at: iso(f.createdAt),
});

export const rowToFolder = (r: Row): Folder => ({
  id: r.id as string,
  name: r.name as string,
  parentId: (r.parent_id as string) ?? null,
  createdBy: r.owner_id as string,
  createdAt: ms(r.created_at),
  updatedAt: ms(r.updated_at),
});

export function collectionToRow(c: Collection): Row {
  return {
    id: c.id,
    name: c.name,
    folder_id: c.folderId,
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
    folderId: (r.folder_id as string) ?? null,
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
    frame_id: p.frameId ?? null,
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
    frameId: (r.frame_id as string) ?? null,
    addedBy: (r.added_by as string) ?? '',
    addedAt: ms(r.added_at),
  };
}

export const noteToRow = (n: Note): Row => ({
  id: n.id,
  collection_id: n.collectionId,
  x: n.x,
  y: n.y,
  w: n.w,
  h: n.h,
  text: n.text,
  size: n.size,
  bold: n.bold,
  italic: n.italic,
  underline: n.underline,
  z: n.z,
});

export const rowToNote = (r: Row): Note => ({
  id: r.id as string,
  collectionId: r.collection_id as string,
  x: r.x as number,
  y: r.y as number,
  w: r.w as number,
  h: (r.h as number) ?? null,
  text: r.text as string,
  size: (r.size as TextSize) ?? DEFAULT_FORMAT.size,
  bold: (r.bold as boolean) ?? false,
  italic: (r.italic as boolean) ?? false,
  underline: (r.underline as boolean) ?? false,
  z: r.z as number,
});

export const frameToRow = (f: Frame): Row => ({
  id: f.id,
  collection_id: f.collectionId,
  x: f.x,
  y: f.y,
  w: f.w,
  h: f.h,
  color: f.color,
  z: f.z,
});

export const rowToFrame = (r: Row): Frame => ({
  id: r.id as string,
  collectionId: r.collection_id as string,
  x: r.x as number,
  y: r.y as number,
  w: r.w as number,
  h: r.h as number,
  color: (r.color as FrameColor) ?? 'default',
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

// Asset rows leave out source and analysis (about 1.4 KB a row); the
// details panel reads them one asset at a time (fetchAssetMeta).
const COLUMNS: Record<string, string> = {
  assets: 'id, name, origin, status, duration, width, height, fps, renditions, source_url, source_title, in_feed, added_by, added_at, updated_at',
};

function select(table: string) {
  // Typed as '*': supabase-js can't parse a column list that isn't a literal.
  return supabase!.from(table).select((COLUMNS[table] ?? '*') as '*');
}

export async function fetchAssetMeta(id: string): Promise<Pick<AssetRecord, 'source' | 'analysis'>> {
  const { data, error } = await supabase!.from('assets').select('source, analysis').eq('id', id).maybeSingle();
  if (error) throw new Error(`assets: ${error.message}`);
  const r = (data ?? {}) as Row;
  return { source: (r.source as AssetRecord['source']) ?? undefined, analysis: (r.analysis as AssetRecord['analysis']) ?? undefined };
}

// Uploads shared to the Feed come with source and analysis at startup: the
// search index doesn't cover them, so the app builds their search docs from
// these (src/search/docs.ts). There are few.
async function sharedUploadMeta(): Promise<Row[]> {
  const { data, error } = await supabase!.from('assets').select('id, source, analysis').eq('origin', 'upload').eq('in_feed', true).limit(2000);
  if (error) throw new Error(`assets: ${error.message}`);
  return (data ?? []) as Row[];
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
  folders: Folder[];
  collections: Collection[];
  placements: Placement[];
  notes: Note[];
  frames: Frame[];
}

// Pulls every asset row at startup, 1,000 per request, source and analysis
// JSON included (about 1.7 KB a row). Fine to ~10k rows. Past that the Feed
// should page, which needs:
// - Startup to load only the user's uploads and the assets their placements
//   use (byIds); the Feed's pool loads on its own.
// - The Feed's order from the server. Its seeded shuffle needs every id on
//   the client today; instead order by a hash of (id, seed), keyset-paged
//   (an RPC like feed_page(seed, after, limit)).
// - A skeleton of the whole ordered pool (id, width, height: tens of bytes a
//   row) so justified rows lay out and the scrollbar is right from the
//   start, then full rows for the index range near the viewport, which
//   FeedPane already computes for the engine (ENGINE_OVERSCAN).
// - Narrow columns for tiles, with source and analysis fetched on demand.
// - "Hide added" as a server-side not-exists against the user's placements,
//   and the header count from a head request.
export async function fetchWorkspace(userId: string): Promise<Workspace> {
  const [profile, assets, shared, folders, collections] = await Promise.all([
    supabase!.from('profiles').select('*').eq('id', userId).maybeSingle(),
    all('assets'),
    sharedUploadMeta(),
    all('folders', (q) => q.eq('owner_id', userId)),
    all('collections', (q) => q.eq('owner_id', userId)),
  ]);
  const meta = new Map(shared.map((r) => [r.id as string, r]));
  const ids = collections.map((c) => c.id as string);
  const [placements, notes, frames] = await Promise.all([
    byIds('placements', 'collection_id', ids),
    byIds('notes', 'collection_id', ids),
    byIds('frames', 'collection_id', ids),
  ]);
  const p = (profile.data ?? {}) as Row;
  return {
    user: {
      id: userId,
      name: (p.name as string) || 'You',
      color: (p.color as string) ?? '#4f7cff',
      avatarUrl: (p.avatar_url as string) ?? null,
      activeTargetId: (p.active_target_id as string) ?? null,
    },
    assets: assets.map((r) => rowToAsset(meta.has(r.id as string) ? { ...r, ...meta.get(r.id as string) } : r)),
    folders: folders.map(rowToFolder),
    collections: collections.map(rowToCollection),
    placements: placements.map(rowToPlacement),
    notes: notes.map(rowToNote),
    frames: frames.map(rowToFrame),
  };
}

export interface PublicCollection {
  collection: Collection;
  owner: { name: string; avatarUrl: string | null };
  assets: AssetRecord[];
  placements: Placement[];
  notes: Note[];
  frames: Frame[];
}

export async function fetchPublic(slug: string): Promise<PublicCollection | null> {
  const { data, error } = await supabase!.from('collections').select('*').eq('slug', slug).eq('is_public', true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  // Its folder is the owner's filing, not part of what's published.
  const collection = { ...rowToCollection(data as Row), folderId: null };
  const [placements, notes, frames, owner] = await Promise.all([
    byIds('placements', 'collection_id', [collection.id]),
    byIds('notes', 'collection_id', [collection.id]),
    byIds('frames', 'collection_id', [collection.id]),
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
    frames: frames.map(rowToFrame),
  };
}

// ---- writing -----------------------------------------------------------------------

export type Table = 'assets' | 'folders' | 'collections' | 'placements' | 'notes' | 'frames' | 'profiles';

export interface Op {
  table: Table;
  id: string;
  // Null deletes.
  row: Row | null;
}

const UPSERT_ORDER: Table[] = ['profiles', 'assets', 'folders', 'collections', 'frames', 'placements', 'notes'];
const DELETE_ORDER: Table[] = ['notes', 'placements', 'frames', 'collections', 'folders'];

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
