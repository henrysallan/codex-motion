// The uploader's own controls in an upload's details: the link it came from,
// which Enrich reads for project details while it tags the clip's frames,
// whether the clip shows in everyone's Feed, and deleting it. Uploads stay
// in their collections only until shared.

import { Sparkles, Trash2 } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import type { AssetRecord } from '../../data/model.ts';
import { Button } from '../../ui/controls.tsx';
import { deleteUpload } from '../deleteUpload.ts';
import { enrichUpload, setInFeed, useEnrich } from '../enrich.ts';
import { plural } from '../format.ts';
import { useStore } from '../store.ts';
import { toast } from '../toasts.tsx';
import { useAssetMeta } from './meta.ts';
import '../../styles/enrich.css';

export function UploadEnrich({ asset }: { asset: AssetRecord }) {
  const mode = useStore((s) => s.mode);
  const userId = useStore((s) => s.user.id);
  if (asset.origin !== 'upload' || mode === 'public' || (mode === 'remote' && asset.addedBy !== userId)) return null;
  return <Controls asset={asset} cloud={mode === 'remote'} />;
}

const money = (n: number) => `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;

function Controls({ asset, cloud }: { asset: AssetRecord; cloud: boolean }) {
  const known = useAssetMeta(asset);
  const state = useEnrich((s) => s[asset.id]);
  const [url, setUrl] = useState(asset.sourceUrl ?? '');
  // Another clip, or the link saved by a run.
  useEffect(() => setUrl(asset.sourceUrl ?? ''), [asset.id, asset.sourceUrl]);
  const busy = state?.step === 'frames' || state?.step === 'page';
  const ready = asset.status === 'ready';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy && ready) void enrichUpload(asset, url, known);
  };

  let status: { text: string; error?: boolean } | null = null;
  if (!ready) status = { text: 'Enrich is available once the clip finishes processing.' };
  else if (state?.step === 'frames') status = { text: 'Reading frames…' };
  else if (state?.step === 'page') status = { text: url.trim() ? 'Reading the page and tagging…' : 'Tagging…' };
  else if (state?.step === 'error') status = { text: state.message ?? 'Enrich failed', error: true };
  else if (state?.step === 'done') {
    const spent = state.cost != null ? ` · ${money(state.cost)}` : '';
    status = state.message ? { text: `Tagged, but couldn’t read the page: ${state.message}${spent}`, error: true } : { text: `Enriched${spent}` };
  }

  return (
    <section className="info-section enrich">
      <h3>Your upload</h3>
      {cloud && (
        <>
          <form className="enrich-form" onSubmit={submit}>
            <input
              className="enrich-url"
              type="url"
              inputMode="url"
              placeholder="Link to the project or video"
              aria-label="Source link"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
            />
            <Button size="sm" variant="primary" type="submit" disabled={busy || !ready} title="Read the link for project details and tag the clip’s frames">
              <Sparkles size={12} />
              {busy ? 'Enriching' : 'Enrich'}
            </Button>
          </form>
          {status && (
            <p className={`enrich-status ${status.error ? 'error' : ''}`} role="status">
              {status.text}
            </p>
          )}
        </>
      )}
      <label className="enrich-feed">
        <input type="checkbox" role="switch" checked={!!asset.inFeed} disabled={!ready} onChange={(e) => void setInFeed(asset, e.target.checked)} />
        <span>Show in Feed</span>
      </label>
      <p className="enrich-hint">{asset.inFeed ? (cloud ? 'Everyone sees it in the Feed and in search.' : 'It shows in the Feed and in search.') : 'Only in your collections.'}</p>
      <DeleteUpload asset={asset} cloud={cloud} />
    </section>
  );
}

function DeleteUpload({ asset, cloud }: { asset: AssetRecord; cloud: boolean }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setProblem(null), [asset.id]);

  const remove = async () => {
    const boards = new Set(Object.values(useStore.getState().placements).flatMap((p) => (p.assetId === asset.id ? [p.collectionId] : []))).size;
    const from = [boards ? plural(boards, 'collection') : '', asset.inFeed ? 'the Feed' : ''].filter(Boolean).join(' and ');
    const files = cloud ? 'its files are deleted, freeing up the space' : 'its files are deleted from this device';
    if (!confirm(`Delete “${asset.name}”? ${from ? `It comes off ${from}, and ${files}` : files[0].toUpperCase() + files.slice(1)}. This can’t be undone.`)) return;
    setBusy(true);
    setProblem(null);
    const why = await deleteUpload(asset);
    if (why) {
      setBusy(false);
      setProblem(why);
    } else {
      toast(`Deleted ${asset.name}`);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="enrich-delete"
        disabled={busy || asset.status === 'processing'}
        title={asset.status === 'processing' ? 'Available once the clip finishes processing' : 'Delete this upload and its files'}
        onClick={() => void remove()}
      >
        <Trash2 size={12} />
        {busy ? 'Deleting…' : 'Delete upload'}
      </Button>
      {problem && (
        <p className="enrich-status error" role="status">
          {problem}
        </p>
      )}
    </>
  );
}
