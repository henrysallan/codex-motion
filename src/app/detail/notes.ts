// Your notes on a clip, in its details panel: free text, saved as you type,
// whose links read as links with a small preview of each. Previews come
// from api/unfurl.ts once per link and are kept with the note, the page's
// images shrunk here to thumbnails, so showing a note loads nothing from
// the sites it links to. Notes are keyed by who wrote them as well as the
// clip, so switching accounts never shows someone else's.

import { create } from 'zustand';
import { config, remoteEnabled } from '../../config.ts';
import { type AssetNote, fetchAssetNote, type LinkPreview, saveAssetNote } from '../../data/assetNotes.ts';
import { accessToken } from '../../data/supabase.ts';
import { toast } from '../toasts.tsx';
import { linksIn } from './links.ts';

export const MAX_NOTE = 10_000;
// Links past this many in one note stay plain links.
export const MAX_PREVIEWS = 12;
const SAVE_DELAY = 800;

interface State {
  // By noteKey: the note, null when there's none, absent until read.
  notes: Record<string, AssetNote | null>;
  // Notes that couldn't be read; they can't be edited until they are, or
  // a save would replace what's on the server.
  loadErrors: Record<string, string>;
  // Notes with a save waiting or in flight, and ones whose last save failed.
  saving: Record<string, 'pending' | 'error'>;
  // Links being previewed, and ones that couldn't be this session.
  unfurling: Record<string, true>;
  failed: Record<string, true>;
}

export const useNotes = create<State>(() => ({ notes: {}, loadErrors: {}, saving: {}, unfurling: {}, failed: {} }));

const set = useNotes.setState;
const get = useNotes.getState;

// Whose notes these are: the signed-in user, or 'local' with no Supabase.
export const noteKey = (owner: string, assetId: string) => `${owner}:${assetId}`;
const ownerOf = (key: string) => key.slice(0, key.indexOf(':'));

function patch<K extends keyof State>(field: K, key: string, value: State[K][string] | undefined): void {
  const next = { ...get()[field] } as Record<string, unknown>;
  if (value === undefined) delete next[key];
  else next[key] = value;
  set({ [field]: next } as Partial<State>);
}

// Previews only for links still in the body.
function prune(note: AssetNote): AssetNote {
  const keep = new Set(linksIn(note.body).slice(0, MAX_PREVIEWS));
  const links: Record<string, LinkPreview> = {};
  for (const [k, v] of Object.entries(note.links)) if (keep.has(k)) links[k] = v;
  return { ...note, links };
}

// ---- reading -------------------------------------------------------------------------

const reading = new Set<string>();

export function loadNote(owner: string, assetId: string): void {
  const key = noteKey(owner, assetId);
  if (key in get().notes || reading.has(key)) return;
  reading.add(key);
  patch('loadErrors', key, undefined);
  fetchAssetNote(owner, assetId)
    .then(
      (note) => patch('notes', key, note),
      (e: unknown) => patch('loadErrors', key, e instanceof Error ? e.message : String(e)),
    )
    .finally(() => reading.delete(key));
}

// ---- writing -------------------------------------------------------------------------

const timers = new Map<string, ReturnType<typeof setTimeout>>();
// Each note's saves, one after another, so they land in order.
const queue = new Map<string, Promise<void>>();

export function editNote(owner: string, assetId: string, body: string): void {
  const key = noteKey(owner, assetId);
  const s = get();
  if (!(key in s.notes) || s.loadErrors[key]) return;
  const prev = s.notes[key];
  patch('notes', key, { assetId, body: body.slice(0, MAX_NOTE), links: prev?.links ?? {}, updatedAt: Date.now() });
  schedule(key, SAVE_DELAY);
}

function schedule(key: string, delay: number): void {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => void persist(key), delay));
  patch('saving', key, 'pending');
}

