// One-off: publish the library's asset rows (with source and analysis) as
// content-addressed JSON parts through the media Worker, for Postgres to load.
// Args: sites to include (bare or www. hosts); none means every scraped asset.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
process.chdir(new URL('../..', import.meta.url).pathname);
process.loadEnvFile('.env.local');
const base = process.env.VITE_MEDIA_URL.replace(/\/$/, '');
const lib = JSON.parse(fs.readFileSync('public/media/library.json', 'utf8'));
const sites = process.argv.slice(2);
const bare = (s) => s.replace(/^www\./, '');
const rows = lib.assets.filter((a) => a.source && (!sites.length || sites.includes(bare(a.source.site)))).map((a) => {
  const r = {};
  if (a.l0) r.l0 = { key: a.l0.url, format: a.l0.format, frameWidth: a.l0.frameWidth, frameHeight: a.l0.frameHeight, frameCount: a.l0.frameCount, bytes: a.l0.bytes };
  r.l1 = { key: a.l1.url, width: a.l1.width, height: a.l1.height, bytes: a.l1.bytes };
  if (a.l2) r.l2 = { key: a.l2.url, width: a.l2.width, height: a.l2.height, bytes: a.l2.bytes };
  return { id: a.id, name: a.name, duration: a.duration, width: a.width, height: a.height, fps: a.fps, renditions: r, source_url: a.source.pageUrl, source_title: a.source.pageTitle ?? a.source.title, source: a.source, analysis: a.analysis ?? null };
});
const untagged = rows.filter((r) => !r.analysis).length;
const urls = [];
for (let i = 0; i < rows.length; i += 1500) {
  const body = JSON.stringify(rows.slice(i, i + 1500));
  const key = `media/${createHash('sha256').update(body).digest('hex').slice(0, 16)}/original.json`;
  const res = await fetch(`${base}/${key}`, { method: 'PUT', body, headers: { Authorization: `Bearer ${process.env.MEDIA_ADMIN_TOKEN}`, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`PUT ${res.status} ${await res.text()}`);
  urls.push(`${base}/${key}`);
  console.error(`part ${urls.length}: ${Math.min(1500, rows.length - i)} rows, ${(body.length / 1e6).toFixed(1)} MB`);
}
console.log(JSON.stringify({ rows: rows.length, untagged, urls }));
