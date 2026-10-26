// Imports Instagram posts into the library: every video in each post (a
// carousel gives several), with who made it and what it is.
//
//   npm run instagram -- <post url>... [--file urls.txt] [options]
//
// Per post: yt-dlp reads the post and downloads its videos; headless Chrome
// reads the post page (tagged and collaborating accounts, music) and the
// profiles involved; the poster's bio links are read as plain HTML; then
// Claude (Haiku) works out the maker, title, client, credits and tools,
// searching the web only when that leaves something open. See
// scripts/instagram/enrich.ts for the layers.
//
// Output, in media/scraped/instagram.com/ unless --out says otherwise:
//   <id>.<ext>       the video, named by content hash (the library's asset id)
//   <id>.json        its sidecar, as the site scraper writes them
//   instagram.json   the run: every post, its videos, the enrichment and cost
// Then add them to the library as with a scraped site:
//   FFMPEG=/path/to/ffmpeg npm run build:proxies -- --in media/scraped/instagram.com --merge
//
// What it collects, per video: who made it (name, Instagram profile, the
// websites in their bio), the post's link and date, and what the caption
// says (title, client, credits, tools). Web search is opt-in (--search): on
// the first test set it added a portfolio Instagram never linked and a few
// project pages, at about $0.02 a post against $0.001 without.
//
// Instagram is read logged out, one page at a time, several seconds apart.
// A saved session (scripts/instagram-cookies.sh) stands in when Instagram
// asks for a login; a security check or "try again later" stops the run.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { BULK_MODEL, dollars, hasCredentials, loadEnv } from './lib/claude.ts';
import { enrichPost, type Enriched, type Layer, LAYERS, type PostContext, relation } from './instagram/enrich.ts';
import { creatorOf, projectOf } from './instagram/record.ts';
import { gatherPost, saveInfo } from './instagram/gather.ts';
import { COOKIES, InstagramPages } from './instagram/pages.ts';
import { type Downloaded, downloadPost, postUrl, shortcodeOf, YtdlpError } from './instagram/post.ts';
import type { ScrapedItem } from './scrape/types.ts';

const DEFAULT_LAYERS: Layer[] = ['post', 'profile', 'links'];

const HELP = `Usage: npm run instagram -- <post url>... [options]

  --file <path>          read post URLs from a file, one per line
  --out <dir>            output folder (default media/scraped/instagram.com)
  --layers <list>        enrichment layers, comma-separated (default ${DEFAULT_LAYERS.join(',')}):
                         post (caption, tags, comments), profile (profiles involved),
                         links (the poster's bio links), search (web search for what's left open)
  --search               add the search layer (Claude web search, ~$0.01 a search)
  --related <n>          profiles of tagged/mentioned accounts to read per post (default 4)
  --login auto|always|never  use the saved Instagram session (scripts/instagram-cookies.sh)
                         only when a page asks for a login (default auto)
  --no-download          gather and enrich, download nothing
  --no-enrich            download only; no Claude
  --model <id>           Claude model (default ${BULK_MODEL})
  --search-model <id>    model for the search pass (default: --model)
  --max-searches <n>     web searches per post (default 3)
  --max-height <px>      download at up to this height (default 1080)
  --max-size <MB>        skip videos larger than this (default 500)
  --refresh              re-read Instagram instead of using cached pages

Claude reads ANTHROPIC_API_KEY from the environment or .env.local. yt-dlp and
ffmpeg come from YTDLP / FFMPEG or PATH (ffmpeg merges Instagram's DASH tracks).`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    file: { type: 'string' },
    out: { type: 'string', default: path.join('media', 'scraped', 'instagram.com') },
    layers: { type: 'string', default: DEFAULT_LAYERS.join(',') },
    search: { type: 'boolean', default: false },
    related: { type: 'string', default: '4' },
    login: { type: 'string', default: 'auto' },
    download: { type: 'boolean', default: true },
    enrich: { type: 'boolean', default: true },
    model: { type: 'string', default: BULK_MODEL },
    'search-model': { type: 'string' },
    'max-searches': { type: 'string', default: '3' },
    'max-height': { type: 'string', default: '1080' },
    'max-size': { type: 'string', default: '500' },
    refresh: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const urls = [...positionals, ...(flags.file ? fs.readFileSync(flags.file, 'utf8').split('\n') : [])].map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
if (flags.help || !urls.length) {
  console.log(HELP);
  process.exit(flags.help ? 0 : 1);
}
const layers = new Set([...flags.layers.split(',').map((s) => s.trim()), ...(flags.search ? ['search'] : [])] as Layer[]);
const login = flags.login as 'auto' | 'always' | 'never';
if (![...layers].every((l) => LAYERS.includes(l)) || !layers.has('post') || !['auto', 'always', 'never'].includes(login)) {
  console.error(`--layers takes ${LAYERS.join(',')} (post always included) and --login takes auto|always|never`);
  process.exit(1);
}
if (login === 'always' && !fs.existsSync(COOKIES)) {
  console.error(`--login always needs a saved session; run scripts/instagram-cookies.sh first (${COOKIES})`);
  process.exit(1);
}
loadEnv();

