// Collects every video on one website, with as much of what the site says
// about each as we can keep, ready for the proxy builder.
//
//   npm run scrape -- https://studio.example [options]
//
// Three tiers, cheapest first:
//   1. static   robots.txt, sitemaps and a same-site crawl of the HTML as
//               served, through the extractors in scrape/extract.ts
//   2. render   headless Chrome for pages that look client-rendered or hold
//               players we couldn't resolve: scroll, nudge hover players,
//               record media requests, re-extract the live DOM
//   3. agent    Claude with the browser toolset, when the first two leave
//               signs of more (no videos at all, "Load more" controls,
//               sourceless players); needs ANTHROPIC_API_KEY
//
// Output, in media/scraped/<host>/ unless --out says otherwise:
//   <id>.<ext>   the video, named by content hash (the library's asset id)
//   <id>.json    its sidecar: page, context, player attributes, embed info, project
//   scrape.json  the run: pages visited, every item, stats
//
// Re-runs reuse files already downloaded. Then build proxies, which reads
// the sidecars and adds the videos to the Feed:
//   FFMPEG=/path/to/ffmpeg npm run build:proxies -- --in media/scraped/<host> --merge
// (or pass --build here).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pool } from './lib/ffmpeg.ts';
import { AGENT_MODEL, BULK_MODEL, dollars, hasCredentials, loadEnv } from './lib/claude.ts';
import { runAgent, type AgentFindings } from './scrape/agent.ts';
import { launchBrowser, newContext, renderPage } from './scrape/browser.ts';
import { fetchItem, titleFromEmbed, ytdlpVersion } from './scrape/download.ts';
import { enrichPages, type PageVideos } from './scrape/enrich.ts';
import { agentReasons, extractPage, wantsRender } from './scrape/extract.ts';
import { groupItems, type ItemGroup, toItem } from './scrape/items.ts';
import { Fetcher, loadRobots, sitemapPages } from './scrape/site.ts';
import type { Candidate, PageMeta, PageRecord, PageSignals, ScrapedItem, Tier } from './scrape/types.ts';
import { bareHost, classifyMedia, normalizePage, parseUrl, sameSite } from './scrape/urls.ts';

