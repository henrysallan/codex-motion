// Uploads the sample library's proxies (public/media) to cloud storage
// through the media Worker, and writes the SQL that registers them as
// library assets. With SUPABASE_SERVICE_ROLE_KEY it registers them itself,
// with each asset's source and analysis records. Skips files already
// uploaded, so it's safe to re-run.
//
//   node --env-file=.env.local scripts/upload-library.ts [--sql out.sql]
//
// Needs VITE_MEDIA_URL and MEDIA_ADMIN_TOKEN (the Worker's admin secret).

import fs from 'node:fs';
import path from 'node:path';
import type { Asset, Library } from '../src/media/library.ts';
import { arg, pool } from './lib/ffmpeg.ts';

const base = process.env.VITE_MEDIA_URL?.replace(/\/$/, '');
const token = process.env.MEDIA_ADMIN_TOKEN;
if (!base || !token) {
  console.error('Set VITE_MEDIA_URL and MEDIA_ADMIN_TOKEN (see .env.example).');
  process.exit(1);
}

const publicDir = path.resolve('public');
const library = JSON.parse(fs.readFileSync(path.join(publicDir, 'media/library.json'), 'utf8')) as Library;
// Local copies of uploaded proxies may have been deleted to save space;
// those are checked against R2 rather than sent.
const all = library.assets.flatMap((a) => [a.l0?.url, a.l1.url, a.l2?.url].filter((u): u is string => !!u));
const files = all.filter((f) => fs.existsSync(path.join(publicDir, f)));
const totalBytes = files.reduce((s, f) => s + fs.statSync(path.join(publicDir, f)).size, 0);
console.log(`${library.assets.length} assets, ${files.length} files on disk, ${(totalBytes / 1e6).toFixed(0)} MB → ${base}`);

