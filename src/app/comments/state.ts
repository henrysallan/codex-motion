// Comment threads on boards, Figma-style: the comment tool drops a pin,
// you type and send, and the pin shows its author until you open it.
// Anyone signed in who can see a board can comment on it; a comment can be
// deleted by its author or the board's owner.
//
// Comments live outside the main store: they're not part of a board's undo
// history or local cache. Posts and deletes show at once and roll back if
// the server refuses them.

import { create } from 'zustand';
import { type Author, type Comment, deleteComment, fetchAuthor, fetchComments, insertComment, subscribeComments } from '../../data/comments.ts';
import type { Placement } from '../../data/model.ts';
import { getSession, onAuthChange } from '../../data/supabase.ts';
import type { Anchor } from '../../ui/popover.tsx';
import { useStore } from '../store.ts';
import { toast } from '../toasts.tsx';

// Where a new pin goes: a canvas point, and the clip under it if any.
export interface Spot {
  x: number;
  y: number;
  placementId: string | null;
  px: number | null;
  py: number | null;
}

interface Draft {
  collectionId: string;
  spot: Spot;
  text: string;
}

interface State {
  comments: Record<string, Comment>;
  authors: Record<string, Author>;
  // The signed-in user's profile.
  me: Author | null;
  // The open thread (its first comment's id).
  open: string | null;
  // A pin being written.
  draft: Draft | null;
  // Signed out and tried to comment: where to ask them to sign in.
  signIn: Anchor | null;
}

export const useComments = create<State>(() => ({ comments: {}, authors: {}, me: null, open: null, draft: null, signIn: null }));

const set = useComments.setState;
const get = useComments.getState;

// Posts not yet confirmed: a reload in the meantime keeps them.
const pending = new Set<string>();

// ---- who's here ------------------------------------------------------------------

function refreshMe(): void {
  const user = getSession()?.user;
  if (!user) {
    if (get().me) set({ me: null, draft: null });
    return;
  }
  // Token refreshes land here too.
  if (get().me?.id === user.id) return;
  // From the sign-in until the profile loads.
  const meta = user.user_metadata ?? {};
  const guess: Author = {
    id: user.id,
    name: (meta.full_name as string) || (meta.name as string) || user.email?.split('@')[0] || 'You',
    avatarUrl: (meta.avatar_url as string) ?? null,
    color: '#4f7cff',
  };
  set({ me: guess, signIn: null });
  void fetchAuthor(user.id).then((me) => {
    if (me && getSession()?.user.id === me.id) set({ me, authors: { ...get().authors, [me.id]: me } });
  });
}

onAuthChange(refreshMe);
refreshMe();

export function canDelete(c: Comment, userId: string | null | undefined): boolean {
  if (!userId) return false;
  return c.authorId === userId || useStore.getState().collections[c.collectionId]?.createdBy === userId;
}

const fetchingAuthors = new Set<string>();

function ensureAuthor(id: string): void {
  if (get().authors[id] || fetchingAuthors.has(id)) return;
  fetchingAuthors.add(id);
  void fetchAuthor(id)
    .then((a) => a && set({ authors: { ...get().authors, [id]: a } }))
    .finally(() => fetchingAuthors.delete(id));
}

// ---- reading ---------------------------------------------------------------------

