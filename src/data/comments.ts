// Comments against Supabase. Unlike the board's own records they aren't
// cached or queued: they're read when a board opens, written straight
// through, and kept current by a realtime subscription.

import { supabase } from './supabase.ts';

export interface Author {
  id: string;
  name: string;
  avatarUrl: string | null;
  color: string;
}

export interface Comment {
  id: string;
  collectionId: string;
  // The thread's first comment; null for that comment itself.
  parentId: string | null;
  authorId: string;
  body: string;
  createdAt: number;
  // A thread's pin, in canvas coordinates (null on replies).
  x: number | null;
  y: number | null;
  // A pin on a clip follows it: where on the clip, 0..1 across and down.
  placementId: string | null;
  px: number | null;
  py: number | null;
}

type Row = Record<string, unknown>;

const COLUMNS = 'id, collection_id, parent_id, author_id, body, x, y, placement_id, px, py, created_at, author:profiles(id, name, avatar_url, color)';

export function rowToAuthor(r: Row): Author {
  return {
    id: r.id as string,
    name: (r.name as string) || 'Someone',
    avatarUrl: (r.avatar_url as string) ?? null,
    color: (r.color as string) ?? '#4f7cff',
  };
}

function rowToComment(r: Row): Comment {
  return {
    id: r.id as string,
    collectionId: r.collection_id as string,
    parentId: (r.parent_id as string) ?? null,
    authorId: r.author_id as string,
    body: r.body as string,
    createdAt: typeof r.created_at === 'string' ? Date.parse(r.created_at) : Date.now(),
    x: (r.x as number) ?? null,
    y: (r.y as number) ?? null,
    placementId: (r.placement_id as string) ?? null,
    px: (r.px as number) ?? null,
    py: (r.py as number) ?? null,
  };
}

export async function fetchComments(collectionId: string): Promise<{ comments: Comment[]; authors: Author[] }> {
  const comments: Comment[] = [];
  const authors = new Map<string, Author>();
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase!
      .from('comments')
      .select(COLUMNS)
      .eq('collection_id', collectionId)
      .order('created_at')
      .range(from, from + page - 1);
    if (error) throw new Error(`comments: ${error.message}`);
    for (const r of data as Row[]) {
      comments.push(rowToComment(r));
      if (r.author) authors.set(r.author_id as string, rowToAuthor(r.author as Row));
    }
    if (data.length < page) return { comments, authors: [...authors.values()] };
  }
}

export async function fetchAuthor(id: string): Promise<Author | null> {
  const { data } = await supabase!.from('profiles').select('id, name, avatar_url, color').eq('id', id).maybeSingle();
  return data ? rowToAuthor(data as Row) : null;
}

export async function insertComment(c: Comment): Promise<void> {
  const { error } = await supabase!.from('comments').insert({
    id: c.id,
    collection_id: c.collectionId,
    parent_id: c.parentId,
    body: c.body,
    x: c.x,
    y: c.y,
    placement_id: c.placementId,
    px: c.px,
    py: c.py,
  });
  if (error) throw new Error(error.message);
}

export async function deleteComment(id: string): Promise<void> {
  const { error, count } = await supabase!.from('comments').delete({ count: 'exact' }).eq('id', id);
  if (error) throw new Error(error.message);
  // RLS hides rows this user can't delete rather than failing.
  if (count === 0) throw new Error('Not allowed');
}

// New comments on one board, and deletions anywhere (Postgres can't filter
// deletes by column; they carry only the id). On a reconnect it calls
// `onResync`, since events in the gap are lost.
export function subscribeComments(
  collectionId: string,
  on: { insert: (c: Comment) => void; delete: (id: string) => void; resync: () => void },
): () => void {
  let subscribed = false;
  const channel = supabase!
    .channel(`comments:${collectionId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments', filter: `collection_id=eq.${collectionId}` }, (p) =>
      on.insert(rowToComment(p.new as Row)),
    )
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'comments' }, (p) => {
      const id = (p.old as Row).id;
      if (typeof id === 'string') on.delete(id);
    })
    .subscribe((status) => {
      if (status !== 'SUBSCRIBED') return;
      if (subscribed) on.resync();
      subscribed = true;
    });
  return () => void supabase!.removeChannel(channel);
}
