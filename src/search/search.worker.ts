// The search worker: loads the index bundle, holds the Feed's pool, and
// answers queries. Queries that arrive faster than they run collapse to the
// latest, so typing never queues up stale searches.

import { type SearchBundle, type SearchManifest, unpackVectors } from './bundle.ts';
import { type PoolDoc, type PoolItem, SearchIndex } from './engine.ts';
import type { FromSearch, ToSearch } from './protocol.ts';

const post = (msg: FromSearch) => (self as unknown as Worker).postMessage(msg);

let index: SearchIndex | null = null;
let pool: PoolItem[] | null = null;
let poolDirty = false;
// The newest query, and whether its answer is out of date (a newer query,
// the pool changed, the index arrived).
let current: Extract<ToSearch, { type: 'query' }> | null = null;
let stale = false;
let scheduled = false;
let exclude: Set<string> | undefined;
// Describe requests that came before the bundle, and the pool's own docs
// by id (built when first needed).
let waiting: string[] = [];
let extras: Map<string, PoolDoc> | null = null;

const empty: SearchBundle = { version: 1, built: '', sites: {}, pages: [], docs: [] };

async function load(manifestUrl: string, base: string): Promise<void> {
  const url = (key: string) => new URL(key, base).href;
  try {
    const res = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`no search index (${res.status})`);
    const m = (await res.json()) as SearchManifest;
    const [bundle, vec] = await Promise.all([
      fetch(url(m.bundle)).then((r) => (r.ok ? (r.json() as Promise<SearchBundle>) : Promise.reject(new Error(`bundle ${r.status}`)))),
      m.vectors ? fetch(url(m.vectors)).then((r) => (r.ok ? r.arrayBuffer() : null)) : null,
    ]);
    index = new SearchIndex(bundle, vec ? unpackVectors(vec, m.count, m.dims) : null);
    post({ type: 'ready', info: { count: m.count, built: m.built, model: vec ? m.model : null, dims: m.dims } });
  } catch (e) {
    // Still searchable by name and format.
    index = new SearchIndex(empty, null);
    post({ type: 'error', message: (e as Error).message });
    post({ type: 'ready', info: { count: 0, built: null, model: null, dims: 0 } });
  }
  poolDirty = true;
  schedule();
  if (waiting.length) describe(waiting);
  waiting = [];
}

function describe(ids: string[]): void {
  if (!index) {
    waiting.push(...ids);
    return;
  }
  extras ??= new Map((pool ?? []).flatMap((p) => (p.extra ? [[p.id, p.extra] as const] : [])));
  post({ type: 'described', ids, infos: ids.map((id) => index!.describe(id, extras!.get(id))) });
}

function schedule(): void {
  stale = true;
  if (scheduled) return;
  scheduled = true;
  setTimeout(run, 0);
}

function run(): void {
  scheduled = false;
  if (!index || !pool) return;
  if (poolDirty) {
    index.setPool(pool);
    poolDirty = false;
  }
  const q = current;
  if (!q || !stale) return;
  stale = false;
  const result = index.search(q.query, { queryVector: q.vector, exclude });
  post({ type: 'result', seq: q.seq, result });
}

self.onmessage = (e: MessageEvent<ToSearch>) => {
  const msg = e.data;
  if (msg.type === 'init') void load(msg.manifest, msg.base);
  else if (msg.type === 'pool') {
    pool = msg.items;
    poolDirty = true;
    extras = null;
    schedule();
  } else if (msg.type === 'query') {
    if (msg.exclude !== undefined) exclude = msg.exclude ? new Set(msg.exclude) : undefined;
    current = msg;
    schedule();
  } else if (msg.type === 'describe') describe(msg.ids);
};