// Loads a board's comments and keeps them current until the returned
// function is called.
export function watchComments(collectionId: string): () => void {
  let live = true;
  const load = () =>
    fetchComments(collectionId).then(
      ({ comments, authors }) => {
        if (!live) return;
        const s = get();
        const next: Record<string, Comment> = {};
        for (const c of Object.values(s.comments)) if (c.collectionId !== collectionId || pending.has(c.id)) next[c.id] = c;
        for (const c of comments) next[c.id] = c;
        const known = { ...s.authors };
        for (const a of authors) known[a.id] = a;
        set({ comments: next, authors: known, open: s.open && next[s.open] ? s.open : null });
      },
      (e: unknown) => console.warn('comments:', e),
    );
  void load();
  const unsubscribe = subscribeComments(collectionId, {
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
  };
}

function put(c: Comment): void {
  set({ comments: { ...get().comments, [c.id]: c } });
}

// Removes a comment and, if it starts a thread, its replies.
function drop(id: string): Comment[] {
  const s = get();
  const gone = Object.values(s.comments).filter((c) => c.id === id || c.parentId === id);
  if (!gone.length) return gone;
  const comments = { ...s.comments };
  for (const c of gone) delete comments[c.id];
  set({ comments, open: s.open === id ? null : s.open });
  return gone;
}

export interface Thread {
  root: Comment;
  replies: Comment[];
}

export function threadsOf(collectionId: string, comments: Record<string, Comment>): Thread[] {
  const roots = new Map<string, Thread>();
  const replies: Comment[] = [];
  for (const c of Object.values(comments)) {
    if (c.collectionId !== collectionId) continue;
    if (c.parentId) replies.push(c);
    else roots.set(c.id, { root: c, replies: [] });
  }
  for (const r of replies) roots.get(r.parentId!)?.replies.push(r);
  const byTime = (a: Comment, b: Comment) => a.createdAt - b.createdAt;
  const threads = [...roots.values()].sort((a, b) => byTime(a.root, b.root));
  for (const t of threads) t.replies.sort(byTime);
  return threads;
}

// A pin on a clip sits at its spot on the clip; otherwise (or once the clip
// is gone) where it was dropped.
export function pinPoint(c: Pick<Comment, 'x' | 'y' | 'placementId' | 'px' | 'py'>, placements: Record<string, Placement>): { x: number; y: number } {
  const p = c.placementId ? placements[c.placementId] : undefined;
  if (p && c.px !== null && c.py !== null) return { x: p.x + c.px * p.w, y: p.y + c.py * p.h };
  return { x: c.x ?? 0, y: c.y ?? 0 };
}

// ---- the comment tool -------------------------------------------------------------

// A click with the comment tool. The first click closes whatever is open;
// with nothing open it starts a pin there. A pin already being written
// moves to the click, unless it has text, which shouldn't be lost.
export function commentAt(collectionId: string, spot: Spot, client: { x: number; y: number }): void {
  const s = get();
  if (!getSession()) {
    set({ signIn: client });
    return;
  }
  if (s.open) {
    set({ open: null });
    return;
  }
  if (s.draft?.text.trim()) {
    document.querySelector<HTMLTextAreaElement>('.comment-spot.draft textarea')?.focus();
    return;
  }
  set({ draft: { collectionId, spot, text: '' } });
}

export function askToSignIn(anchor: Anchor | null): void {
  set({ signIn: anchor });
}

export function setDraftText(text: string): void {
  const d = get().draft;
  if (d) set({ draft: { ...d, text } });
}

export function cancelDraft(): void {
  if (get().draft) set({ draft: null });
}

export function openThread(id: string | null): void {
  const s = get();
  set({ open: id, draft: s.draft?.text.trim() ? s.draft : null });
}

// Escape or a press elsewhere: closes the open thread and drops an empty
// draft. Says whether there was anything to close.
export function dismissComments({ keepDraft = false } = {}): boolean {
  const s = get();
  const dropDraft = !!s.draft && (!keepDraft || !s.draft.text.trim());
  if (!s.open && !dropDraft) return false;
  set({ open: null, ...(dropDraft ? { draft: null } : {}) });
  return true;
}

// ---- writing ---------------------------------------------------------------------

async function post(c: Comment): Promise<boolean> {
  pending.add(c.id);
  put(c);
  try {
    await insertComment(c);
    return true;
  } catch (e) {
    drop(c.id);
    toast(`Couldn’t post comment: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    pending.delete(c.id);
  }
}

export async function sendDraft(): Promise<void> {
  const d = get().draft;
  const user = getSession()?.user;
  const body = d?.text.trim();
  if (!d || !user || !body) return;
  set({ draft: null });
  const ok = await post({
    id: crypto.randomUUID(),
    collectionId: d.collectionId,
    parentId: null,
    authorId: user.id,
    body,
    createdAt: Date.now(),
    ...d.spot,
  });
  // Put the text back to try again.
  if (!ok && !get().draft) set({ draft: d });
}

export function reply(root: Comment, text: string): Promise<boolean> {
  const user = getSession()?.user;
  const body = text.trim();
  if (!user || !body) return Promise.resolve(false);
  return post({
    id: crypto.randomUUID(),
    collectionId: root.collectionId,
    parentId: root.id,
    authorId: user.id,
    body,
    createdAt: Date.now(),
    x: null,
    y: null,
    placementId: null,
    px: null,
    py: null,
  });
}

// Deletes a comment, or a whole thread from its first comment.
export async function removeComment(id: string): Promise<void> {
  const gone = drop(id);
  if (!gone.length) return;
  try {
    await deleteComment(id);
  } catch (e) {
    const comments = { ...get().comments };
    for (const c of gone) comments[c.id] = c;
    set({ comments });
    toast(`Couldn’t delete comment: ${e instanceof Error ? e.message : String(e)}`);
  }
}