const HELP = `Usage: npm run scrape -- <url> [options]

  --out <dir>            output folder (default media/scraped/<host>)
  --max-pages <n>        pages to visit (default 150)
  --render auto|all|off  headless Chrome pass (default auto: pages that need it)
  --agent auto|always|off  Claude browser agent (default auto: when the site hides video)
  --agent-turns <n>      agent turn budget (default 40)
  --agent-model <id>     Claude model for the agent (default ${AGENT_MODEL})
  --no-enrich            skip structuring project pages (title, client, credits, ...)
                         with Claude; on by default when ANTHROPIC_API_KEY is set
  --enrich-model <id>    Claude model for enrichment (default ${BULK_MODEL})
  --dry-run              find and check videos, download nothing
  --max-size <MB>        skip videos larger than this (default 500)
  --max-duration <s>     skip player-hosted videos longer than this (default 900)
  --max-height <px>      download player-hosted videos at up to this height (default 1080)
  --downloads <n>        parallel downloads (default 4)
  --budget-gb <n>        stop downloading once this run has fetched n GB
  --build                then build proxies, embeddings, (with a key) visual tags and the search index,
                         adding the videos to the library
  --concurrency <n>      parallel page fetches (default 4)

Claude features read ANTHROPIC_API_KEY from the environment or .env.local.
yt-dlp (for Vimeo, YouTube and streams) and ffmpeg come from YTDLP / FFMPEG or PATH.`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  allowNegative: true,
  options: {
    out: { type: 'string' },
    'max-pages': { type: 'string', default: '150' },
    render: { type: 'string', default: 'auto' },
    agent: { type: 'string', default: 'auto' },
    'agent-turns': { type: 'string', default: '40' },
    'agent-model': { type: 'string', default: AGENT_MODEL },
    enrich: { type: 'boolean' },
    'enrich-model': { type: 'string', default: BULK_MODEL },
    'dry-run': { type: 'boolean', default: false },
    'max-size': { type: 'string', default: '500' },
    'max-duration': { type: 'string', default: '900' },
    'max-height': { type: 'string', default: '1080' },
    downloads: { type: 'string', default: '4' },
    'budget-gb': { type: 'string' },
    build: { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '4' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (flags.help || positionals.length !== 1) {
  console.log(HELP);
  process.exit(flags.help ? 0 : 1);
}
if (!['auto', 'all', 'off'].includes(flags.render) || !['auto', 'always', 'off'].includes(flags.agent)) {
  console.error('--render takes auto|all|off and --agent takes auto|always|off');
  process.exit(1);
}
loadEnv();

const root = parseUrl(/^https?:\/\//i.test(positionals[0]) ? positionals[0] : `https://${positionals[0]}`);
if (!root) {
  console.error(`not a URL: ${positionals[0]}`);
  process.exit(1);
}
const host = bareHost(root.hostname);
const outDir = path.resolve(flags.out ?? path.join('media', 'scraped', host));
const maxPages = Math.max(1, Number(flags['max-pages']) || 150);
const concurrency = Math.max(1, Number(flags.concurrency) || 4);
const dryRun = flags['dry-run'];
const tty = process.stdout.isTTY;
const startedAt = new Date().toISOString();
const t0 = performance.now();

const log = (s: string) => {
  if (tty) process.stdout.write('\r\x1b[K');
  console.log(s);
};
const progress = (s: string) => {
  if (tty) process.stdout.write(`\r\x1b[K${s}`);
};
if (flags.enrich && !hasCredentials()) {
  console.error('--enrich needs ANTHROPIC_API_KEY (in the environment or .env.local)');
  process.exit(1);
}
const enrich = flags.enrich ?? hasCredentials();

const pages = new Map<string, PageRecord>();
const metas = new Map<string, PageMeta>();
const signals = new Map<string, PageSignals>();
const candidates: Candidate[] = [];
const keysOn = (url: string) => new Set(candidates.filter((c) => c.pageUrl === url).map((c) => c.key));
const allKeys = () => new Set(candidates.map((c) => c.key));

log(`scraping ${root.origin}${dryRun ? ' (dry run)' : ''}`);

// ---- 1. static crawl --------------------------------------------------------------

const fetcher = new Fetcher(concurrency, 250);
const robots = await loadRobots(fetcher, root);
if (robots.crawlDelay) fetcher.delayMs = Math.min(robots.crawlDelay, 10) * 1000;
if (!robots.allowed(root.toString())) {
  log(`robots.txt disallows ${root.pathname}; stopping.`);
  process.exit(1);
}

interface QueueEntry {
  url: string;
  depth: number;
}
const queue: QueueEntry[] = [];
const seen = new Set<string>();
let robotsSkipped = 0;
const LOW = /\/(blog|news|journal|press|careers|jobs|privacy|legal|terms|cookies?|imprint|impressum|tags?|category|categories|author|feed|cart|shop|account|login|search)(\/|$)/i;
const HIGH = /\/(work|works|project|projects|case-stud(y|ies)|cases|portfolio|films?|reels?|showreel|motion|animation|clients?)(\/|$)/i;
// Given a section (https://studio.example/work), its pages come first.
const section = root.pathname.length > 1 ? root.pathname.replace(/\/+$/, '') : null;
const priority = (e: QueueEntry) => {
  const p = new URL(e.url).pathname;
  const inSection = !!section && (p === section || p.startsWith(`${section}/`));
  return e.depth * 10 + (LOW.test(p) ? 40 : 0) - (HIGH.test(p) ? 5 : 0) - (inSection ? 15 : 0);
};

function enqueue(href: string, depth: number): void {
  const url = normalizePage(href);
  if (!url || seen.has(url) || !sameSite(url, root!)) return;
  seen.add(url);
  if (!robots.allowed(url)) {
    robotsSkipped++;
    return;
  }
  queue.push({ url, depth });
}

function popBest(): QueueEntry {
  let best = 0;
  for (let i = 1; i < queue.length; i++) if (priority(queue[i]) < priority(queue[best])) best = i;
  return queue.splice(best, 1)[0];
}

async function visit({ url, depth }: QueueEntry): Promise<void> {
  const res = await fetcher.page(url);
  const final = normalizePage(res.url) ?? url;
  if (!sameSite(final, root!)) {
    pages.set(url, { url, status: res.status, tier: 'static', rendered: false, candidates: 0, error: `redirects off-site to ${final}` });
    return;
  }
  if (final !== url && pages.has(final)) return;
  seen.add(final);
  const record: PageRecord = { url: final, status: res.status, tier: 'static', rendered: false, candidates: 0 };
  pages.set(final, record);
  if (res.blocked) {
    record.blocked = true;
    return;
  }
  if (!res.html) {
    record.error = res.error ?? (res.status >= 400 ? `HTTP ${res.status}` : `not HTML (${res.contentType || 'no type'})`);
    return;
  }
  const ex = extractPage(res.html, final, 'static', res.status);
  metas.set(final, ex.meta);
  signals.set(final, ex.signals);
  candidates.push(...ex.candidates);
  for (const l of ex.links) enqueue(l, depth + 1);
  progress(`  static  ${pages.size} pages · ${allKeys().size} videos`);
}

async function crawl(): Promise<void> {
  const inflight = new Set<Promise<void>>();
  while (queue.length || inflight.size) {
    while (queue.length && inflight.size < concurrency && pages.size + inflight.size < maxPages) {
      const p: Promise<void> = visit(popBest()).finally(() => inflight.delete(p));
      inflight.add(p);
    }
    if (!inflight.size) break;
    await Promise.race(inflight);
  }
}

enqueue(root.toString(), 0);
const fromSitemap = await sitemapPages(fetcher, root, robots);
for (const u of fromSitemap) enqueue(u, Math.max(1, new URL(u).pathname.split('/').filter(Boolean).length));
await crawl();
const staticKeys = allKeys().size;
log(`  static  ${pages.size} pages${fromSitemap.length ? ` (sitemap listed ${fromSitemap.length})` : ''} · ${staticKeys} videos${robotsSkipped ? ` · ${robotsSkipped} pages disallowed by robots.txt` : ''}`);
const rootRecord = pages.get(normalizePage(root.toString())!);
if (rootRecord?.blocked) log('  the homepage served a bot challenge; not trying to get past it.');

// ---- 2. render ----------------------------------------------------------------------

const browser = flags.render !== 'off' || flags.agent !== 'off' ? await launchBrowser().catch((e: Error) => (log(`  ${e.message}`), null)) : null;

async function renderPass(): Promise<number> {
  if (!browser || flags.render === 'off') return 0;
  const ok = [...pages.values()].filter((p) => !p.blocked && !p.error?.startsWith('redirects'));
  let targets: string[];
  if (flags.render === 'all' || staticKeys === 0 || pages.size <= 2) {
    // Nothing visible without scripts: the site is likely client-rendered.
    targets = ok.map((p) => p.url).slice(0, flags.render === 'all' ? maxPages : 40);
  } else {
    // Fetch failures (status 0) and plain 403s may load in a real browser; 404s won't.
    const retry = (p: PageRecord) => !!p.error && (p.status === 0 || p.status === 403);
    targets = ok.filter((p) => retry(p) || (signals.has(p.url) && wantsRender(signals.get(p.url)!, keysOn(p.url).size))).map((p) => p.url);
  }
  if (!targets.length) return 0;
  const context = await newContext(browser);
  const queued = new Set(targets);
  // Pages only the rendered DOM links to get rendered too, within budget.
  const spa = staticKeys === 0 || pages.size <= 2;
  let done = 0;
  const before = allKeys().size;
  const work = [...targets];
  const renderOne = async (url: string) => {
    const r = await renderPage(context, url);
    done++;
    const record = pages.get(url) ?? { url, status: r.status, tier: 'render' as Tier, rendered: false, candidates: 0 };
    pages.set(url, record);
    if (r.error) {
      record.error = `render: ${r.error}`;
      return;
    }
    if (r.blocked) {
      record.blocked = true;
      return;
    }
    const final = normalizePage(r.url) ?? url;
    const ex = extractPage(r.html, final, 'render', r.status);
    record.rendered = true;
    record.status = r.status || record.status;
    delete record.error;
    if ((ex.meta.text.length ?? 0) > (metas.get(final)?.text.length ?? 0)) metas.set(final, ex.meta);
    signals.set(final, ex.signals);
    const had = keysOn(final);
    candidates.push(...ex.candidates);
    for (const m of r.media) candidates.push({ url: m.url, kind: m.kind, key: m.key, provider: m.provider, pageUrl: final, tier: 'render', via: 'network', meta: { status: m.status, contentType: m.contentType } });
    for (const f of r.frames) {
      const ref = classifyMedia(f);
      if (ref && ref.kind !== 'file') candidates.push({ ...ref, pageUrl: final, tier: 'render', via: 'iframe' });
    }
    if ([...keysOn(final)].some((k) => !had.has(k))) record.tier = 'render';
    for (const l of ex.links) {
      const n = normalizePage(l);
      if (!n || queued.has(n) || pages.has(n) || !sameSite(n, root!) || !robots.allowed(n) || pages.size + work.length >= maxPages) continue;
      if (spa || !seen.has(n)) {
        queued.add(n);
        seen.add(n);
        work.push(n);
      }
    }
    progress(`  render  ${done}/${work.length} pages · ${allKeys().size} videos`);
  };
  // A queue that can grow while it drains.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, work.length) }, async () => {
    while (next < work.length) await renderOne(work[next++]);
  }));
  await context.close();
  log(`  render  ${done} pages in Chrome · +${allKeys().size - before} videos`);
  return done;
}
const rendered = await renderPass();

