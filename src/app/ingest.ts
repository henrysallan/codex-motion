// Main-thread side of ingest. A dropped file is probed and hashed in the
// ingest worker, then placed at once, playing straight from the file while
// its proxies are built; the asset switches to the proxies when they land.
// A file whose hash is already in the library is just placed.

import type { AssetRecord } from '../data/model.ts';
import type { FromIngest, ProbeResult, ToIngest } from '../ingest/protocol.ts';
import { addAssets } from './actions.ts';
import { plural } from './format.ts';
import { upsertAsset, useStore } from './store.ts';
import { toast } from './toasts.tsx';

const ACCEPT = /^(video|image)\//;

let worker: Worker | null = null;
let nextJob = 1;
const waiting = new Map<number, (msg: FromIngest) => void>();
const active = new Map<number, { id: string; blobUrl: string | null; name: string }>();

function ingestWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../ingest/ingest.worker.ts', import.meta.url), { type: 'module', name: 'ingest' });
  worker.onmessage = (e: MessageEvent<FromIngest>) => {
    const msg = e.data;
    const once = waiting.get(msg.jobId);
    if (once && (msg.type === 'identified' || msg.type === 'error')) {
      waiting.delete(msg.jobId);
      once(msg);
      return;
    }
    onProgress(msg);
  };
  return worker;
}

const send = (msg: ToIngest) => ingestWorker().postMessage(msg);

function onProgress(msg: FromIngest): void {
  const job = active.get(msg.jobId);
  if (!job) return;
  const a = useStore.getState().assets[job.id];
  if (!a) return;
  if (msg.type === 'original') upsertAsset({ ...a, original: { url: msg.url, width: a.width, height: a.height, bytes: 0 } });
  else if (msg.type === 'progress') {
    // Throttle store writes to visible steps.
    if (Math.abs((a.progress ?? 0) - msg.progress) > 0.05) upsertAsset({ ...a, progress: msg.progress });
  } else if (msg.type === 'done') {
    upsertAsset({ ...a, status: 'ready', progress: 1, duration: msg.duration, l0: msg.l0, l1: msg.l1, l2: msg.l2 });
    finish(msg.jobId);
  } else if (msg.type === 'error') {
    upsertAsset({ ...a, status: 'error', error: msg.message });
    toast(`Couldn't process ${job.name}: ${msg.message}`);
    finish(msg.jobId);
  }
}

function finish(jobId: number): void {
  const job = active.get(jobId);
  active.delete(jobId);
  // Give tiles a moment to crossfade off the original before revoking it.
  if (job?.blobUrl) setTimeout(() => URL.revokeObjectURL(job.blobUrl!), 15_000);
}

function identify(file: File): Promise<{ jobId: number; id: string; meta: ProbeResult }> {
  const jobId = nextJob++;
  return new Promise((resolve, reject) => {
    waiting.set(jobId, (msg) => {
      if (msg.type === 'identified') resolve({ jobId, id: msg.id, meta: msg.meta });
      else if (msg.type === 'error') reject(new Error(msg.message));
    });
    send({ type: 'probe', jobId, file });
  });
}

// Adds files to a collection at a canvas point.
export async function ingestFiles(files: File[], collectionId: string, at: { x: number; y: number }): Promise<void> {
  const accepted = files.filter((f) => ACCEPT.test(f.type));
  const skipped = files.length - accepted.length;
  if (skipped) toast(`Skipped ${plural(skipped, 'file')} that isn't a video or image`);
  const ids: string[] = [];
  const results = await Promise.allSettled(accepted.map((f) => identify(f)));
  results.forEach((r, i) => {
    const file = accepted[i];
    if (r.status === 'rejected') {
      toast(`Couldn't read ${file.name}`);
      return;
    }
    const { jobId, id, meta } = r.value;
    ids.push(id);
    const existing = useStore.getState().assets[id];
    if (existing && existing.status !== 'error') {
      send({ type: 'cancel', jobId });
      return;
    }
    // Videos play from the file itself until proxies exist; images wait
    // for their sprite, which comes back within a moment.
    const blobUrl = meta.kind === 'video' ? URL.createObjectURL(file) : null;
    const record: AssetRecord = {
      id,
      name: file.name.replace(/\.\w+$/, ''),
      duration: meta.duration,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      l0: null,
      l1: { url: blobUrl ?? '', width: meta.width, height: meta.height, bytes: file.size },
      l2: null,
      original: null,
      origin: 'upload',
      status: 'processing',
      progress: 0,
      addedBy: useStore.getState().user.id,
      addedAt: Date.now(),
      sourceTitle: file.name,
    };
    upsertAsset(record);
    active.set(jobId, { id, blobUrl, name: file.name });
    send({ type: 'build', jobId, id });
  });
  if (ids.length) addAssets(collectionId, [...new Set(ids)], at);
}

// Picks up ingests a closed tab left unfinished, from originals in OPFS.
export function resumeIngests(): void {
  for (const a of Object.values(useStore.getState().assets)) {
    if (a.origin !== 'upload' || a.status !== 'processing') continue;
    if (!a.original) {
      upsertAsset({ ...a, status: 'error', error: 'The upload was interrupted before the file was saved.' });
      continue;
    }
    const jobId = nextJob++;
    active.set(jobId, { id: a.id, blobUrl: null, name: a.name });
    const path = a.original.url.replace(/^opfs:/, '');
    const ext = path.split('.').pop() ?? '';
    const image = /^(gif|png|jpe?g|webp|avif)$/.test(ext);
    const mime = image ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : `video/${ext === 'mov' ? 'quicktime' : ext}`;
    // The blob URL died with the old tab; play the saved original meanwhile.
    if (!image) upsertAsset({ ...a, l1: { ...a.l1, url: a.original.url } });
    send({ type: 'resume', jobId, id: a.id, path, name: `${a.name}.${ext}`, mime });
  }
}
