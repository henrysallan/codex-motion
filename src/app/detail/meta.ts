// An asset's source and analysis records. Local mode has them on the store
// asset (library.json carries both); signed in, the startup select leaves
// them out, so they're read once per asset when its details open.

import { useEffect, useState } from 'react';
import type { AssetRecord } from '../../data/model.ts';
import { fetchAssetMeta } from '../../data/remote.ts';
import { useStore } from '../store.ts';

type Meta = Pick<AssetRecord, 'source' | 'analysis'>;

const cache = new Map<string, Promise<Meta>>();

function load(id: string): Promise<Meta> {
  let p = cache.get(id);
  if (!p) {
    p = fetchAssetMeta(id).catch((e: unknown) => {
      // Try again next time it opens.
      cache.delete(id);
      console.warn(e);
      return {};
    });
    cache.set(id, p);
  }
  return p;
}

export function useAssetMeta(asset: AssetRecord | undefined): Meta & { loading: boolean } {
  const cloud = useStore((s) => s.mode !== 'local');
  const [fetched, setFetched] = useState<{ id: string; meta: Meta } | null>(null);
  const id = asset?.id;
  const need = !!asset && cloud && !asset.source && !asset.analysis;

  useEffect(() => {
    if (!need || !id) return;
    let live = true;
    void load(id).then((meta) => live && setFetched({ id, meta }));
    return () => {
      live = false;
    };
  }, [need, id]);

  if (!asset) return { loading: false };
  if (!need) return { source: asset.source, analysis: asset.analysis, loading: false };
  const meta = fetched && fetched.id === id ? fetched.meta : null;
  return { source: meta?.source, analysis: meta?.analysis, loading: !meta };
}