// ---- 3. agent -----------------------------------------------------------------------

// Pages that don't hold portfolio work, whatever their markup suggests.
const UTILITY = /(^|\/)(privacy|cookies?|legal|terms|imprint|impressum|contact|careers|jobs|blog|news|journal|press|people|team|author|tags?|category|categories|search|login|account|cart|shop)([-/_.]|$)/i;

function suspects(): { url: string; why: string[] }[] {
  const out: { url: string; why: string[] }[] = [];
  const common = (has: (s: PageSignals) => boolean) => signals.size >= 10 && [...signals.values()].filter(has).length / signals.size > 0.3;
  const moreEverywhere = common((s) => s.moreButton);
  const hintsEverywhere = common((s) => s.playerHints > 0);
  const listing = normalizePage(root!.toString());
  for (const [url, s] of signals) {
    const u = new URL(url);
    if (url !== listing && (UTILITY.test(u.pathname) || u.searchParams.has('post_type'))) continue;
    const chrome = url !== listing;
    const why = agentReasons(s, keysOn(url).size, { moreIsChrome: moreEverywhere && chrome, hintsAreChrome: hintsEverywhere && chrome });
    if (why.length) out.push({ url, why });
  }
  return out;
}

let agent: AgentFindings | null = null;
const flagged = suspects();
const agentWanted = flags.agent === 'always' || (flags.agent === 'auto' && (allKeys().size === 0 || flagged.length > 0 || pages.size <= 2));
if (agentWanted && !browser) log('  agent   skipped: Chrome is not available');
else if (agentWanted && !hasCredentials()) log(`  agent   skipped: ${flagged.length ? `${plural(flagged.length, 'page')} look${flagged.length === 1 ? 's' : ''} like ${flagged.length === 1 ? 'it hides' : 'they hide'} more video` : 'the crawl found too little'}; set ANTHROPIC_API_KEY (or .env.local) to send the agent in`);
else if (agentWanted && browser) {
  const why = flags.agent === 'always' ? 'asked for' : allKeys().size === 0 ? 'no videos found yet' : flagged.length ? `${plural(flagged.length, 'page')} flagged` : 'very few pages reachable';
  log(`  agent   ${why}; ${flags['agent-model']}, up to ${flags['agent-turns']} turns`);
  const context = await newContext(browser);
  agent = await runAgent({
    root,
    allowed: (url) => robots.allowed(url),
    context,
    model: flags['agent-model'],
    maxTurns: Math.max(1, Number(flags['agent-turns']) || 40),
    brief: briefFor(flagged),
    known: allKeys(),
    log,
  });
  await context.close();
  const before = allKeys().size;
  candidates.push(...agent.candidates);
  for (const [url, meta] of agent.pages) {
    if (!metas.has(url)) metas.set(url, meta);
    if (!pages.has(url)) pages.set(url, { url, status: meta.status, tier: 'agent', rendered: true, candidates: 0 });
  }
  const cost = agent.usage.cost !== null ? ` · ~$${agent.usage.cost.toFixed(2)}` : '';
  log(`  agent   ${agent.usage.turns} turns · +${allKeys().size - before} videos · ${agent.annotations.size} pages annotated${cost}${agent.error ? ` · stopped: ${agent.error}` : ''}`);
  if (agent.summary) log(agent.summary.split('\n').map((l) => `          ${l}`).join('\n'));
}
await browser?.close();

