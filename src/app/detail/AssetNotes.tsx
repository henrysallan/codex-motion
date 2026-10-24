// The Notes section of a clip's details: your own notes on the clip, saved
// as you type. Read, links are links, each with a small preview card after
// its line (a line that's only a link becomes its card). Click the text to
// edit; Escape, ⌘Enter or clicking away finishes. Nobody else sees them.

import { Globe, Lock, Pencil } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { remoteEnabled } from '../../config.ts';
import type { AssetNote, LinkPreview } from '../../data/assetNotes.ts';
import type { AssetRecord } from '../../data/model.ts';
import { useAuth } from '../../data/supabase.ts';
import { useStore } from '../store.ts';
import { linkify, type Segment } from './links.ts';
import { editNote, flushNote, loadNote, MAX_NOTE, MAX_PREVIEWS, noteKey, previewLinks, useNotes } from './notes.ts';
import '../../styles/notes.css';

export function AssetNotes({ asset }: { asset: AssetRecord }) {
  const shared = useStore((s) => s.mode === 'public');
  const userId = useAuth().session?.user.id;
  const owner = remoteEnabled ? userId : 'local';
  if (shared || !owner) return null;
  return <Notes key={noteKey(owner, asset.id)} owner={owner} assetId={asset.id} />;
}

function Notes({ owner, assetId }: { owner: string; assetId: string }) {
  const key = noteKey(owner, assetId);
  const note = useNotes((s) => s.notes[key]);
  const loadError = useNotes((s) => s.loadErrors[key]);
  const saving = useNotes((s) => s.saving[key]);
  const [editing, setEditing] = useState(false);
  const body = note?.body ?? '';

  useEffect(() => loadNote(owner, assetId), [owner, assetId]);
  // Whatever's waiting saves when the clip changes or the panel closes.
  useEffect(() => () => void flushNote(owner, assetId), [owner, assetId]);
  useEffect(() => {
    if (!editing && body) previewLinks(owner, assetId);
  }, [editing, body, owner, assetId]);

  const done = () => {
    setEditing(false);
    void flushNote(owner, assetId);
  };

  return (
    <section className="info-section notes">
      <h3>
        Notes
        <span className={`info-aside notes-status ${saving === 'error' ? 'error' : ''}`}>
          {saving === 'pending' ? (
            'Saving…'
          ) : saving === 'error' ? (
            'Not saved'
          ) : (
            <>
              <Lock size={9} />
              Only you
            </>
          )}
        </span>
        {note?.body.trim() && !editing && (
          <button type="button" className="notes-edit" aria-label="Edit notes" title="Edit notes" onClick={() => setEditing(true)}>
            <Pencil size={11} />
          </button>
        )}
      </h3>
      {loadError ? (
        <p className="info-empty">
          Couldn’t load your notes.{' '}
          <button type="button" className="info-more" onClick={() => loadNote(owner, assetId)}>
            Try again
          </button>
        </p>
      ) : note === undefined ? (
        <div className="info-skeleton" aria-hidden>
          <span style={{ width: '70%' }} />
        </div>
      ) : editing ? (
        <Editor value={body} onChange={(v) => editNote(owner, assetId, v)} onDone={done} />
      ) : note?.body.trim() ? (
        <NoteView note={note} onEdit={() => setEditing(true)} />
      ) : (
        <button type="button" className="notes-empty" onClick={() => setEditing(true)}>
          Add notes, links, references…
        </button>
      )}
    </section>
  );
}

