// The clip details view: which asset is open (and the Feed order it was
// opened from, so arrows step through it), whether the info panel shows,
// and which of its tabs. Kept apart from the app store; the panel
// preferences persist on their own.

import { create } from 'zustand';

const KEY = 'trace.details';

interface DetailState {
  // The Feed's details view; null when closed.
  open: { assetId: string; ids: string[] } | null;
  // The info panel beside the details player and canvas focus mode.
  infoPanel: boolean;
  // The panel's tab: what's known about the clip, or comments on it.
  infoTab: InfoTab;
}

export type InfoTab = 'info' | 'comments';

type Prefs = Pick<DetailState, 'infoPanel' | 'infoTab'>;

function loadPrefs(): Prefs {
  let saved: Partial<Prefs> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
  } catch {
    // Unreadable: defaults.
  }
  return { infoPanel: saved.infoPanel ?? true, infoTab: saved.infoTab === 'comments' ? 'comments' : 'info' };
}

function savePrefs(): void {
  const { infoPanel, infoTab } = useDetail.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify({ infoPanel, infoTab }));
  } catch {
    // Storage full or blocked: the choice just doesn't persist.
  }
}

export const useDetail = create<DetailState>(() => ({ open: null, ...loadPrefs() }));

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
  savePrefs();
}

export function setInfoTab(infoTab: InfoTab): void {
  useDetail.setState({ infoTab });
  savePrefs();
}
