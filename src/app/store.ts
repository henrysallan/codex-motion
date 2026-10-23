// App state: the data model (collections, placements, notes, assets), the
// workspace UI (panes, tabs, theme), and per-collection undo history.
//
// Data writes go through actions that update state, queue an IndexedDB
// write per record, and record undo. UI preferences persist to
// localStorage. Hot paths (dragging, panning) don't touch the store until
// the gesture ends.

import { create } from 'zustand';
import * as db from '../data/db.ts';
import { type AssetRecord, type Collection, newId, type Note, type Placement, type Point, type User } from '../data/model.ts';
import * as remote from '../data/remote.ts';
import { enqueue } from '../data/sync.ts';
import type { Library } from '../media/library.ts';
import { justifiedRows } from './layout/arrange.ts';
import { type Box, placeIncoming } from './layout/relax.ts';

export type Theme = 'system' | 'light' | 'dark';
export type CollectionsSort = 'updated' | 'name' | 'items';

interface Prefs {
  theme: Theme;
  panes: { collections: boolean; feed: boolean };
  tabs: string[];
  activeTab: string | null;
  widths: { collections: number; feed: number };
  collectionsView: 'grid' | 'list';
  collectionsSort: CollectionsSort;
  feedSeed: number;
  feedHideAdded: boolean;
  snap: boolean;
  scrubOnHover: boolean;
  hud: boolean;
}

// One undoable edit: each pair is [before, after]; null means absent.
interface Change {
  placements: [Placement | null, Placement | null][];
  notes: [Note | null, Note | null][];
}

interface History {
  undo: Change[];
  redo: Change[];
}

export interface FocusTarget {
  collectionId: string;
  placementId: string;
  playing: boolean;
  speed: number;
}

interface State extends Prefs {
  loaded: boolean;
  // local: IndexedDB only. remote: signed in, synced with Supabase.
  // public: someone's published collection, read-only.
  mode: 'local' | 'remote' | 'public';
  // In public mode: who published it.
  publicOwner: { name: string; avatarUrl: string | null } | null;
  user: User;
  assets: Record<string, AssetRecord>;
  collections: Record<string, Collection>;
  placements: Record<string, Placement>;
  notes: Record<string, Note>;
  history: Record<string, History>;
  paused: boolean;
  // Selected placement and note ids on the active board.
  selection: string[];
  focus: FocusTarget | null;
  // Selected asset ids in the Feed.
  feedSelection: string[];
}

const PREFS_KEY = 'trace.prefs';
const defaultPrefs: Prefs = {
  theme: 'system',
  panes: { collections: true, feed: false },
  tabs: [],
  activeTab: null,
  widths: { collections: 420, feed: 460 },
  collectionsView: 'grid',
  collectionsSort: 'updated',
  feedSeed: 1,
  feedHideAdded: false,
  snap: false,
  scrubOnHover: true,
  hud: false,
};

// Bumped when a default changes in a way saved preferences should follow.
const PREFS_VERSION = 2;

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs> & { version?: number };
    // v2: snapping off by default.
    if ((saved.version ?? 1) < 2) delete saved.snap;
    return { ...defaultPrefs, ...saved };
  } catch {
    return defaultPrefs;
  }
}

export const useStore = create<State>(() => ({
  ...loadPrefs(),
  loaded: false,
  mode: 'local',
  publicOwner: null,
  user: { id: 'local', name: 'You', color: '#4f7cff', activeTargetId: null },
  assets: {},
  collections: {},
  placements: {},
  notes: {},
  history: {},
  paused: false,
  selection: [],
  focus: null,
  feedSelection: [],
}));

const set = useStore.setState;
const get = useStore.getState;

useStore.subscribe((s, prev) => {
  // A public page borrows the layout; it never saves it over the user's own.
  if (s.mode === 'public') return;
  const keys = Object.keys(defaultPrefs) as (keyof Prefs)[];
  if (!keys.some((k) => s[k] !== prev[k])) return;
  const prefs = { ...Object.fromEntries(keys.map((k) => [k, s[k]])), version: PREFS_VERSION };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: preferences just don't persist.
  }
});

// ---- selectors ---------------------------------------------------------------

export function placementsOf(collectionId: string, placements = get().placements): Placement[] {
  return Object.values(placements).filter((p) => p.collectionId === collectionId);
}

export function notesOf(collectionId: string, notes = get().notes): Note[] {
  return Object.values(notes).filter((n) => n.collectionId === collectionId);
}

