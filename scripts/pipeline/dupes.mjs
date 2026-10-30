// Finds a site's clips that are one video served twice (a CMS file and its
// streaming copy, say): durations within a quarter second, the same shape,
// all 8 SigLIP frame vectors alike, and the frames' pixels nearly equal
// (SigLIP alone takes a dark and a light cut of one animation for copies).
// The larger copy stays, then the one on the more specific page. Run after
// embed.ts, before registering; pruned proxies are read from R2.
// With --apply the others leave the library, their scrape items become
// "duplicate of <id>" (so a re-scrape skips them), their local files go,
// and their R2 keys are listed in media/r2-orphans.txt.
//
//   node scripts/pipeline/dupes.mjs <host> [--apply] [--min 0.9] [--max-diff 12]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
process.chdir(new URL('../..', import.meta.url).pathname);
process.loadEnvFile('.env.local');
const base = process.env.VITE_MEDIA_URL.replace(/\/$/, '');
const FFMPEG = process.env.FFMPEG ?? '/Users/henryallan/Documents/toolbox/vendor/ffmpeg/darwin-arm64/ffmpeg';
const host = process.argv[2]?.replace(/^www\./, '');
const apply = process.argv.includes('--apply');
const flag = (name, fallback) => (process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : fallback);
const min = flag('--min', 0.9);
const maxDiff = flag('--max-diff', 12);
if (!host) throw new Error('usage: dupes.mjs <host> [--apply] [--min 0.9] [--max-diff 12]');
const FRAMES = 8;
const libPath = 'public/media/library.json';
const bare = (s) => s.replace(/^www\./, '');
const assets = JSON.parse(fs.readFileSync(libPath, 'utf8')).assets.filter((a) => a.source && bare(a.source.site) === host);

const frames = new Map();
for (const a of assets) {
  const f = `public/media/${a.id}/embedding.f32`;
  if (!fs.existsSync(f)) { console.error(`${a.id}: not embedded; run embed.ts first`); continue; }
  const buf = fs.readFileSync(f);
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const dims = all.length / (FRAMES + 1);
  frames.set(a.id, Array.from({ length: FRAMES }, (_, i) => all.subarray(i * dims, (i + 1) * dims)));
}
const dot = (x, y) => { let s = 0; for (let k = 0; k < x.length; k++) s += x[k] * y[k]; return s; };
// The least alike pair of frames at the same point in each clip.
const likeness = (a, b) => Math.min(...frames.get(a.id).map((v, i) => dot(v, frames.get(b.id)[i])));

// 8 gray 32×18 frames spread over the clip's L1.
const W = 32, H = 18;
const thumbs = new Map();
function pixels(a) {
  if (!thumbs.has(a.id)) {
    const local = `public/${a.l1.url}`;
    const input = fs.existsSync(local) ? local : `${base}/${a.l1.url}`;
    const vf = `fps=${FRAMES / Math.max(a.duration, 0.1)},scale=${W}:${H},format=gray`;
    thumbs.set(a.id, execFileSync(FFMPEG, ['-v', 'error', '-i', input, '-vf', vf, '-frames:v', String(FRAMES), '-f', 'rawvideo', '-']));
  }
  return thumbs.get(a.id);
}
// The median over frames of the mean difference per pixel, 0–255.
function difference(a, b) {
  const [x, y] = [pixels(a), pixels(b)];
  const per = [];
  for (let o = 0; o + W * H <= Math.min(x.length, y.length); o += W * H) {
    let s = 0;
    for (let k = o; k < o + W * H; k++) s += Math.abs(x[k] - y[k]);
    per.push(s / (W * H));
  }
  return per.length ? per.sort((p, q) => p - q)[per.length >> 1] : 255;
}