function briefFor(flaggedPages: { url: string; why: string[] }[]): string {
  const lines = [`Site: ${root!.origin}/`, `The crawler visited ${pages.size} pages (${rendered} rendered in Chrome) and found ${allKeys().size} videos.`, ''];
  if (flaggedPages.length) {
    lines.push('Pages that look like they hide more video:');
    for (const f of flaggedPages.slice(0, 40)) lines.push(`- ${f.url}: ${f.why.join('; ')}`);
    lines.push('');
  }
  lines.push('Pages visited, with videos found on each:');
  const visited = [...pages.values()].sort((a, b) => a.url.localeCompare(b.url));
  for (const p of visited.slice(0, 150)) lines.push(`- ${p.url} (${keysOn(p.url).size})${p.blocked ? ' [bot check]' : p.error ? ` [${p.error}]` : ''}`);
  if (visited.length > 150) lines.push(`… and ${visited.length - 150} more`);
  lines.push('', 'Find the videos the crawler missed, and annotate project pages as you go.');
  return lines.join('\n');
}

// ---- 4. items -----------------------------------------------------------------------

const now = new Date().toISOString();
const siteName = mostCommon([...metas.values()].map((m) => m.og.site_name).filter((s): s is string => !!s));
const site = { url: root.origin + '/', host, ...(siteName ? { name: siteName } : {}) };
const groups = groupItems(candidates);
const items: ScrapedItem[] = groups.map((g) => toItem(g, metas, site, now));
const groupOf = new Map<ScrapedItem, ItemGroup>(items.map((it, i) => [it, groups[i]]));