let done = 0;
let sent = 0;
let skipped = 0;
const t0 = performance.now();
// Retries network errors and server errors with backoff.
async function retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 5) throw new Error(`${what}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

// One request carries up to the Worker's 95 MB; bigger proxies (long films)
// go up in parts through its multipart API.
const SINGLE_MAX = 90e6;
const PART = 50e6;
const auth = { Authorization: `Bearer ${token}` };

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  return res;
}

async function uploadMultipart(url: string, file: string): Promise<void> {
  const { uploadId, exists } = (await (await ok(await fetch(`${url}?uploads`, { method: 'POST', headers: auth }))).json()) as { uploadId?: string; exists?: boolean };
  if (exists || !uploadId) return;
  const blob = await fs.openAsBlob(file);
  const parts: unknown[] = [];
  try {
    for (let n = 1, at = 0; at < blob.size; n++, at += PART) {
      const body = blob.slice(at, Math.min(blob.size, at + PART));
      const q = `uploadId=${encodeURIComponent(uploadId)}&partNumber=${n}`;
      parts.push(await retry(`${file} part ${n}`, async () => (await ok(await fetch(`${url}?${q}`, { method: 'PUT', body, headers: auth }))).json()));
    }
    await ok(await fetch(`${url}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'POST', body: JSON.stringify({ parts }), headers: { ...auth, 'Content-Type': 'application/json' } }));
  } catch (e) {
    await fetch(`${url}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'DELETE', headers: auth }).catch(() => {});
    throw e;
  }
}

// What isn't on disk must be in R2 already, or its asset would point at nothing.
const remoteOnly = all.filter((f) => !files.includes(f));
let missing = 0;
await pool(remoteOnly, 16, async (key) => {
  const head = await retry(key, () => fetch(`${base}/${key}`, { method: 'HEAD' }));
  if (!head.ok) {
    missing++;
    console.error(`missing locally and in R2: ${key}`);
  }
});
if (missing) process.exit(1);
if (remoteOnly.length) console.log(`  ${remoteOnly.length} files only in R2, all present`);

await pool(files, 6, async (key) => {
  const url = `${base}/${key}`;
  const head = await retry(key, () => fetch(url, { method: 'HEAD' }));
  if (head.ok) skipped++;
  else {
    const file = path.join(publicDir, key);
    const size = fs.statSync(file).size;
    if (size > SINGLE_MAX) await retry(key, () => uploadMultipart(url, file));
    else await retry(key, async () => void (await ok(await fetch(url, { method: 'PUT', body: await fs.openAsBlob(file), headers: auth }))));
    sent += size;
  }
  done++;
  if (done % 25 === 0 || done === files.length) {
    const s = (performance.now() - t0) / 1000;
    console.log(`  ${done}/${files.length}  ${(sent / 1e6).toFixed(0)} MB sent, ${skipped} already there, ${(sent / 1e6 / s).toFixed(1)} MB/s`);
  }
});

const renditions = (a: Asset) => {
  const r: Record<string, unknown> = {};
  if (a.l0) r.l0 = { key: a.l0.url, format: a.l0.format, frameWidth: a.l0.frameWidth, frameHeight: a.l0.frameHeight, frameCount: a.l0.frameCount, bytes: a.l0.bytes };
  r.l1 = { key: a.l1.url, width: a.l1.width, height: a.l1.height, bytes: a.l1.bytes };
  if (a.l2) r.l2 = { key: a.l2.url, width: a.l2.width, height: a.l2.height, bytes: a.l2.bytes };
  return r;
};

// SQL for the asset rows, keyed to the same storage paths. It leaves out
// source and analysis (about 1.4 KB a row); those go in through the API.
const sqlOut = arg('sql', '');
if (sqlOut) {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const rows = library.assets.map(
    (a) =>
      `(${q(a.id)}, ${q(a.name)}, ${a.source ? "'scraper'" : "'library'"}, 'ready', ${a.duration}, ${a.width}, ${a.height}, ${a.fps}, ${q(JSON.stringify(renditions(a)))}::jsonb, ` +
      `${a.source ? q(a.source.pageUrl) : 'null'}, ${a.source ? q(a.source.pageTitle ?? a.source.title) : 'null'}, null)`,
  );
  const sql =
    `insert into public.assets (id, name, origin, status, duration, width, height, fps, renditions, source_url, source_title, added_by) values\n` +
    rows.join(',\n') +
    `\non conflict (id) do update set renditions = excluded.renditions, status = excluded.status, source_url = excluded.source_url, source_title = excluded.source_title;\n`;
  fs.writeFileSync(sqlOut, sql);
  console.log(`wrote ${sqlOut}`);
}

// With the service role key the rows go straight in, source and analysis
// included. Library rows belong to no user, so nothing else can write them.
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseUrl = process.env.VITE_SUPABASE_URL?.replace(/\/$/, '');
if (serviceKey && supabaseUrl) {
  const rows = library.assets.map((a) => ({
    id: a.id,
    name: a.name,
    origin: a.source ? 'scraper' : 'library',
    status: 'ready',
    duration: a.duration,
    width: a.width,
    height: a.height,
    fps: a.fps,
    renditions: renditions(a),
    source_url: a.source?.pageUrl ?? null,
    source_title: a.source ? (a.source.pageTitle ?? a.source.title) : null,
    source: a.source ?? null,
    analysis: a.analysis ?? null,
  }));
  const headers: Record<string, string> = {
    apikey: serviceKey,
    'Content-Type': 'application/json',
    Prefer: 'resolution=merge-duplicates,return=minimal',
  };
  // A legacy service_role JWT also goes in Authorization; sb_secret_ keys don't.
  if (serviceKey.startsWith('eyJ')) headers.Authorization = `Bearer ${serviceKey}`;
  for (let i = 0; i < rows.length; i += 250) {
    const batch = JSON.stringify(rows.slice(i, i + 250));
    await retry('assets', async () => void (await ok(await fetch(`${supabaseUrl}/rest/v1/assets?on_conflict=id`, { method: 'POST', headers, body: batch }))));
  }
  console.log(`registered ${rows.length} assets, with source and analysis, in ${supabaseUrl}`);
} else {
  console.log('Set SUPABASE_SERVICE_ROLE_KEY to register the rows directly, with project metadata and tags.');
}
