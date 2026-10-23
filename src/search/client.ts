// Main-thread side of search: runs the search worker, embeds query text
// through the embed endpoint, and keeps the latest result in a small store.
//
// Text results come back on every keystroke. The visual half needs the
// query embedded, which takes a round trip, so it starts once typing pauses
// and the result is re-run when the vector lands. Vectors are cached per
// text, and the endpoint's responses cache in the browser and CDN for good.

import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { config } from '../config.ts';
import { embeddingText, type PoolItem, type SearchQuery, type SearchResult } from './engine.ts';
import type { FromSearch, IndexInfo, ToSearch } from './protocol.ts';

interface SearchState {
  info: IndexInfo | null;
  error: string | null;
  result: SearchResult | null;
}

export const useSearch = create<SearchState>(() => ({ info: null, error: null, result: null }));

let worker: Worker | null = null;
let seq = 0;
let shown = 0;

function searchWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module', name: 'search' });
  worker.onmessage = (e: MessageEvent<FromSearch>) => {
    const msg = e.data;
    if (msg.type === 'ready') useSearch.setState({ info: msg.info });
    else if (msg.type === 'error') {
      console.warn(`search: ${msg.message}`);
      useSearch.setState({ error: msg.message });
    } else if (msg.type === 'result') {
      if (msg.seq < shown) return;
      shown = msg.seq;
      useSearch.setState({ result: msg.result });
    }
  };
  // Signed in: the bundle sits beside the media in R2. Local: public/media.
  const base = config.mediaUrl ? `${config.mediaUrl}/` : document.baseURI;
  send({ type: 'init', manifest: new URL('media/search/manifest.json', base).href, base });
  return worker;
}

const send = (msg: ToSearch) => searchWorker().postMessage(msg);

// ---- query embeddings ---------------------------------------------------------------

const vectors = new Map<string, Float32Array | null>();
// After a failure, skip the endpoint for a while instead of hammering it.
let downUntil = 0;

async function embed(text: string, model: string, signal: AbortSignal): Promise<Float32Array | null> {
  if (!config.embedUrl || Date.now() < downUntil) return null;
  try {
    const res = await fetch(`${config.embedUrl}?q=${encodeURIComponent(text)}`, { signal });
    if (!res.ok) throw new Error(`embed: HTTP ${res.status}`);
    // A vector from another model would compare against nothing.
    if (res.headers.get('X-Embed-Model') !== model) throw new Error(`embed: model ${res.headers.get('X-Embed-Model')} != index ${model}`);
    return new Float32Array(await res.arrayBuffer());
  } catch (e) {
    if (signal.aborted) throw e;
    console.warn((e as Error).message);
    downUntil = Date.now() + 60_000;
    return null;
  }
}

// ---- hook -------------------------------------------------------------------------------

const EMBED_DELAY = 300;

// Keeps the worker's pool and query in step with the Feed. `exclude` is
// compared by identity, so pass a memoised array.
export function useFeedSearch(pool: PoolItem[], query: SearchQuery, exclude: string[] | null): void {
  const info = useSearch((s) => s.info);
  const sentExclude = useRef<string[] | null | undefined>(undefined);
  const pending = useRef<{ text: string; abort: AbortController; timer: number } | null>(null);
  const latest = useRef(query);
  latest.current = query;

  useEffect(() => {
    send({ type: 'pool', items: pool });
  }, [pool]);

  useEffect(() => {
    const text = embeddingText(query.text);
    const model = info?.model ?? null;
    const changed = sentExclude.current !== exclude;
    sentExclude.current = exclude;
    const post = (vector: Float32Array | null | undefined, withExclude: boolean) =>
      send({ type: 'query', seq: ++seq, query, vector, ...(withExclude ? { exclude } : {}) });

    if (!text || !model) {
      post(null, changed);
      return;
    }
    if (vectors.has(text)) {
      post(vectors.get(text), changed);
      return;
    }
    post(Date.now() < downUntil || !config.embedUrl ? null : undefined, changed);
    if (pending.current?.text === text) return;
    if (pending.current) {
      clearTimeout(pending.current.timer);
      pending.current.abort.abort();
    }
    const abort = new AbortController();
    const timer = window.setTimeout(() => {
      embed(text, model, abort.signal).then(
        (v) => {
          vectors.set(text, v);
          if (pending.current?.abort === abort) pending.current = null;
          // The query may have moved on (a filter, more typing) meanwhile.
          const now = latest.current;
          if (embeddingText(now.text) === text) send({ type: 'query', seq: ++seq, query: now, vector: v });
        },
        () => {},
      );
    }, EMBED_DELAY);
    pending.current = { text, abort, timer };
  }, [query, exclude, info]);
}