function Editor({ value, onChange, onDone }: { value: string; onChange: (v: string) => void; onDone: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Opens with the caret at the end.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Grows with the text, up to a point.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`;
    el.style.overflowY = el.scrollHeight > 318 ? 'auto' : 'hidden';
  }, [value]);

  return (
    <textarea
      ref={ref}
      className="notes-input"
      value={value}
      maxLength={MAX_NOTE}
      placeholder="Anything worth remembering. Links get a preview."
      aria-label="Notes"
      onChange={(e) => onChange(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
          e.preventDefault();
          e.stopPropagation();
          e.currentTarget.blur();
        }
      }}
    />
  );
}

// The note in chunks: lines up to and including one with links, then the
// cards for those links.
interface Chunk {
  lines: Segment[][];
  links: string[];
}

function chunksOf(body: string): Chunk[] {
  const chunks: Chunk[] = [];
  const shown = new Set<string>();
  let lines: Segment[][] = [];
  for (const line of body.replace(/\s+$/, '').split('\n')) {
    const segs = linkify(line);
    lines.push(segs);
    const links: string[] = [];
    for (const s of segs) {
      if (!('href' in s) || shown.has(s.href) || shown.size >= MAX_PREVIEWS) continue;
      shown.add(s.href);
      links.push(s.href);
    }
    if (links.length) {
      chunks.push({ lines, links });
      lines = [];
    }
  }
  if (lines.length) chunks.push({ lines, links: [] });
  return chunks;
}

// "https://www.vimeo.com/123/" -> "vimeo.com/123", cut short if long.
function shortLink(text: string): string {
  const t = text.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  return t.length > 48 ? `${t.slice(0, 47)}…` : t;
}

function NoteView({ note, onEdit }: { note: AssetNote; onEdit: () => void }) {
  const unfurling = useNotes((s) => s.unfurling);
  const chunks = useMemo(() => chunksOf(note.body), [note.body]);

  return (
    <div
      className="notes-view"
      onClick={(e) => {
        // Links open; selecting text to copy doesn't start editing.
        if ((e.target as Element).closest('a, button') || getSelection()?.toString()) return;
        onEdit();
      }}
    >
      {chunks.map((c, i) => {
        // A line that's only a link shows as its card, once there is one.
        const last = c.lines[c.lines.length - 1].filter((s) => 'href' in s || s.text.trim());
        const bare = c.links.length === 1 && last.length === 1 && 'href' in last[0] && !!note.links[c.links[0]];
        const lines = bare ? c.lines.slice(0, -1) : c.lines;
        return (
          <Fragment key={i}>
            {lines.length > 0 && (
              <p className="notes-text">
                {lines.map((segs, j) => (
                  <Fragment key={j}>
                    {j > 0 && '\n'}
                    {segs.map((s, k) =>
                      'href' in s ? (
                        <a key={k} href={s.href} target="_blank" rel="noreferrer noopener" title={s.href}>
                          {shortLink(s.text)}
                        </a>
                      ) : (
                        s.text
                      ),
                    )}
                  </Fragment>
                ))}
              </p>
            )}
            {c.links.map((href) =>
              note.links[href] ? <Card key={href} href={href} preview={note.links[href]} /> : unfurling[href] ? <Loading key={href} /> : null,
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

function Card({ href, preview }: { href: string; preview: LinkPreview }) {
  const image = preview.image?.startsWith('data:image/') ? preview.image : undefined;
  const icon = preview.icon?.startsWith('data:image/') ? preview.icon : undefined;
  return (
    <a className="note-card" href={href} target="_blank" rel="noreferrer noopener" title={href}>
      {image && <img className="note-card-thumb" src={image} alt="" />}
      <span className="note-card-text">
        <span className="note-card-title">{preview.title || shortLink(href)}</span>
        {preview.description && <span className="note-card-desc">{preview.description}</span>}
        <span className="note-card-site">
          {icon ? <img src={icon} alt="" /> : <Globe size={10} />}
          {preview.site}
        </span>
      </span>
    </a>
  );
}

function Loading() {
  return (
    <div className="note-card loading" aria-hidden>
      <span className="note-card-thumb" />
      <span className="note-card-text">
        <span style={{ width: '75%' }} />
        <span style={{ width: '45%' }} />
      </span>
    </div>
  );
}