const outDir = path.resolve(flags.out);
const cacheDir = path.join(outDir, '.cache');
const manifestPath = path.join(outDir, 'instagram.json');
fs.mkdirSync(outDir, { recursive: true });

const codes: string[] = [];
for (const u of urls) {
  const code = shortcodeOf(u);
  if (!code) console.error(`not an Instagram post URL, skipped: ${u}`);
  else if (!codes.includes(code)) codes.push(code);
}

interface PostEntry {
  url: string;
  status: 'done' | 'failed' | 'partial';
  error?: string;
  videos: { index: number; id: string; file: string }[];
  poster?: string;
  enrichment?: Enriched;
  updatedAt: string;
}
interface Manifest {
  version: 1;
  updatedAt: string;
  posts: Record<string, PostEntry>;
}
const manifest: Manifest = fs.existsSync(manifestPath) ? (JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest) : { version: 1, updatedAt: '', posts: {} };
const writeManifest = () => fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, updatedAt: new Date().toISOString() }, null, 2));

// Chrome starts only when a page isn't cached yet.
const pages = new InstagramPages({ login });
const client = flags.enrich && hasCredentials() ? new Anthropic({ maxRetries: 4 }) : null;
if (flags.enrich && !client) console.log('No ANTHROPIC_API_KEY: downloading and gathering only (set it in .env.local to enrich).');
const log = (s: string) => console.log(s);
let spent = 0;
let failed = 0;

for (const [n, code] of codes.entries()) {
  const prefix = `[${n + 1}/${codes.length}] ${code}`;
  const entry: PostEntry = manifest.posts[code] ?? { url: postUrl(code), status: 'failed', videos: [], updatedAt: '' };
  try {
    // Videos already here (or already in the library) aren't fetched again.
    // A download also brings the post's metadata, so it goes first.
    const have = entry.videos.filter((v) => fs.existsSync(path.join(outDir, v.file)) || fs.existsSync(path.join('public', 'media', v.id, 'asset.json')));
    let videos: Downloaded[] | null = null;
    if (flags.download && (!entry.videos.length || have.length < entry.videos.length)) {
      const opts = { maxHeight: Number(flags['max-height']) || 1080, maxBytes: Number(flags['max-size']) * 1e6 };
      let got: Awaited<ReturnType<typeof downloadPost>>;
      try {
        got = await downloadPost(code, outDir, opts);
      } catch (e) {
        if (!(e instanceof YtdlpError && e.needsLogin && fs.existsSync(COOKIES))) throw e;
        log(`${prefix}: download needs a login; retrying with the saved session`);
        got = await downloadPost(code, outDir, { ...opts, cookies: COOKIES });
      }
      videos = got.videos;
      if (got.info && !flags.refresh) saveInfo(cacheDir, code, got.info);
      entry.videos = videos.map(({ index, id, file }) => ({ index, id, file }));
    }
    const ctx = await gatherPost(code, { cacheDir, pages, related: layers.has('profile') ? Math.max(0, Number(flags.related) || 0) : 0, links: layers.has('links'), refresh: flags.refresh, log });
    entry.poster = ctx.page?.user?.username ?? ctx.info.channel;

    if (client) {
      entry.enrichment = await enrichPost(client, ctx, layers, { model: flags.model, searchModel: flags['search-model'], maxSearches: Number(flags['max-searches']) || 3 });
      spent += entry.enrichment.cost ?? 0;
    }
    writeSidecars(ctx, entry, videos);
    entry.status = entry.videos.length || !flags.download ? 'done' : 'partial';
    delete entry.error;
    const r = entry.enrichment?.record;
    log(
      `${prefix} @${entry.poster} · ${entry.videos.length} video${entry.videos.length === 1 ? '' : 's'}` +
        (r ? ` · ${r.maker.real_name ?? r.maker.name ?? 'maker unknown'}${r.maker.attribution === 'poster' ? '' : r.maker.attribution === 'unclear' ? ' (unclear)' : ' (not the poster)'} · "${r.title ?? ''}"${r.maker.website ? ` · ${r.maker.website}` : ''}` : '') +
        (entry.enrichment ? ` · ${dollars(entry.enrichment.cost)}${entry.enrichment.search ? ` (${entry.enrichment.search.requests} searches)` : ''}` : ''),
    );
  } catch (e) {
    failed++;
    entry.status = 'failed';
    entry.error = (e as Error).message;
    log(`${prefix} failed: ${entry.error}`);
  }
  entry.updatedAt = new Date().toISOString();
  manifest.posts[code] = entry;
  writeManifest();
  if (pages.stopped) {
    log(`Stopping: ${pages.stopped}`);
    break;
  }
}
await pages.close();
fs.rmSync(path.join(outDir, '.tmp'), { recursive: true, force: true });

