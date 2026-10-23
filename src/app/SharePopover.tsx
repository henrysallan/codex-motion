// Publishing a collection: a read-only copy at /c/<slug> that anyone with
// the link can open. Only the owner can publish, rename the slug or take it
// down.

import { Check, Copy, Globe, Lock } from 'lucide-react';
import { useState } from 'react';
import { remoteEnabled } from '../config.ts';
import { supabase } from '../data/supabase.ts';
import { Button } from '../ui/controls.tsx';
import { type Anchor, Popover } from '../ui/popover.tsx';
import { setPublished, slugify, useStore } from './store.ts';

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function SharePopover({ collectionId, anchor, onClose }: { collectionId: string; anchor: Anchor; onClose: () => void }) {
  const c = useStore((s) => s.collections[collectionId]);
  const [slug, setSlug] = useState(c?.slug ?? slugify(c?.name ?? ''));
  const [state, setState] = useState<{ busy?: boolean; error?: string; copied?: boolean }>({});
  if (!c) return null;
  const url = `${location.origin}/c/${c.slug ?? slug}`;

  const publish = async () => {
    const s = slug.trim().toLowerCase();
    if (!SLUG.test(s)) {
      setState({ error: 'Use lowercase letters, numbers and dashes.' });
      return;
    }
    setState({ busy: true });
    // Slugs exist only while published, so any clash is visible here.
    const { data, error } = await supabase!.from('collections').select('id').eq('slug', s).neq('id', c.id).maybeSingle();
    if (error) setState({ error: error.message });
    else if (data) setState({ error: 'That link is taken.' });
    else {
      setPublished(c.id, s);
      setState({});
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setState({ copied: true });
    setTimeout(() => setState({}), 1500);
  };

  return (
    <Popover anchor={anchor} onClose={onClose} width={300}>
      <div className="share">
        <div className="share-head">
          {c.isPublic ? <Globe size={14} /> : <Lock size={14} />}
          <strong>{c.isPublic ? 'Published' : 'Private'}</strong>
          <span>{c.isPublic ? 'Anyone with the link can view' : 'Only you can see this'}</span>
        </div>
        {!remoteEnabled ? (
          <p className="share-note">Publishing needs the cloud setup (Supabase).</p>
        ) : c.isPublic ? (
          <>
            <div className="share-link">
              <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
              <Button size="sm" onClick={copy}>
                {state.copied ? <Check size={13} /> : <Copy size={13} />}
                {state.copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setPublished(c.id, null)}>
              Unpublish
            </Button>
          </>
        ) : (
          <>
            <label className="share-slug">
              <span>{location.host}/c/</span>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                onKeyDown={(e) => e.key === 'Enter' && void publish()}
                autoFocus
              />
            </label>
            {state.error && <p className="share-error">{state.error}</p>}
            <Button size="sm" variant="primary" disabled={state.busy} onClick={() => void publish()}>
              <Globe size={13} />
              Publish link
            </Button>
          </>
        )}
      </div>
    </Popover>
  );
}
