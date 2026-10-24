// Deleting an upload, which gives its space in the uploader's quota back.
// Signed in, the server goes first (delete_upload in
// supabase/migrations/20261023235900_delete_uploads.sql): it takes the clip
// off the uploader's collections and drops its row in one transaction, or
// refuses while someone else has it in a collection. Then this device
// forgets the clip and the media Worker deletes its files. If deleting the
// files doesn't finish, it runs again on the next open.

import type { AssetRecord } from '../data/model.ts';
import { type Deletion, deleteUploadRow, unpurgedUploads } from '../data/quota.ts';
import { drain } from '../data/sync.ts';
import { deleteFiles } from '../data/upload.ts';
import { closeDetail, useDetail } from './detail/state.ts';
import { forgetAssets, useStore } from './store.ts';

// Resolves null once it's deleted; otherwise with why it wasn't.
export async function deleteUpload(a: AssetRecord): Promise<string | null> {
  let cloud: Deletion['status'] | null = null;
  if (useStore.getState().mode === 'remote') {
    // So no edit still on its way re-creates what the server deletes.
    await drain();
    let r: Deletion;
    try {
      r = await deleteUploadRow(a.id);
    } catch (e) {
      return `Couldn't delete it: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (r.status === 'in_use') {
      const who = r.others === 1 ? 'Someone else has' : `${r.others} other people have`;
      return `${who} this clip in a collection, so it can't be deleted.${a.inFeed ? ' Turn off Show in Feed so no one else adds it.' : ''}`;
    }
    if (r.status === 'not_owner') return 'Only whoever uploaded this clip can delete it.';
    cloud = r.status;
  }
  forgetAssets([a.id]);
  if (useDetail.getState().open?.assetId === a.id) closeDetail();
  await removeLocalFiles(a.id);
  if (cloud === 'ok') void deleteFiles(a.id);
  return null;
}

// The copies ingest left in this device's private file system.
async function removeLocalFiles(id: string): Promise<void> {
  try {
    const media = await (await navigator.storage.getDirectory()).getDirectoryHandle('media');
    await media.removeEntry(id, { recursive: true });
  } catch {
    // Never on this device.
  }
}

// Deletes the cloud files of uploads deleted earlier whose files outlived
// them (a tab closed mid-delete).
export async function purgeDeleted(): Promise<void> {
  try {
    for (const id of await unpurgedUploads()) await deleteFiles(id);
  } catch (e) {
    console.warn('deleted uploads:', e);
  }
}
