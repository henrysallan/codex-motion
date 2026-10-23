// Uploads the sample library's proxies (public/media) to cloud storage
// through the media Worker, and writes the SQL that registers them as
// library assets. Skips files already uploaded, so it's safe to re-run.
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
const files = library.assets.flatMap((a) => [a.l0?.url, a.l1.url, a.l2?.url].filter((u): u is string => !!u));
const totalBytes = files.reduce((s, f) => s + fs.statSync(path.join(publicDir, f)).size, 0);
console.log(`${library.assets.length} assets, ${files.length} files, ${(totalBytes / 1e6).toFixed(0)} MB → ${base}`);

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

await pool(files, 6, async (key) => {
  const url = `${base}/${key}`;
  const head = await retry(key, () => fetch(url, { method: 'HEAD' }));
  if (head.ok) skipped++;
  else {
    const file = path.join(publicDir, key);
    await retry(key, async () => {
      const res = await fetch(url, { method: 'PUT', body: await fs.openAsBlob(file), headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    });
    sent += fs.statSync(file).size;
  }
  done++;
  if (done % 25 === 0 || done === files.length) {
    const s = (performance.now() - t0) / 1000;
    console.log(`  ${done}/${files.length}  ${(sent / 1e6).toFixed(0)} MB sent, ${skipped} already there, ${(sent / 1e6 / s).toFixed(1)} MB/s`);
  }
});

// SQL for the asset rows, keyed to the same storage paths.
const sqlOut = arg('sql', '');
if (sqlOut) {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const renditions = (a: Asset) => {
    const r: Record<string, unknown> = {};
    if (a.l0) r.l0 = { key: a.l0.url, format: a.l0.format, frameWidth: a.l0.frameWidth, frameHeight: a.l0.frameHeight, frameCount: a.l0.frameCount, bytes: a.l0.bytes };
    r.l1 = { key: a.l1.url, width: a.l1.width, height: a.l1.height, bytes: a.l1.bytes };
    if (a.l2) r.l2 = { key: a.l2.url, width: a.l2.width, height: a.l2.height, bytes: a.l2.bytes };
    return r;
  };
  const rows = library.assets.map(
    (a) => `(${q(a.id)}, ${q(a.name)}, 'library', 'ready', ${a.duration}, ${a.width}, ${a.height}, ${a.fps}, ${q(JSON.stringify(renditions(a)))}::jsonb, null)`,
  );
  const sql =
    `insert into public.assets (id, name, origin, status, duration, width, height, fps, renditions, added_by) values\n` +
    rows.join(',\n') +
    `\non conflict (id) do update set renditions = excluded.renditions, status = excluded.status;\n`;
  fs.writeFileSync(sqlOut, sql);
  console.log(`wrote ${sqlOut}`);
}
