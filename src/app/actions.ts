// Actions that cross panes.

import type { Point } from '../data/model.ts';
import { emit } from './events.ts';
import { plural } from './format.ts';
import { addToCollection, openCollection, useStore } from './store.ts';
import { toast } from './toasts.tsx';

// Adds clips to a collection and tells its canvas to animate them in from
// the drop point (or the collection's last drop point), into the frame
// they were dropped on, if any.
export function addAssets(collectionId: string, assetIds: string[], at?: Point, frameId?: string | null): void {
  const s = useStore.getState();
  const from = at ?? s.collections[collectionId]?.lastDrop ?? null;
  const added = addToCollection(collectionId, assetIds, at, frameId);
  if (added.length === 0) return;
  emit('added', { collectionId, ids: added.map((p) => p.id), from });
  if (s.activeTab !== collectionId) {
    const name = s.collections[collectionId]?.name ?? 'collection';
    toast(`Added ${plural(added.length, 'clip')} to ${name}`, { label: 'Open', run: () => openCollection(collectionId) });
  }
}
