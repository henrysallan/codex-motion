// Enriching an upload from its details panel: build a contact sheet of the
// clip here, send it with the source link to /api/enrich (which reads the
// page and tags the frames with Haiku), and keep what comes back on the
// asset. Also the uploader's "Show in Feed" switch.
//
// The sheet matches the library tagger's (scripts/lib/frames.ts): 16 frames
// from the L1 proxy at evenly spaced times, in a 4 x 4 grid with mid-grey
// gutters, about 1.3 MP. A still is one frame.

import { create } from 'zustand';
import { config } from '../config.ts';
import { mediaUrl } from '../data/media.ts';
import type { AssetRecord } from '../data/model.ts';
import { fetchAssetMeta } from '../data/remote.ts';
import { accessToken, getSession } from '../data/supabase.ts';
import { flush } from '../data/sync.ts';
import { loadBytes } from '../engine/storage.ts';
import type { AssetAnalysis, AssetSource } from '../media/library.ts';
import { upsertAsset, useStore } from './store.ts';

export type EnrichStep = 'frames' | 'page' | 'done' | 'error';

export interface EnrichState {
  step: EnrichStep;
  // An error, or a page that couldn't be read while the frames were tagged.
  message?: string;
  // Dollars, when known.
  cost?: number | null;
}

// Per asset id, while working and after.
export const useEnrich = create<Record<string, EnrichState>>(() => ({}));

const report = (id: string, s: EnrichState) => useEnrich.setState({ [id]: s });

const GUTTER = 8;
const PIXELS = 1_300_000;
const even = (v: number) => Math.max(16, Math.round(v / 2) * 2);

export const isStill = (a: AssetRecord) => a.fps <= 1 && a.duration <= 1;

// The sheet as base64 JPEG data (no data: prefix).
export async function contactSheet(a: AssetRecord): Promise<string> {
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } = await import('mediabunny');
  const bytes = await loadBytes(mediaUrl(a.l1.url));
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(new Blob([bytes])) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('the proxy has no video track');
    const cols = isStill(a) ? 1 : 4;
    const n = cols * cols;
    const aspect = a.width / a.height || 16 / 9;
    // Never larger than the proxy itself.
    const tileW = Math.min(even(Math.sqrt((PIXELS / n) * aspect)), even(a.l1.width || track.displayWidth));
    const tileH = even(tileW / aspect);
    const sheet = new OffscreenCanvas(cols * tileW + (cols + 1) * GUTTER, cols * tileH + (cols + 1) * GUTTER);
    const ctx = sheet.getContext('2d')!;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, sheet.width, sheet.height);

    const start = await track.getFirstTimestamp();
    const span = Math.max(0.1, a.duration);
    const times = Array.from({ length: n }, (_, i) => start + ((i + 0.5) * span) / n);
    const sink = new CanvasSink(track, { width: tileW, height: tileH, fit: 'fill' });
    let i = 0;
    for await (const frame of sink.canvasesAtTimestamps(times)) {
      if (frame) ctx.drawImage(frame.canvas, GUTTER + (i % cols) * (tileW + GUTTER), GUTTER + Math.floor(i / cols) * (tileH + GUTTER));
      i++;
    }
    const blob = await sheet.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return url.slice(url.indexOf(',') + 1);
  } finally {
    input.dispose();
  }
}

interface EnrichAnswer {
  source: AssetSource | null;
  analysis: AssetAnalysis | null;
  sourceUrl: string | null;
  cost: number | null;
  warning?: string;
  error?: string;
}

// Reads `url` (if any) and tags the clip's frames, then keeps the results on
// the asset. `known` is what the details panel already shows, kept where
// this run adds nothing new. A clip the extension saved sends its capture,
// which the server reads in place of fetching `url`.
export async function enrichUpload(a: AssetRecord, url: string, known: Pick<AssetRecord, 'source' | 'analysis'>): Promise<void> {
  if (useEnrich.getState()[a.id]?.step === 'frames' || useEnrich.getState()[a.id]?.step === 'page') return;
  try {
    report(a.id, { step: 'frames' });
    const sheet = await contactSheet(a);
    report(a.id, { step: 'page' });
    const token = await accessToken();
    if (!token) throw new Error('Sign in to enrich clips');
    // Only while the link is still the one the extension saw.
    const capture = a.capture && (!url.trim() || url.trim() === a.capture.url) ? a.capture : undefined;
    const res = await fetch(config.enrichUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ assetId: a.id, url: url.trim() || undefined, sheet, capture }),
    });
    const answer = (await res.json().catch(() => ({}))) as Partial<EnrichAnswer>;
    if (!res.ok) throw new Error(answer.error ?? `HTTP ${res.status}`);
    // The asset may have changed meanwhile (an upload finishing).
    const now = useStore.getState().assets[a.id] ?? a;
    const source = answer.source ?? now.source ?? known.source;
    upsertAsset({
      ...now,
      ...(answer.sourceUrl ? { sourceUrl: answer.sourceUrl } : {}),
      ...(answer.source?.pageTitle ? { sourceTitle: answer.source.pageTitle } : {}),
      ...(source ? { source } : {}),
      ...((answer.analysis ?? now.analysis ?? known.analysis) ? { analysis: (answer.analysis ?? now.analysis ?? known.analysis)! } : {}),
    });
    report(a.id, { step: 'done', cost: answer.cost ?? null, ...(answer.warning ? { message: answer.warning } : {}) });
  } catch (e) {
    report(a.id, { step: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

// A clip the extension saved enriches itself once its proxies are built,
// when someone's signed in: its capture says where it came from, so there's
// nothing to ask. Signed out, it keeps the source its capture gave it.
export async function enrichCaptured(id: string): Promise<void> {
  const a = useStore.getState().assets[id];
  if (!a?.capture || useStore.getState().mode !== 'remote' || !getSession()) return;
  // The server reads the clip's row, so that has to be there first.
  await flush();
  const now = useStore.getState().assets[id] ?? a;
  await enrichUpload(now, a.capture.url, { source: now.source, analysis: now.analysis });
}

// Shares an upload to everyone's Feed, or takes it back out. Search builds
// a shared upload's doc from its source and analysis, which the store may
// not hold yet (startup leaves them out for unshared clips).
export async function setInFeed(a: AssetRecord, on: boolean): Promise<void> {
  const now = useStore.getState().assets[a.id] ?? a;
  upsertAsset({ ...now, inFeed: on });
  if (!on || useStore.getState().mode !== 'remote' || now.source || now.analysis) return;
  const meta = await fetchAssetMeta(a.id).catch(() => null);
  const latest = useStore.getState().assets[a.id];
  if (latest && (meta?.source || meta?.analysis)) upsertAsset({ ...latest, ...(meta.source ? { source: meta.source } : {}), ...(meta.analysis ? { analysis: meta.analysis } : {}) });
}
