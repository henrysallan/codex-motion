// The clip details view: which asset is open (and the Feed order it was
// opened from, so arrows step through it), and whether the info panel
// shows. Kept apart from the app store; the panel preference persists on
// its own.

import { create } from 'zustand';

const KEY = 'trace.details';

interface DetailState {
  // The Feed's details view; null when closed.
  open: { assetId: string; ids: string[] } | null;
  // The info panel beside the details player and canvas focus mode.
  infoPanel: boolean;
}

function loadInfoPanel(): boolean {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? '{}') as { infoPanel?: boolean }).infoPanel ?? true;
  } catch {
    return true;
  }
}

export const useDetail = create<DetailState>(() => ({ open: null, infoPanel: loadInfoPanel() }));

export function openDetail(assetId: string, ids: string[]): void {
  useDetail.setState({ open: { assetId, ids } });
}

export function closeDetail(): void {
  useDetail.setState({ open: null });
}

// Moves to the previous or next clip in the order the view was opened from.
export function stepDetail(delta: number): void {
  const open = useDetail.getState().open;
  if (!open || open.ids.length === 0) return;
  const i = open.ids.indexOf(open.assetId);
  const n = open.ids.length;
  useDetail.setState({ open: { ...open, assetId: open.ids[(((i + delta) % n) + n) % n] } });
}

// Docked in a canvas, the panel is min(INFO_MAX px, INFO_SHARE of the
// pane) wide, 8 px from the edge; focus mode frames the clip in what's left.
export const INFO_MAX = 300;
export const INFO_SHARE = 0.45;

export function infoPanelInset(paneW: number): number {
  return useDetail.getState().infoPanel ? Math.min(INFO_MAX, paneW * INFO_SHARE) + 16 : 0;
}

export function setInfoPanel(infoPanel: boolean): void {
  useDetail.setState({ infoPanel });
  try {
    localStorage.setItem(KEY, JSON.stringify({ infoPanel }));
  } catch {
    // Storage full or blocked: the choice just doesn't persist.
  }
}