for (const item of items) {
  const ann = agent?.annotations.get(item.page.url);
  if (ann) {
    item.project = ann;
    if (ann.title && (item.titleSource === 'page' || item.titleSource === 'url' || items.filter((i) => i.page.url === item.page.url).length === 1)) {
      item.title = ann.title;
      item.titleSource = 'project';
    }
  }
  const recorded = item.appearances.find((a) => a.meta?.agent)?.meta?.agent as Record<string, unknown> | undefined;
  if (recorded && !item.project) {
    const { title, description, client, year, credits, tags } = recorded as Record<string, never>;
    item.project = { title, description, client, year, credits, tags, source: 'agent' };
  }
}

// Carry over what earlier runs downloaded.
const manifestPath = path.join(outDir, 'scrape.json');
const previous: ScrapedItem[] = fs.existsSync(manifestPath) ? ((JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { items?: ScrapedItem[] }).items ?? []) : [];
const prevByKey = new Map(previous.map((i) => [i.key, i]));
let reused = 0;
for (const item of items) {
  const p = prevByKey.get(item.key);
  if (!p) continue;
  item.firstSeenAt = p.firstSeenAt ?? item.firstSeenAt;
  if (p.status === 'downloaded' && p.file && fs.existsSync(path.join(outDir, p.file))) {
    Object.assign(item, { status: 'downloaded', id: p.id, file: p.file, embed: p.embed ?? item.embed });
    item.media = { ...p.media, urls: item.media.urls };
    if (p.titleSource === 'project') Object.assign(item, { title: p.title, titleSource: p.titleSource });
    titleFromEmbed(item);
    item.project ??= p.project;
    reused++;
  }
}
const current = new Set(items.map((i) => i.key));
const carried = previous.filter((p) => !current.has(p.key));