// The asset a collection shows as its cover: its own pick, else the first
// clip added.
export function coverAssetOf(c: Collection, placements = get().placements): string | null {
  if (c.coverAssetId) return c.coverAssetId;
  let first: Placement | null = null;
  for (const p of Object.values(placements)) if (p.collectionId === c.id && (!first || p.addedAt < first.addedAt || (p.addedAt === first.addedAt && p.z < first.z))) first = p;
  return first?.assetId ?? null;
}

// Asset ids that appear in any collection.
export function collectedAssetIds(placements = get().placements): Set<string> {
  return new Set(Object.values(placements).map((p) => p.assetId));
}

// ---- loading -------------------------------------------------------------------

function libraryRecords(library: Library): AssetRecord[] {
  return library.assets.map((a) => ({ ...a, origin: 'library', status: 'ready', addedBy: 'library', addedAt: 0 }));
}

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(xs: T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// First run: three collections from the sample library so there is
// something to look at, including the 200-clip board the M0 gate used.
function seedCollections(assets: AssetRecord[], user: User, onlySample = false): { collections: Collection[]; placements: Placement[] } {
  const now = Date.now();
  const collections: Collection[] = [];
  const placements: Placement[] = [];
  const make = (name: string, items: AssetRecord[], rowHeight: () => number, age: number) => {
    if (items.length === 0) return;
    const c: Collection = {
      id: newId(), name, coverAssetId: null, lastDrop: null, createdBy: user.id,
      isPublic: false, slug: null, createdAt: now - age, updatedAt: now - age,
    };
    const area = items.reduce((s, a) => s + (a.width / a.height) * 240 * 240, 0);
    const boxes = justifiedRows(items.map((a) => a.width / a.height), Math.sqrt(area * 1.6), rowHeight, 16);
    boxes.forEach((b, i) =>
      placements.push({
        id: newId(), collectionId: c.id, assetId: items[i].id, ...b, rotation: 0, z: i,
        inPoint: null, outPoint: null, addedBy: user.id, addedAt: now - age + i,
      }),
    );
    const last = boxes[boxes.length - 1];
    c.lastDrop = { x: last.x + last.w / 2, y: last.y + last.h + 200 };
    collections.push(c);
  };
  const rnd = mulberry32(7);
  const varied = () => 160 + rnd() * 160;
  if (!onlySample) make('Benchmark board', shuffled(assets, 1), varied, 3 * 86400e3);
  make('Sample board', shuffled(assets, 2).slice(0, 36), varied, 2 * 86400e3);
  if (!onlySample) make('Type & shapes', assets.filter((a) => /type|shapes/.test(a.name)), () => 220, 3600e3);
  return { collections, placements };
}

const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]));

// Opens with the saved tabs that still exist.
function withTabs(collections: Record<string, Collection>) {
  const prefs = get();
  const tabs = prefs.tabs.filter((id) => collections[id]);
  return { tabs, activeTab: prefs.activeTab && collections[prefs.activeTab] ? prefs.activeTab : (tabs[0] ?? null) };
}

// Local-only mode: IndexedDB, plus the dev server's sample library.
export async function loadApp(): Promise<void> {
  const [snap, library] = await Promise.all([
    db.loadAll(),
    fetch('media/library.json').then((r) => (r.ok ? (r.json() as Promise<Library>) : { version: 1 as const, assets: [] })),
  ]);
  const user = snap.user ?? get().user;
  const assets: Record<string, AssetRecord> = {};
  for (const a of libraryRecords(library)) assets[a.id] = a;
  for (const a of snap.assets) assets[a.id] = a;

  let collections = snap.collections;
  let placements = snap.placements;
  if (!snap.seeded && collections.length === 0) {
    const seed = seedCollections(Object.values(assets).filter((a) => a.origin === 'library'), user);
    collections = seed.collections;
    placements = seed.placements;
    for (const c of collections) db.put('collections', c);
    for (const p of placements) db.put('placements', p);
    // Mark seeded only once the seed is on disk, or a reload in between
    // would leave an empty, "seeded" database.
    void db.flush().then(() => Promise.all([db.putMeta('seeded', true), db.putMeta('user', user)]));
  }

  const cols = byId(collections);
  set({ loaded: true, mode: 'local', user, assets, collections: cols, placements: byId(placements), notes: byId(snap.notes), ...withTabs(cols) });
}

