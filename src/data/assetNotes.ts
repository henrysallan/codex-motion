// Notes on a clip, one per person: Supabase's asset_notes when signed in
// (row-level security keeps each person's to themselves), localStorage in
// local mode. Read when a clip's details open and written straight through,
// like clip comments; there's no cache or outbox.

import { remoteEnabled } from '../config.ts';
import { supabase } from './supabase.ts';

// What a link in a note looks like, from api/unfurl.ts. The images are
// small data: URIs the app made from the page's own.
export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  site: string;
  image?: string;
  icon?: string;
}

export interface AssetNote {
  assetId: string;
  body: string;
  // Previews by the link as written in the body.
  links: Record<string, LinkPreview>;
  updatedAt: number;
}

const localKey = (assetId: string) => `trace.note.${assetId}`;

export async function fetchAssetNote(userId: string, assetId: string): Promise<AssetNote | null> {
  if (!remoteEnabled) {
    try {
      const saved = localStorage.getItem(localKey(assetId));
      return saved ? (JSON.parse(saved) as AssetNote) : null;
    } catch {
      return null;
    }
  }
  const { data, error } = await supabase!
    .from('asset_notes')
    .select('asset_id, body, links, updated_at')
    .eq('user_id', userId)
    .eq('asset_id', assetId)
    .maybeSingle();
  if (error) throw new Error(`notes: ${error.message}`);
  if (!data) return null;
  return {
    assetId: data.asset_id as string,
    body: data.body as string,
    links: (data.links as Record<string, LinkPreview> | null) ?? {},
    updatedAt: Date.parse(data.updated_at as string) || Date.now(),
  };
}

// Saves a note, or deletes it when its body is empty.
export async function saveAssetNote(userId: string, note: AssetNote): Promise<void> {
  const empty = !note.body.trim();
  if (!remoteEnabled) {
    try {
      if (empty) localStorage.removeItem(localKey(note.assetId));
      else localStorage.setItem(localKey(note.assetId), JSON.stringify(note));
    } catch {
      throw new Error('this browser’s storage is full or blocked');
    }
    return;
  }
  const { error } = empty
    ? await supabase!.from('asset_notes').delete().eq('user_id', userId).eq('asset_id', note.assetId)
    : await supabase!
        .from('asset_notes')
        .upsert({ user_id: userId, asset_id: note.assetId, body: note.body, links: note.links, updated_at: new Date(note.updatedAt).toISOString() });
  if (error) throw new Error(error.message);
}
