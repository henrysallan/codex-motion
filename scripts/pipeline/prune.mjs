// Verify every local proxy against R2 (same size), then with --delete remove
// verified proxies and the originals of fully verified assets. Metadata stays.
import fs from 'node:fs';
import path from 'node:path';
process.chdir(new URL('../..', import.meta.url).pathname);
process.loadEnvFile('.env.local');
const base = process.env.VITE_MEDIA_URL.replace(/\/$/, '');
const del = process.argv.includes('--delete');
const lib = JSON.parse(fs.readFileSync('public/media/library.json', 'utf8'));
const jobs = lib.assets.flatMap((a) => [a.l0?.url, a.l1.url, a.l2?.url].filter(Boolean).map((u) => ({ id: a.id, u })));
const bad = new Set();
let verified = 0, absent = 0, bytes = 0, i = 0;
async function worker() {
  while (i < jobs.length) {
    const { id, u } = jobs[i++];
    const local = path.join('public', u);
    if (!fs.existsSync(local)) { absent++; continue; }
    const size = fs.statSync(local).size;
    let ok = false;
    for (let t = 0; t < 4 && !ok; t++) {
      try { const r = await fetch(`${base}/${u}`, { method: 'HEAD' }); ok = r.ok && Number(r.headers.get('content-length')) === size; if (r.status === 404) break; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (ok) { verified++; bytes += size; } else bad.add(id);
  }
}
await Promise.all(Array.from({ length: 32 }, worker));
console.log(`proxies: ${verified} verified in R2 (${(bytes / 1e9).toFixed(1)} GB), ${absent} already gone, ${bad.size} assets with a mismatch`);
const good = lib.assets.filter((a) => !bad.has(a.id));
// Originals: <id>.<ext> in media/scraped/<site>/, for assets in the library.
const ids = new Set(good.map((a) => a.id));
const originals = [];
let unknown = 0;
for (const site of fs.readdirSync('media/scraped')) {
  const dir = path.join('media/scraped', site);
  if (!fs.statSync(dir).isDirectory()) continue;
  for (const f of fs.readdirSync(dir)) {
    const m = /^([0-9a-f]{16})\.(mp4|mkv|webm|mov|m4v|ogv)$/.exec(f);
    if (!m) continue;
    if (ids.has(m[1])) originals.push(path.join(dir, f)); else unknown++;
  }
}
const oBytes = originals.reduce((s, f) => s + fs.statSync(f).size, 0);
console.log(`originals: ${originals.length} of library assets (${(oBytes / 1e9).toFixed(1)} GB), ${unknown} not in the library (kept)`);
if (bad.size) console.log('mismatched:', [...bad].slice(0, 10).join(' '));
if (!del) process.exit(0);
let n = 0;
for (const a of good) for (const u of [a.l0?.url, a.l1.url, a.l2?.url].filter(Boolean)) { const f = path.join('public', u); if (fs.existsSync(f)) { fs.rmSync(f); n++; } }
for (const f of originals) fs.rmSync(f);
console.log(`deleted ${n} proxy files and ${originals.length} originals`);