// Signed in: show the local cache at once, then the server's copy.
export async function loadRemote(userId: string): Promise<void> {
  let snap = await db.loadAll();
  // A cache from a different account on this browser isn't ours to show.
  if (snap.collections.some((c) => c.createdBy !== 'local' && c.createdBy !== userId)) {
    await db.clearLocal();
    snap = await db.loadAll();
  }
  const cached = snap.collections.filter((c) => c.createdBy === userId);
  if (cached.length) {
    const cols = byId(cached);
    set({
      loaded: true,
      mode: 'remote',
      assets: { ...get().assets, ...byId(snap.assets) },
      collections: cols,
      placements: byId(snap.placements.filter((p) => cols[p.collectionId])),
      notes: byId(snap.notes.filter((n) => cols[n.collectionId])),
      ...withTabs(cols),
    });
  }

  const ws = await remote.fetchWorkspace(userId);
  const assets = byId(ws.assets);
  // Uploads still processing here aren't on the server yet.
  for (const a of snap.assets) if (a.origin === 'upload' && (!assets[a.id] || !a.uploaded)) assets[a.id] = a;
  let collections = ws.collections;
  let placements = ws.placements;
  let notes = ws.notes;

  // First sign-in on a browser with local-only work: it moves to the account.
  const local = snap.collections.filter((c) => c.createdBy === 'local');
  if (local.length) {
    const moved = local.map((c) => ({ ...c, createdBy: userId }));
    const ids = new Set(moved.map((c) => c.id));
    const movedPlacements = snap.placements.filter((p) => ids.has(p.collectionId));
    const movedNotes = snap.notes.filter((n) => ids.has(n.collectionId));
    for (const a of snap.assets) if (a.origin === 'upload') db.put('assets', a);
    for (const c of moved) db.put('collections', c);
    for (const p of movedPlacements) db.put('placements', p);
    for (const n of movedNotes) db.put('notes', n);
    collections = [...collections, ...moved];
    placements = [...placements, ...movedPlacements];
    notes = [...notes, ...movedNotes];
  } else if (collections.length === 0 && !(await db.getMeta('welcomed'))) {
    // A new account starts with one sample board.
    const seed = seedCollections(ws.assets.filter((a) => a.origin === 'library'), ws.user, true);
    for (const c of seed.collections) db.put('collections', c);
    for (const p of seed.placements) db.put('placements', p);
    collections = seed.collections;
    placements = seed.placements;
    void db.putMeta('welcomed', true);
  }

  const cols = byId(collections);
  set({
    loaded: true,
    mode: 'remote',
    user: ws.user,
    assets,
    collections: cols,
    placements: byId(placements),
    notes: byId(notes),
    ...withTabs(cols),
  });
  await db.replaceCache({ assets: Object.values(assets), collections, placements, notes });
}

// Someone's published collection, read-only: nothing here is saved.
export async function loadPublic(slug: string): Promise<boolean> {
  db.writes.local = false;
  db.writes.remote = false;
  const pub = await remote.fetchPublic(slug);
  if (!pub) return false;
  const c = pub.collection;
  set({
    loaded: true,
    mode: 'public',
    publicOwner: pub.owner,
    assets: byId(pub.assets),
    collections: { [c.id]: c },
    placements: byId(pub.placements),
    notes: byId(pub.notes),
    tabs: [c.id],
    activeTab: c.id,
    panes: { collections: false, feed: false },
    snap: false,
  });
  return true;
}

// ---- workspace -----------------------------------------------------------------

export function setTheme(theme: Theme): void {
  set({ theme });
}

export function togglePane(pane: 'collections' | 'feed'): void {
  const panes = get().panes;
  set({ panes: { ...panes, [pane]: !panes[pane] } });
}

export function setPaneWidth(pane: 'collections' | 'feed', width: number): void {
  set({ widths: { ...get().widths, [pane]: Math.round(width) } });
}

export function openCollection(id: string): void {
  const { tabs } = get();
  set({ tabs: tabs.includes(id) ? tabs : [...tabs, id], activeTab: id, selection: [], focus: null });
}

export function activateTab(id: string): void {
  if (get().activeTab !== id) set({ activeTab: id, selection: [], focus: null });
}

export function closeTab(id: string): void {
  const { tabs, activeTab } = get();
  const i = tabs.indexOf(id);
  if (i < 0) return;
  const next = tabs.filter((t) => t !== id);
  set({
    tabs: next,
    activeTab: activeTab === id ? (next[Math.min(i, next.length - 1)] ?? null) : activeTab,
    ...(activeTab === id ? { selection: [], focus: null } : {}),
  });
}