// Union the pairs into groups.
const parent = new Map(assets.map((a) => [a.id, a.id]));
const find = (id) => (parent.get(id) === id ? id : find(parent.get(id)));
const near = [];
const list = assets.filter((a) => frames.has(a.id)).sort((a, b) => a.duration - b.duration);
for (let i = 0; i < list.length; i++) {
  for (let j = i + 1; j < list.length && list[j].duration - list[i].duration <= 0.25; j++) {
    const [a, b] = [list[i], list[j]];
    if (Math.abs(a.width / a.height - b.width / b.height) > 0.03) continue;
    const s = likeness(a, b);
    if (s < min) continue;
    const d = difference(a, b);
    if (d <= maxDiff) parent.set(find(b.id), find(a.id));
    else near.push([s, d, a, b]);
  }
}
const groups = new Map();
for (const a of list) groups.set(find(a.id), [...(groups.get(find(a.id)) ?? []), a]);

// A deeper page is more specific (/projects/x over /work over /), and so is
// one with fewer clips credited to it.
const perPage = new Map();
for (const a of assets) perPage.set(a.source.pageUrl, (perPage.get(a.source.pageUrl) ?? 0) + 1);
const depth = (a) => { try { return new URL(a.source.pageUrl).pathname.split('/').filter(Boolean).length; } catch { return 0; } };
// Sizes within a quarter of each other count as the same.
const area = (a) => a.width * a.height;
const bigger = (a, b) => (Math.max(area(a), area(b)) > 1.25 * Math.min(area(a), area(b)) ? area(b) - area(a) : 0);
const rank = (a, b) => bigger(a, b) || depth(b) - depth(a) || perPage.get(a.source.pageUrl) - perPage.get(b.source.pageUrl) || area(b) - area(a) || a.id.localeCompare(b.id);
const drop = new Map();
for (const g of [...groups.values()].filter((g) => g.length > 1)) {
  const [keep, ...rest] = [...g].sort(rank);
  console.log(`keep ${keep.id} ${keep.width}×${keep.height} ${keep.duration.toFixed(1)}s ${keep.source.pageUrl}`);
  for (const d of rest) {
    console.log(`  drop ${d.id} ${d.width}×${d.height} ${d.duration.toFixed(1)}s ${likeness(keep, d).toFixed(3)} Δ${difference(keep, d).toFixed(1)} ${d.source.pageUrl}`);
    drop.set(d.id, keep.id);
  }
}
// Alike to SigLIP but not in pixels, to check --max-diff against.
for (const [s, d, a, b] of near.sort((x, y) => x[1] - y[1]).slice(0, 8)) console.log(`near ${s.toFixed(3)} Δ${d.toFixed(1)} ${a.id} ${b.id} ${a.duration.toFixed(1)}s`);
console.log(`${drop.size} of ${assets.length} ${host} clips are copies${apply ? '' : ' (dry run; --apply drops them)'}`);
if (!apply || !drop.size) process.exit(0);

// The library, re-read right before writing.
const lib = JSON.parse(fs.readFileSync(libPath, 'utf8'));
const gone = lib.assets.filter((a) => drop.has(a.id));
lib.assets = lib.assets.filter((a) => !drop.has(a.id));
fs.writeFileSync(libPath, JSON.stringify(lib));
const keys = gone.flatMap((a) => [a.l0?.url, a.l1.url, a.l2?.url].filter(Boolean).map((u) => u.replace(/^\//, '')));
fs.appendFileSync('media/r2-orphans.txt', keys.map((k) => `${k}\n`).join(''));

const dir = fs.readdirSync('media/scraped').map((d) => `media/scraped/${d}`).find((d) => bare(path.basename(d)) === host);
if (dir) {
  const scrapePath = `${dir}/scrape.json`;
  const scrape = JSON.parse(fs.readFileSync(scrapePath, 'utf8'));
  for (const item of scrape.items) {
    if (!drop.has(item.id)) continue;
    if (item.file) fs.rmSync(`${dir}/${item.file}`, { force: true });
    fs.rmSync(`${dir}/${item.id}.json`, { force: true });
    Object.assign(item, { status: 'skipped', reason: `duplicate of ${drop.get(item.id)}` });
  }
  fs.writeFileSync(scrapePath, JSON.stringify(scrape, null, 2));
}
for (const id of drop.keys()) fs.rmSync(`public/media/${id}`, { recursive: true, force: true });
console.log(`dropped ${drop.size}; ${keys.length} R2 keys added to media/r2-orphans.txt; run embed.ts to repack the index`);
