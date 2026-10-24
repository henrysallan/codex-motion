// Dev tools: extras for admins, switched on in Settings (SettingsDialog.tsx).
// For now: deleting clips from the library, for everyone, from the Feed's
// right-click menu. The switch is per browser; whether the account is an
// admin is asked again whenever the signed-in account changes.

import { create } from 'zustand';
import { fetchIsAdmin, REMOVE_BATCH, removeAssetRows } from '../data/admin.ts';
import { getSession, onAuthChange } from '../data/supabase.ts';
import { drain } from '../data/sync.ts';
import { deleteFiles } from '../data/upload.ts';
import { closeDetail, useDetail } from './detail/state.ts';
import { forgetAssets, useStore } from './store.ts';

const KEY = 'trace.devtools';

function saved(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export const useDevTools = create<{ admin: boolean; enabled: boolean }>(() => ({ admin: false, enabled: saved() }));

// On only for an admin who switched them on.
export const useDevToolsOn = () => useDevTools((s) => s.admin && s.enabled);

export function setDevTools(on: boolean): void {
  useDevTools.setState({ enabled: on });
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // Blocked storage: on until reload.
  }
}

let account: string | null = null;

function checkAdmin(userId: string | null): void {
  if (userId === account) return;
  account = userId;
  useDevTools.setState({ admin: false });
  if (userId) void fetchIsAdmin().then((admin) => account === userId && useDevTools.setState({ admin }));
}

onAuthChange((session) => checkAdmin(session?.user.id ?? null));
checkAdmin(getSession()?.user.id ?? null);

// Deletes clips from the library for everyone: their rows and every
// placement of them, then their files. Files that don't get deleted now are
// retried on the next open (purgeDeleted in deleteUpload.ts). Ids that
// never reached the server are left alone. `boards` can count a board
// twice when the clips span more than one batch.
export async function removeFromLibrary(ids: string[]): Promise<{ removed: number; boards: number }> {
  if (useStore.getState().mode !== 'remote') throw new Error('Sign in to delete clips from the library.');
  // So no edit still on its way puts a placement back.
  await drain();
  const removed: string[] = [];
  let boards = 0;
  try {
    for (let i = 0; i < ids.length; i += REMOVE_BATCH) {
      const r = await removeAssetRows(ids.slice(i, i + REMOVE_BATCH));
      removed.push(...r.removed);
      boards += r.boards;
    }
  } finally {
    // Whatever went before a failed batch is gone either way.
    if (removed.length) {
      forgetAssets(removed);
      const open = useDetail.getState().open?.assetId;
      if (open && removed.includes(open)) closeDetail();
      void purgeFiles(removed);
    }
  }
  return { removed: removed.length, boards };
}

async function purgeFiles(ids: string[]): Promise<void> {
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) await deleteFiles(id);
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}