export function setPaused(paused: boolean): void {
  set({ paused });
}

export function setSelection(ids: string[]): void {
  const cur = get().selection;
  if (cur.length === ids.length && cur.every((id, i) => id === ids[i])) return;
  set({ selection: ids });
}

export function setFocus(focus: FocusTarget | null): void {
  set({ focus });
}

export function setFeedSelection(ids: string[]): void {
  set({ feedSelection: ids });
}

export function updatePrefs(p: Partial<Prefs>): void {
  set(p);
}

// ---- collections ---------------------------------------------------------------

export function createCollection(name = 'Untitled collection'): string {
  const now = Date.now();
  const c: Collection = {
    id: newId(), name, coverAssetId: null, lastDrop: null, createdBy: get().user.id,
    isPublic: false, slug: null, createdAt: now, updatedAt: now,
  };
  set({ collections: { ...get().collections, [c.id]: c } });
  db.put('collections', c);
  return c.id;
}

function touch(id: string, patch: Partial<Collection> = {}): void {
  const c = get().collections[id];
  if (!c) return;
  const next = { ...c, ...patch, updatedAt: Date.now() };
  set({ collections: { ...get().collections, [id]: next } });
  db.put('collections', next);
}

export function renameCollection(id: string, name: string): void {
  touch(id, { name: name.trim() || 'Untitled collection' });
}

export function setCover(id: string, assetId: string | null): void {
  touch(id, { coverAssetId: assetId });
}

export function deleteCollection(id: string): void {
  const s = get();
  const collections = { ...s.collections };
  delete collections[id];
  const placements = { ...s.placements };
  for (const p of Object.values(s.placements)) {
    if (p.collectionId !== id) continue;
    delete placements[p.id];
    db.remove('placements', p.id);
  }
  const notes = { ...s.notes };
  for (const n of Object.values(s.notes)) {
    if (n.collectionId !== id) continue;
    delete notes[n.id];
    db.remove('notes', n.id);
  }
  db.remove('collections', id);
  set({ collections, placements, notes });
  closeTab(id);
  if (s.user.activeTargetId === id) setActiveTarget(null);
}

export function setActiveTarget(id: string | null): void {
  const user = { ...get().user, activeTargetId: id };
  set({ user });
  if (get().mode === 'remote') enqueue('profiles', user.id, remote.profileToRow(user));
  else void db.putMeta('user', user);
}

// Publishes a collection read-only at /c/<slug>, or takes it down. A slug
// only exists while published, so every taken slug is visible to the
// availability check.
export function setPublished(id: string, slug: string | null): void {
  touch(id, { isPublic: !!slug, slug });
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'collection';
}

// ---- edits with undo -----------------------------------------------------------

function apply(change: Change, direction: 0 | 1): void {
  const s = get();
  const placements = { ...s.placements };
  const notes = { ...s.notes };
  for (const pair of change.placements) {
    const v = pair[direction];
    const id = (pair[0] ?? pair[1])!.id;
    if (v) {
      placements[id] = v;
      db.put('placements', v);
    } else {
      delete placements[id];
      db.remove('placements', id);
    }
  }
  for (const pair of change.notes) {
    const v = pair[direction];
    const id = (pair[0] ?? pair[1])!.id;
    if (v) {
      notes[id] = v;
      db.put('notes', v);
    } else {
      delete notes[id];
      db.remove('notes', id);
    }
  }
  set({ placements, notes });
}

// Applies an edit to one collection and records it for undo.
function commit(collectionId: string, change: Change): void {
  if (change.placements.length === 0 && change.notes.length === 0) return;
  apply(change, 1);
  const h = get().history[collectionId] ?? { undo: [], redo: [] };
  set({ history: { ...get().history, [collectionId]: { undo: [...h.undo.slice(-199), change], redo: [] } } });
  touch(collectionId);
}

export function undo(collectionId: string): void {
  const h = get().history[collectionId];
  const change = h?.undo[h.undo.length - 1];
  if (!change) return;
  apply(change, 0);
  set({ history: { ...get().history, [collectionId]: { undo: h.undo.slice(0, -1), redo: [...h.redo, change] } } });
  pruneSelection();
}

