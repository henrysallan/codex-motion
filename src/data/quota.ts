// The upload quota (supabase/migrations/20261023235500_upload_quota.sql):
// each account may store 1 GB of uploads, every rendition counted; admins
// have no limit. The server enforces it. The app keeps a copy of the
// numbers to turn away a drop that won't fit before doing any work on it,
// and declares each upload's size before its files go up.

import { create } from 'zustand';
import { getSession, supabase } from './supabase.ts';

export interface Quota {
  used: number;
  // Null: no limit.
  limit: number | null;
}

// Null until loaded, and always when the app runs local-only.
export const useQuota = create<{ quota: Quota | null }>(() => ({ quota: null }));

function keep(q: Partial<Quota>): void {
  if (typeof q.used === 'number') useQuota.setState({ quota: { used: q.used, limit: q.limit ?? null } });
}

export async function refreshQuota(): Promise<void> {
  if (!supabase) return;
  const { data, error } = await supabase.rpc('upload_quota');
  if (error) console.warn('upload quota:', error.message);
  else keep(data as Quota);
}

// 'ok': reserved. 'full': it doesn't fit. 'shared': someone else added
// this file first, so its space is theirs. 'missing': its row hasn't
// reached the server yet.
export type Reservation = 'ok' | 'full' | 'shared' | 'missing';

// Declares an upload's total size before its files go up.
export async function reserveUpload(id: string, bytes: number): Promise<Reservation> {
  if (!supabase) return 'ok';
  const { data, error } = await supabase.rpc('reserve_upload', { asset: id, total: bytes });
  if (error) throw new Error(`reserve_upload: ${error.message}`);
  const r = data as Partial<Quota> & { status: Reservation };
  keep(r);
  return r.status;
}

// Of these file hashes, the ones someone else has uploaded privately
// (20261024000000_private_uploads.sql). Their row isn't this account's to
// see or place, so the app turns such a drop away. None when signed out, or
// when the server can't say.
export async function uploadsTaken(ids: string[]): Promise<Set<string>> {
  if (!supabase || !ids.length || !getSession()) return new Set();
  const { data, error } = await supabase.rpc('uploads_taken', { ids });
  if (error) console.warn('uploads_taken:', error.message);
  return new Set(error ? [] : ((data as string[] | null) ?? []));
}

// Deleting an upload gives its space back. 'in_use': `others` people have it
// in a collection, so it stays. 'missing': it never reached the server.
export type Deletion = { status: 'ok' | 'not_owner' | 'missing' } | { status: 'in_use'; others: number };

export async function deleteUploadRow(id: string): Promise<Deletion> {
  const { data, error } = await supabase!.rpc('delete_upload', { asset: id });
  if (error) throw new Error(error.message);
  const r = data as Deletion & Partial<Quota>;
  keep(r);
  return r;
}

// Deleted uploads whose files may still be in cloud storage.
export async function unpurgedUploads(): Promise<string[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('unpurged_uploads');
  if (error) throw new Error(error.message);
  return (data as string[] | null) ?? [];
}