// ---- 5. download --------------------------------------------------------------------

fs.mkdirSync(outDir, { recursive: true });
const todo = items.filter((i) => i.status === 'found');
if (todo.some((i) => groupOf.get(i)!.urls.some((u) => u.kind !== 'file')) && !ytdlpVersion()) {
  log('  yt-dlp not found: Vimeo, YouTube and stream videos will fail. Install it (pip install yt-dlp) or set YTDLP.');
}
let fetched = 0;
// --budget-gb caps what this run downloads; items queue in crawl order, so
// the pages crawled first (the section asked for) win.
const budget = Number(flags['budget-gb'] ?? 0) * 1e9 || Infinity;
let spent = 0;
await pool(todo, Math.max(1, Number(flags.downloads) || 4), async (item) => {
  if (!dryRun && spent >= budget) {
    item.status = 'skipped';
    item.reason = `over --budget-gb (${flags['budget-gb']} GB)`;
    fetched++;
    return;
  }
  await fetchItem(item, groupOf.get(item)!, {
    dir: outDir,
    maxBytes: Number(flags['max-size']) * 1e6,
    maxDuration: Number(flags['max-duration']),
    maxHeight: Number(flags['max-height']) || 1080,
    dryRun,
  });
  fetched++;
  if (item.status === 'downloaded') spent += item.media.bytes ?? 0;
  if (item.status === 'failed') log(`  failed  ${item.title} — ${item.reason}`);
  progress(`  ${dryRun ? 'check' : 'fetch'}   ${fetched}/${todo.length}`);
});
fs.rmSync(path.join(outDir, '.tmp'), { recursive: true, force: true });

// ---- 6. enrich ----------------------------------------------------------------------

if (enrich) {
  const byPage = new Map<string, PageVideos>();
  for (const item of items) {
    const meta = metas.get(item.page.url);
    if (!meta || item.status === 'failed') continue;
    const entry = byPage.get(item.page.url) ?? { url: item.page.url, meta, items: [] };
    entry.items.push(item);
    byPage.set(item.page.url, entry);
  }
  log(`  enrich  ${byPage.size} pages with ${flags['enrich-model']}`);
  const { done, spent } = await enrichPages([...byPage.values()], flags['enrich-model'], log);
  log(`  enrich  ${done}/${byPage.size} pages structured · ${dollars(spent)}`);
}

// ---- 7. write -----------------------------------------------------------------------

// One sidecar per file. Two items can share bytes (the same film on Vimeo
// and as an upload); their appearances merge.
const byId = new Map<string, ScrapedItem[]>();
for (const item of items) if (item.id) byId.set(item.id, [...(byId.get(item.id) ?? []), item]);
for (const [id, same] of byId) {
  const sidecarPath = path.join(outDir, `${id}.json`);
  const old = fs.existsSync(sidecarPath) ? (JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as ScrapedItem) : null;
  const main: ScrapedItem = { ...same[0] };
  const appearances = [...same.flatMap((i) => i.appearances), ...(old?.appearances ?? [])];
  const seenAt = new Set<string>();
  main.appearances = appearances.filter((a) => {
    const k = `${a.pageUrl} ${a.url}`;
    if (seenAt.has(k)) return false;
    seenAt.add(k);
    return true;
  });
  main.media = { ...main.media, urls: [...new Set(same.flatMap((i) => i.media.urls))] };
  main.firstSeenAt = old?.firstSeenAt && old.firstSeenAt < main.firstSeenAt ? old.firstSeenAt : main.firstSeenAt;
  if (old?.project?.source === 'agent' && !main.project) main.project = old.project;
  fs.writeFileSync(sidecarPath, JSON.stringify(main, null, 2));
}