function persist(key: string): Promise<void> {
  clearTimeout(timers.get(key));
  timers.delete(key);
  const run: Promise<void> = (queue.get(key) ?? Promise.resolve()).then(async () => {
    const note = get().notes[key];
    if (!note) return;
    try {
      await saveAssetNote(ownerOf(key), prune(note));
      if (!timers.has(key) && queue.get(key) === run) patch('saving', key, undefined);
    } catch (e) {
      patch('saving', key, 'error');
      toast(`Couldn’t save your note: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  queue.set(key, run);
  return run;
}

// Saves now what's waiting: the editor closing, the clip changing.
export function flushNote(owner: string, assetId: string): Promise<void> {
  const key = noteKey(owner, assetId);
  return timers.has(key) ? persist(key) : (queue.get(key) ?? Promise.resolve());
}

addEventListener('pagehide', () => {
  for (const key of [...timers.keys()]) void persist(key);
});

// ---- previews ------------------------------------------------------------------------

// This session's previews by link, for the same link in another note.
const known = new Map<string, LinkPreview>();
const waiting: (() => void)[] = [];
let active = 0;

async function slot<T>(task: () => Promise<T>): Promise<T> {
  if (active >= 3) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await task();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

// Previews the note's links that don't have one yet.
export function previewLinks(owner: string, assetId: string): void {
  const key = noteKey(owner, assetId);
  const s = get();
  const note = s.notes[key];
  if (!note) return;
  for (const url of linksIn(note.body).slice(0, MAX_PREVIEWS)) {
    if (note.links[url] || s.unfurling[url] || s.failed[url]) continue;
    void unfurlInto(key, url);
  }
}

async function unfurlInto(key: string, url: string): Promise<void> {
  patch('unfurling', url, true);
  try {
    const preview = known.get(url) ?? (await slot(() => fetchPreview(url)));
    known.set(url, preview);
    const note = get().notes[key];
    // Edited away meanwhile.
    if (!note || !linksIn(note.body).includes(url)) return;
    patch('notes', key, { ...note, links: { ...note.links, [url]: preview } });
    // Several links finishing together save once.
    schedule(key, 300);
  } catch (e) {
    console.warn(`preview ${url}:`, e);
    patch('failed', url, true);
  } finally {
    patch('unfurling', url, undefined);
  }
}

async function fetchPreview(url: string): Promise<LinkPreview> {
  const token = remoteEnabled ? await accessToken() : null;
  if (remoteEnabled && !token) throw new Error('signed out');
  const res = await fetch(config.unfurlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ url }),
  });
  const answer = (await res.json().catch(() => ({}))) as Partial<LinkPreview> & { error?: string };
  if (!res.ok || typeof answer.site !== 'string') throw new Error(answer.error ?? `HTTP ${res.status}`);
  const [image, icon] = await Promise.all([shrink(answer.image, 144, 96, 'image/webp'), shrink(answer.icon, 32, 32, 'image/png')]);
  return {
    url: typeof answer.url === 'string' ? answer.url : url,
    ...(answer.title ? { title: String(answer.title) } : {}),
    ...(answer.description ? { description: String(answer.description) } : {}),
    site: answer.site,
    ...(image ? { image } : {}),
    ...(icon ? { icon } : {}),
  };
}

// An image cut to fill w × h (CSS pixels at 2x), as a small data: URI.
async function shrink(src: string | undefined, w: number, h: number, type: 'image/webp' | 'image/png'): Promise<string | undefined> {
  if (!src?.startsWith('data:image/')) return undefined;
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
  } catch {
    return undefined;
  }
  // An SVG without a size has none to scale from.
  const nw = img.naturalWidth || w;
  const nh = img.naturalHeight || h;
  const s = Math.min(1, Math.max(w / nw, h / nh));
  const dw = Math.max(1, Math.round(nw * s));
  const dh = Math.max(1, Math.round(nh * s));
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(dw, w);
  canvas.height = Math.min(dh, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
  try {
    const out = canvas.toDataURL(type, 0.8);
    if (out.startsWith(`data:${type}`)) return out;
    // No WebP encoder (Safari): JPEG, on white where it was transparent.
    const flat = document.createElement('canvas');
    flat.width = canvas.width;
    flat.height = canvas.height;
    const fctx = flat.getContext('2d')!;
    fctx.fillStyle = '#fff';
    fctx.fillRect(0, 0, flat.width, flat.height);
    fctx.drawImage(canvas, 0, 0);
    return flat.toDataURL('image/jpeg', 0.82);
  } catch {
    // A tainted canvas (some browsers, for SVG).
    return undefined;
  }
}
