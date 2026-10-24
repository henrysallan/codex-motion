// Admin-only calls (supabase/migrations/20261024030000_remove_assets.sql).
// Admins are the accounts in private.admins. The server checks on every
// call; the app only uses this to decide what to offer.

import { supabase } from './supabase.ts';

// False when signed out, local-only, or the server can't say.
export async function fetchIsAdmin(): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('is_admin');
  if (error) console.warn('is_admin:', error.message);
  return !error && data === true;
}

// What remove_assets() did: the ids whose rows it deleted (others weren't
// on the server), and how many boards, anyone's, they came off.
export interface Removal {
  removed: string[];
  boards: number;
}

// The server takes at most this many ids a call.
export const REMOVE_BATCH = 1000;

export async function removeAssetRows(ids: string[]): Promise<Removal> {
  const { data, error } = await supabase!.rpc('remove_assets', { ids });
  if (error) throw new Error(error.message);
  return data as Removal;
}
