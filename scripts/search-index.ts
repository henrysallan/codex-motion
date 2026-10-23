// Builds the search index bundle (src/search/bundle.ts) from the library
// manifest and the packed embeddings, into <out>/search/. Run it after a
// scrape, tag or embed pass changes the library:
//
//   node scripts/search-index.ts [--out public/media] [--upload]
//
// --upload sends the bundle to the media Worker (VITE_MEDIA_URL,
// MEDIA_ADMIN_TOKEN from the environment or .env.local), manifest last, so
// signed-in clients pick it up on their next load.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { EmbeddingIndex, Library } from '../src/media/library.ts';
import { packVectors, type SearchBundle, type SearchDoc, type SearchManifest, type SearchPage } from '../src/search/bundle.ts';
import { classify, PROJECT_TYPES, SECTORS, splitStudios, yearOf } from '../src/search/taxonomy.ts';
import { arg } from './lib/ffmpeg.ts';

const outRoot = path.resolve(arg('out', 'public/media'));
const publicRoot = path.resolve('public');
const searchDir = path.join(outRoot, 'search');
const library = JSON.parse(fs.readFileSync(path.join(outRoot, 'library.json'), 'utf8')) as Library;

// Sites whose pages don't name the studio, and whose host doesn't spell it.
const SITE_NAMES: Record<string, string> = {
  'studiodumbar.com': 'Studio Dumbar',
  'alright.studio': 'Alright Studio',
  'cotton.design': 'Cotton',
  'portorocha.com': 'Porto Rocha',
  'dixonbaxi.com': 'DixonBaxi',
  'movingbrands.com': 'Moving Brands',
};

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function siteName(host: string): string {
  if (SITE_NAMES[host]) return SITE_NAMES[host];
  const assets = library.assets.filter((a) => a.source?.site === host);
  const named = assets.find((a) => a.source?.siteName)?.source?.siteName;
  if (named) return named;
  // A studio credited on the site that spells its host: "Porto Rocha" for portorocha.com.
  const base = host.replace(/^www\./, '').split('.')[0];
  const spelled = assets.flatMap((a) => splitStudios(a.source?.agency)).find((name) => squash(name) === squash(base));
  return spelled ?? base.charAt(0).toUpperCase() + base.slice(1);
}

// ---- pages ---------------------------------------------------------------------------

const sites: Record<string, string> = {};
const pages: SearchPage[] = [];
const pageIndex = new Map<string, number>();

function pageOf(src: NonNullable<Library['assets'][number]['source']>): number {
  const known = pageIndex.get(src.pageUrl);
  if (known !== undefined) return known;
  sites[src.site] ??= siteName(src.site);
  const seen = new Set<string>();
  const tags = (src.tags ?? []).map((t) => t.trim()).filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  const studios = [...new Set([sites[src.site], ...splitStudios(src.agency)])];
  const year = yearOf(src.year);
  const page: SearchPage = {
    url: src.pageUrl,
    ...(src.pageTitle ? { title: src.pageTitle } : {}),
    ...(src.description ? { description: src.description.slice(0, 480) } : {}),
    ...(src.client ? { client: src.client.trim() } : {}),
    studios,
    ...(year ? { year } : {}),
    tags,
    projectTypes: classify(tags, PROJECT_TYPES),
    sectors: classify(tags, SECTORS),
    site: src.site,
  };
  pageIndex.set(src.pageUrl, pages.length);
  pages.push(page);
  return pages.length - 1;
}

// ---- docs and vectors ----------------------------------------------------------------

const docs: SearchDoc[] = library.assets.map((a) => ({
  id: a.id,
  title: a.source?.title || a.name,
  page: a.source ? pageOf(a.source) : -1,
  ...(a.analysis?.caption ? { caption: a.analysis.caption } : {}),
  tags: a.analysis?.tags ?? [],
  duration: a.duration,
  width: a.width,
  height: a.height,
  added: a.source ? Math.round(Date.parse(a.source.scrapedAt) / 1000) || 0 : 0,
}));