const count = (s: ScrapedItem['status']) => items.filter((i) => i.status === s).length;
const bytes = items.reduce((s, i) => s + (i.status === 'downloaded' ? (i.media.bytes ?? 0) : 0), 0);
const stats = {
  pages: pages.size,
  rendered,
  blocked: [...pages.values()].filter((p) => p.blocked).length,
  candidates: candidates.length,
  items: items.length,
  downloaded: count('downloaded'),
  reused,
  skipped: count('skipped'),
  failed: count('failed'),
  bytes,
  byTier: Object.fromEntries((['static', 'render', 'agent'] as const).map((t) => [t, items.filter((i) => i.foundBy === t).length])),
  seconds: Math.round((performance.now() - t0) / 1000),
};
for (const p of pages.values()) p.candidates = keysOn(p.url).size;
const manifest = {
  version: 1,
  site,
  dryRun,
  startedAt,
  finishedAt: new Date().toISOString(),
  options: { maxPages, render: flags.render, agent: flags.agent, agentModel: flags['agent-model'], enrich, enrichModel: flags['enrich-model'], maxSizeMB: Number(flags['max-size']), maxDuration: Number(flags['max-duration']), maxHeight: Number(flags['max-height']) },
  stats,
  ...(agent ? { agent: { turns: agent.usage.turns, usage: agent.usage, summary: agent.summary, error: agent.error } } : {}),
  pages: [...pages.values()].map((p) => ({ ...p, ...(metas.has(p.url) ? { meta: metas.get(p.url) } : {}), ...(signals.has(p.url) ? { signals: signals.get(p.url) } : {}) })),
  items: [...items, ...carried],
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const mb = (n: number) => `${(n / 1e6).toFixed(0)} MB`;
const rel = path.relative(process.cwd(), outDir) || '.';
log(
  `\n${items.length} videos on ${host} in ${stats.seconds}s — ` +
    (dryRun ? `${items.length - stats.failed} reachable` : `${stats.downloaded} downloaded (${mb(bytes)}${reused ? `, ${reused} from earlier runs` : ''})`) +
    `${stats.skipped ? `, ${stats.skipped} skipped` : ''}${stats.failed ? `, ${stats.failed} failed` : ''}`,
);
log(`  found by static ${stats.byTier.static} · render ${stats.byTier.render} · agent ${stats.byTier.agent}`);
log(`  ${path.join(rel, 'scrape.json')}`);

if (flags.build && !dryRun && stats.downloaded) {
  // Proxies, then local embeddings (free), then visual tags for this site's
  // clips when there's a key. Each step skips work already done.
  const step = (script: string, ...args: string[]) => spawnSync(process.execPath, [path.resolve('scripts', script), ...args], { stdio: 'inherit' }).status ?? 1;
  let status = step('build-proxies.ts', '--in', outDir, '--merge');
  if (status === 0) status = step('embed.ts');
  if (status === 0 && hasCredentials()) status = step('tag.ts', '--only', host);
  else if (status === 0) log('  tags skipped: set ANTHROPIC_API_KEY to tag clips (npm run tag)');
  // Search sees new clips once the index is rebuilt from all of the above.
  if (status === 0) status = step('search-index.ts');
  process.exitCode = status;
} else if (!dryRun && stats.downloaded) {
  log(`  next: FFMPEG=/path/to/ffmpeg npm run build:proxies -- --in ${rel} --merge, then npm run embed, npm run tag and npm run index`);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function mostCommon(xs: string[]): string | undefined {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
}