const viewed = pages.views.loggedOut + pages.views.loggedIn;
const views = viewed ? ` · ${viewed} Instagram page views${pages.views.loggedIn ? ` (${pages.views.loggedIn} logged in)` : ''}` : '';
log(`\n${codes.length - failed}/${codes.length} posts${client ? ` · Claude ${dollars(spent)}` : ''}${views}`);
log(`  ${path.relative(process.cwd(), manifestPath)}`);
if (flags.download) log(`  next: FFMPEG=/path/to/ffmpeg npm run build:proxies -- --in ${path.relative(process.cwd(), outDir)} --merge, then npm run embed, npm run tag and npm run index`);

// ---- sidecars ------------------------------------------------------------------------

function writeSidecars(ctx: PostContext, entry: PostEntry, fresh: Downloaded[] | null): void {
  const now = new Date().toISOString();
  const r = entry.enrichment?.record;
  const handle = entry.poster ?? '';
  const caption = ctx.page?.caption ?? ctx.info.description ?? '';
  const firstLine = caption.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'))?.slice(0, 100);
  const title = r?.title ?? firstLine ?? `Video by @${handle}`;
  const posted = ctx.page?.takenAt ?? (ctx.info.timestamp ? new Date(ctx.info.timestamp * 1000).toISOString() : undefined);
  const project = r ? projectOf(r, posted) : undefined;
  const creator = creatorOf(ctx, r, handle);
  const total = entry.videos.length;
  for (const v of entry.videos) {
    const file = path.join(outDir, `${v.id}.json`);
    const old = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as ScrapedItem) : null;
    const got = fresh?.find((f) => f.id === v.id);
    const media: ScrapedItem['media'] = got
      ? { urls: [entry.url], kind: 'embed', provider: 'instagram', downloadedFrom: entry.url, bytes: got.bytes, width: got.probe.width, height: got.probe.height, duration: Number(got.probe.duration.toFixed(3)), fps: Number(got.probe.fps.toFixed(3)), ...(got.probe.codec ? { codec: got.probe.codec } : {}), audio: got.probe.audio }
      : (old?.media ?? { urls: [entry.url], kind: 'embed', provider: 'instagram', downloadedFrom: entry.url });
    const item: ScrapedItem & { instagram: unknown } = {
      key: `instagram:${ctx.code}:${v.index}`,
      status: 'downloaded',
      foundBy: 'static',
      id: v.id,
      file: v.file,
      title: (total > 1 ? `${title} (${v.index}/${total})` : title).slice(0, 160),
      titleSource: r?.title ? 'project' : 'page',
      media,
      page: {
        url: entry.url,
        title: r?.maker.name ? `${title} — ${r.maker.real_name ?? r.maker.name}` : title,
        ...(caption ? { description: caption.slice(0, 1000) } : {}),
        siteName: 'Instagram',
        author: `@${handle}`,
        ...(posted ? { published: posted } : {}),
      },
      appearances: [{ pageUrl: entry.url, url: entry.url, tier: 'static', via: 'instagram' }],
      embed: {
        extractor_key: 'Instagram',
        id: ctx.code,
        webpage_url: entry.url,
        ...(handle ? { channel: handle } : {}),
        ...(ctx.info.uploader ? { uploader: ctx.info.uploader } : {}),
        ...(ctx.info.timestamp ? { timestamp: ctx.info.timestamp } : {}),
        ...(ctx.info.likes !== undefined ? { like_count: ctx.info.likes } : {}),
        ...(total > 1 ? { playlist_index: v.index, playlist_count: total } : {}),
      },
      ...(project ? { project } : old?.project ? { project: old.project } : {}),
      creator,
      site: { url: 'https://www.instagram.com/', host: 'instagram.com' },
      firstSeenAt: old?.firstSeenAt ?? now,
      scrapedAt: now,
      instagram: {
        code: ctx.code,
        ...(ctx.poster ? { poster: ctx.poster } : { poster: { username: handle } }),
        related: ctx.related.map((u) => ({ username: u.username, ...(u.fullName ? { fullName: u.fullName } : {}), relation: relation(ctx, u.username) })),
        ...(ctx.page?.music ? { music: ctx.page.music } : {}),
        ...(ctx.page?.aiLabel ? { aiLabel: ctx.page.aiLabel } : {}),
        ...(r ? { maker: r.maker, tools: r.tools, openQuestions: r.open_questions } : {}),
        ...(entry.enrichment ? { enrichment: { model: entry.enrichment.model, layers: entry.enrichment.layers, cost: entry.enrichment.cost, ...(entry.enrichment.search ? { searched: entry.enrichment.search.queries, sources: entry.enrichment.search.sources } : {}) } } : {}),
      },
    };
    fs.writeFileSync(file, JSON.stringify(item, null, 2));
  }
}