let model: string | null = null;
let dims = 0;
let vectors: Uint8Array<ArrayBuffer> | null = null;
const embeddingsPath = path.join(outRoot, 'embeddings.json');
if (fs.existsSync(embeddingsPath)) {
  const index = JSON.parse(fs.readFileSync(embeddingsPath, 'utf8')) as EmbeddingIndex;
  const buf = fs.readFileSync(path.join(publicRoot, index.file));
  const means = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const row = new Map(index.ids.map((id, i) => [id, i]));
  model = index.model;
  dims = index.dims;
  vectors = packVectors(
    docs.map((d) => {
      const i = row.get(d.id);
      return i === undefined ? null : means.subarray(i * dims, (i + 1) * dims);
    }),
    dims,
  );
  const missing = docs.filter((d) => !row.has(d.id)).length;
  if (missing) console.log(`${missing} clips have no embedding yet (npm run embed)`);
} else {
  console.log('no embeddings.json: the index will have text only (npm run embed)');
}

// ---- write -----------------------------------------------------------------------------

const bundle: SearchBundle = { version: 1, built: new Date().toISOString(), sites, pages, docs };
const json = JSON.stringify(bundle);
const hash = createHash('sha256').update(json).update(vectors ?? new Uint8Array()).digest('hex').slice(0, 16);
fs.mkdirSync(searchDir, { recursive: true });
const keyOf = (file: string) => path.relative(publicRoot, path.join(searchDir, file)).split(path.sep).join('/');
const files = { bundle: `${hash}.json`, vectors: vectors ? `${hash}.vec` : null };
fs.writeFileSync(path.join(searchDir, files.bundle), json);
if (vectors && files.vectors) fs.writeFileSync(path.join(searchDir, files.vectors), vectors);
const manifest: SearchManifest = {
  version: 1,
  built: bundle.built,
  count: docs.length,
  bundle: keyOf(files.bundle),
  vectors: files.vectors ? keyOf(files.vectors) : null,
  model,
  dims,
};
fs.writeFileSync(path.join(searchDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
// Earlier builds.
for (const f of fs.readdirSync(searchDir)) if (f !== 'manifest.json' && !f.startsWith(hash)) fs.rmSync(path.join(searchDir, f));

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
console.log(`search index ${hash}: ${docs.length} clips, ${pages.length} pages, ${Object.keys(sites).length} sites; text ${mb(json.length)}, vectors ${mb(vectors?.byteLength ?? 0)}`);
const typed = pages.filter((p) => p.projectTypes.length).length;
console.log(`  ${typed}/${pages.length} pages have a project type, ${pages.filter((p) => p.sectors.length).length} a sector`);

// ---- upload ----------------------------------------------------------------------------

if (process.argv.includes('--upload')) {
  if (fs.existsSync('.env.local')) process.loadEnvFile('.env.local');
  const base = process.env.VITE_MEDIA_URL?.replace(/\/$/, '');
  const token = process.env.MEDIA_ADMIN_TOKEN;
  if (!base || !token) throw new Error('--upload needs VITE_MEDIA_URL and MEDIA_ADMIN_TOKEN');
  const put = async (key: string, body: Uint8Array<ArrayBuffer> | string, type: string) => {
    const res = await fetch(`${base}/${key}`, { method: 'PUT', body, headers: { Authorization: `Bearer ${token}`, 'Content-Type': type } });
    if (!res.ok) throw new Error(`${key}: HTTP ${res.status} ${await res.text()}`);
    console.log(`  uploaded ${key}`);
  };
  await put(manifest.bundle, json, 'application/json');
  if (manifest.vectors && vectors) await put(manifest.vectors, vectors, 'application/octet-stream');
  await put('media/search/manifest.json', JSON.stringify(manifest), 'application/json');
}