export function redo(collectionId: string): void {
  const h = get().history[collectionId];
  const change = h?.redo[h.redo.length - 1];
  if (!change) return;
  apply(change, 1);
  set({ history: { ...get().history, [collectionId]: { undo: [...h.undo, change], redo: h.redo.slice(0, -1) } } });
  pruneSelection();
}

function pruneSelection(): void {
  const s = get();
  setSelection(s.selection.filter((id) => s.placements[id] || s.notes[id]));
}

// Saves new versions of placements and notes (moves, resizes, ranges).
export function savePlacements(collectionId: string, next: Placement[], nextNotes: Note[] = []): void {
  const s = get();
  commit(collectionId, {
    placements: next.map((p) => [s.placements[p.id] ?? null, p]),
    notes: nextNotes.map((n) => [s.notes[n.id] ?? null, n]),
  });
}

export function deleteItems(collectionId: string, ids: string[]): void {
  const s = get();
  commit(collectionId, {
    placements: ids.filter((id) => s.placements[id]).map((id) => [s.placements[id], null]),
    notes: ids.filter((id) => s.notes[id]).map((id) => [s.notes[id], null]),
  });
  pruneSelection();
}

export function topZ(collectionId: string): number {
  let z = 0;
  for (const p of placementsOf(collectionId)) z = Math.max(z, p.z);
  for (const n of notesOf(collectionId)) z = Math.max(z, n.z);
  return z;
}

// Default size of a newly added clip, in world units.
const NEW_CLIP_HEIGHT = 240;

export function sizeFor(a: AssetRecord): { w: number; h: number } {
  const aspect = a.width / a.height || 16 / 9;
  // Keep very wide or tall clips from becoming huge in one dimension.
  const h = aspect > 2 ? (NEW_CLIP_HEIGHT * 2) / aspect : NEW_CLIP_HEIGHT;
  return { w: h * aspect, h };
}

// Adds clips to a collection (spec: "Adding to collections"). They start at
// `at` (a canvas drop point) or the collection's last drop point, relax off
// anything they overlap, and the last drop point moves to where they
// settled. Returns the new placements.
export function addToCollection(collectionId: string, assetIds: string[], at?: Point): Placement[] {
  const s = get();
  const c = s.collections[collectionId];
  if (!c || assetIds.length === 0) return [];
  const existing = placementsOf(collectionId);
  const boxes: Box[] = [...existing, ...notesOf(collectionId).map((n) => ({ x: n.x, y: n.y, w: n.w, h: 120 }))];
  let drop = at ?? c.lastDrop;
  if (!drop) {
    // First items in a collection: the origin; later batches go below.
    drop = existing.length ? { x: Math.min(...existing.map((p) => p.x)), y: Math.max(...existing.map((p) => p.y + p.h)) + 300 } : { x: 0, y: 0 };
  }
  const assets = assetIds.map((id) => s.assets[id]).filter(Boolean);
  const placed = placeIncoming(boxes, assets.map(sizeFor), drop);
  let z = topZ(collectionId);
  const now = Date.now();
  const next: Placement[] = assets.map((a, i) => ({
    id: newId(), collectionId, assetId: a.id, ...placed[i], rotation: 0, z: ++z,
    inPoint: null, outPoint: null, addedBy: s.user.id, addedAt: now + i,
  }));
  commit(collectionId, { placements: next.map((p) => [null, p]), notes: [] });
  const cx = placed.reduce((a, b) => a + b.x + b.w / 2, 0) / placed.length;
  const cy = placed.reduce((a, b) => a + b.y + b.h / 2, 0) / placed.length;
  touch(collectionId, { lastDrop: { x: cx, y: cy } });
  return next;
}

export function addNote(collectionId: string, at: Point): Note {
  const n: Note = { id: newId(), collectionId, x: at.x, y: at.y, w: 240, text: '', z: topZ(collectionId) + 1 };
  commit(collectionId, { placements: [], notes: [[null, n]] });
  return n;
}

export function saveNote(note: Note): void {
  const prev = get().notes[note.id];
  if (prev && prev.text === note.text && prev.x === note.x && prev.y === note.y && prev.w === note.w) return;
  commit(note.collectionId, { placements: [], notes: [[prev ?? null, note]] });
}

// ---- assets --------------------------------------------------------------------

export function upsertAsset(a: AssetRecord): void {
  set({ assets: { ...get().assets, [a.id]: a } });
  if (a.origin === 'upload') db.put('assets', a);
}
