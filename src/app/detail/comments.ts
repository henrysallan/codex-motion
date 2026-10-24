// Comments on a clip, Frame.io-style: scrub to a moment, write, send, and
// the comment keeps that timecode; clicking it jumps the player back there.
// A clip's comments are watched while a player has it open, so the info
// panel's list and the timeline's markers read the same ones. Posts and
// deletes show at once and roll back if the server refuses them.

import { useEffect } from 'react';
import { create } from 'zustand';
import { remoteEnabled } from '../../config.ts';
import { type ClipComment, deleteClipComment, fetchClipComments, insertClipComment, subscribeClipComments } from '../../data/clipComments.ts';
import { type Author, fetchAuthor } from '../../data/comments.ts';
import { getSession } from '../../data/supabase.ts';
import type { BoardController } from '../canvas/BoardController.ts';
import { useComments } from '../comments/state.ts';
import { setFocus, useStore } from '../store.ts';
import { toast } from '../toasts.tsx';
import { setInfoPanel, setInfoTab } from './state.ts';

// The player beside the panel: where its playhead is, and how to move it.
export interface Playhead {
  time(): number;
  seek(seconds: number): void;
  pause(): void;
}

interface State {
  comments: Record<string, ClipComment>;
  authors: Record<string, Author>;
  // Clips whose comments have loaded at least once.
  loaded: Record<string, true>;
  // The comment last jumped to or posted, highlighted in the list.
  selected: string | null;
}

export const useClipComments = create<State>(() => ({ comments: {}, authors: {}, loaded: {}, selected: null }));

const set = useClipComments.setState;
const get = useClipComments.getState;

// Posts not yet confirmed: a reload in the meantime keeps them.
const pending = new Set<string>();

// ---- players -----------------------------------------------------------------------

// The details view's <video>. Jumps pause it, so the frame stays in view.
export function videoPlayhead(video: HTMLVideoElement): Playhead {
  return {
    time: () => video.currentTime,
    seek: (t) => {
      video.pause();
      video.currentTime = t;
    },
    pause: () => video.pause(),
  };
}

// The clip in canvas focus mode, played by the engine.
export function focusPlayhead(ctrl: BoardController): Playhead {
  const pause = () => {
    const f = useStore.getState().focus;
    if (f?.playing) setFocus({ ...f, playing: false });
  };
  return {
    time: () => ctrl.focusTime,
    seek: (t) => {
      pause();
      ctrl.seekFocus(t);
    },
    pause,
  };
}

// ---- reading ---------------------------------------------------------------------

const watchers = new Map<string, { count: number; stop: () => void }>();

// Loads a clip's comments and keeps them current while anything watches it.
function watch(assetId: string): () => void {
  const w = watchers.get(assetId);
  if (w) w.count++;
  else watchers.set(assetId, { count: 1, stop: start(assetId) });
  return () => {
    const v = watchers.get(assetId);
    if (!v || --v.count > 0) return;
    watchers.delete(assetId);
    v.stop();
  };
}

function start(assetId: string): () => void {
  let live = true;
  const load = () =>
    fetchClipComments(assetId).then(
      ({ comments, authors }) => {
        if (!live) return;
        const s = get();
        const next: Record<string, ClipComment> = {};
        for (const c of Object.values(s.comments)) if (c.assetId !== assetId || pending.has(c.id)) next[c.id] = c;
        for (const c of comments) next[c.id] = c;
        const known = { ...s.authors };
        for (const a of authors) known[a.id] = a;
        set({ comments: next, authors: known, loaded: { ...s.loaded, [assetId]: true } });
      },
      (e: unknown) => {
        console.warn('clip comments:', e);
        if (live) set({ loaded: { ...get().loaded, [assetId]: true } });
      },
    );
  void load();
  const unsubscribe = subscribeClipComments(assetId, {
    insert: (c) => {
      if (!live) return;
      put(c);
      ensureAuthor(c.authorId);
    },
    delete: (id) => drop(id),
    resync: () => void load(),
  });
  return () => {
    live = false;
    unsubscribe();
    // Read afresh next time it opens.
    const s = get();
    const comments = { ...s.comments };
    for (const c of Object.values(comments)) if (c.assetId === assetId && !pending.has(c.id)) delete comments[c.id];
    const loaded = { ...s.loaded };
    delete loaded[assetId];
    set({ comments, loaded });
  };
}

// Players call this for the clip they have open.
export function useWatchClipComments(assetId: string | undefined): void {
  useEffect(() => (remoteEnabled && assetId ? watch(assetId) : undefined), [assetId]);
}

// A clip's comments in timeline order.
export function commentsOf(assetId: string, comments: Record<string, ClipComment>): ClipComment[] {
  return Object.values(comments)
    .filter((c) => c.assetId === assetId)
    .sort((a, b) => a.time - b.time || a.createdAt - b.createdAt);
}

const fetchingAuthors = new Set<string>();

function ensureAuthor(id: string): void {
  if (get().authors[id] || fetchingAuthors.has(id)) return;
  fetchingAuthors.add(id);
  void fetchAuthor(id)
    .then((a) => a && set({ authors: { ...get().authors, [id]: a } }))
    .finally(() => fetchingAuthors.delete(id));
}

// Who wrote a comment, as far as we know yet.
export function authorOf(c: ClipComment, authors: Record<string, Author>): Author | undefined {
  const me = useComments.getState().me;
  return authors[c.authorId] ?? (me?.id === c.authorId ? me : undefined);
}

function put(c: ClipComment): void {
  set({ comments: { ...get().comments, [c.id]: c } });
}

function drop(id: string): ClipComment | undefined {
  const s = get();
  const gone = s.comments[id];
  if (!gone) return undefined;
  const comments = { ...s.comments };
  delete comments[id];
  set({ comments, selected: s.selected === id ? null : s.selected });
  return gone;
}

// ---- jumping ---------------------------------------------------------------------

export function selectClipComment(id: string | null): void {
  set({ selected: id });
}

// Moves the player to a comment and highlights it in the panel, opening the
// panel on its comments tab if need be (a click on a timeline marker).
export function jumpTo(c: ClipComment, player: Playhead | undefined, { reveal = false } = {}): void {
  player?.seek(c.time);
  set({ selected: c.id });
  if (reveal) {
    setInfoPanel(true);
    setInfoTab('comments');
  }
}

// ---- writing ---------------------------------------------------------------------

export async function postClipComment(assetId: string, time: number, text: string): Promise<boolean> {
  const user = getSession()?.user;
  const body = text.trim();
  if (!user || !body) return false;
  const c: ClipComment = { id: crypto.randomUUID(), assetId, authorId: user.id, body, time: Math.max(0, time), createdAt: Date.now() };
  pending.add(c.id);
  put(c);
  set({ selected: c.id });
  try {
    await insertClipComment(c);
    return true;
  } catch (e) {
    drop(c.id);
    toast(`Couldn’t post comment: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    pending.delete(c.id);
  }
}

export async function removeClipComment(id: string): Promise<void> {
  const gone = drop(id);
  if (!gone) return;
  try {
    await deleteClipComment(id);
  } catch (e) {
    put(gone);
    toast(`Couldn’t delete comment: ${e instanceof Error ? e.message : String(e)}`);
  }
}
