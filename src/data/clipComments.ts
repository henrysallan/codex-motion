// Clip comments against Supabase: notes pinned to a moment in a clip. Like
// board comments they aren't cached or queued: they're read when a clip
// opens, written straight through, and kept current by a realtime
// subscription.

import { type Author, rowToAuthor } from './comments.ts';
import { supabase } from './supabase.ts';

export interface ClipComment {
  id: string;
  assetId: string;
  authorId: string;
  body: string;
  // Seconds into the clip.
  time: number;
  createdAt: number;
}

type Row = Record<string, unknown>;

const COLUMNS = 'id, asset_id, author_id, body, timecode, created_at, author:profiles(id, name, avatar_url, color)';

function rowToComment(r: Row): ClipComment {
  return {
    id: r.id as string,
    assetId: r.asset_id as string,
    authorId: r.author_id as string,
    body: r.body as string,
    time: Number(r.timecode) || 0,
    createdAt: typeof r.created_at === 'string' ? Date.parse(r.created_at) : Date.now(),
  };
}

export async function fetchClipComments(assetId: string): Promise<{ comments: ClipComment[]; authors: Author[] }> {
  const comments: ClipComment[] = [];
  const authors = new Map<string, Author>();
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase!
      .from('clip_comments')
      .select(COLUMNS)
      .eq('asset_id', assetId)
      .order('timecode')
      .order('created_at')
      .range(from, from + page - 1);
    if (error) throw new Error(`clip comments: ${error.message}`);
    for (const r of data as Row[]) {
      comments.push(rowToComment(r));
      if (r.author) authors.set(r.author_id as string, rowToAuthor(r.author as Row));
    }
    if (data.length < page) return { comments, authors: [...authors.values()] };
  }
}

export async function insertClipComment(c: ClipComment): Promise<void> {
  const { error } = await supabase!.from('clip_comments').insert({ id: c.id, asset_id: c.assetId, body: c.body, timecode: c.time });
  if (error) throw new Error(error.message);
}

export async function deleteClipComment(id: string): Promise<void> {
  const { error, count } = await supabase!.from('clip_comments').delete({ count: 'exact' }).eq('id', id);
  if (error) throw new Error(error.message);
  // RLS hides rows this user can't delete rather than failing.
  if (count === 0) throw new Error('Not allowed');
}

// New comments on one clip, and deletions anywhere (Postgres can't filter
// deletes by column; they carry only the id). On a reconnect it calls
// `resync`, since events in the gap are lost.
export function subscribeClipComments(
  assetId: string,
  on: { insert: (c: ClipComment) => void; delete: (id: string) => void; resync: () => void },
): () => void {
  let subscribed = false;
  const channel = supabase!
    .channel(`clip-comments:${assetId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'clip_comments', filter: `asset_id=eq.${assetId}` }, (p) =>
      on.insert(rowToComment(p.new as Row)),
    )
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'clip_comments' }, (p) => {
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
