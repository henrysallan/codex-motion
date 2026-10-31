// POST /api/enrich: fills in an upload's details, for the Enrich button in
// a clip's details panel. Body: { assetId, url?, sheet?, capture? }
//
// - url: the page the clip came from. It's read as served (robots.txt
//   honoured, no headless browser), and the scraper's enrichment prompt
//   (scripts/scrape/enrich.ts) turns it into project fields: title,
//   client, studio, year, credits, tags.
// - capture: for a clip the Chrome extension saved, the page as the person
//   saw it, from the file (src/media/capture.ts). It stands in for
//   fetching `url`: the same prompt reads it, plus the post's text and the
//   player's metadata, so signed-in pages (Instagram, private Vimeo) work.
// - sheet: a contact sheet of the clip as a base64 JPEG, which the app
//   builds from its L1 proxy (src/app/enrich.ts). It's tagged with the
//   library's motion vocabulary (scripts/lib/tagging.ts).
//
// Only the uploader may enrich a clip: the bearer is their Supabase access
// token, and the result is written to their asset row with that token, so
// row-level security has the last word. Answers { source, analysis, cost,
// warning? }. Each person gets 30 calls per 10 minutes (withinLimit), and
// the page fetch only reaches public addresses (Fetcher's publicOnly).
//
// A Vercel Function in production; the Vite dev server serves the same
// handler (vite.config.ts). Haiku 5.5: about $0.001 for a page and $0.0004
// for a sheet.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { addUsage, BULK_MODEL, cost, emptyUsage, type Usage } from '../scripts/lib/claude.ts';
import { flattenTags, TAG_SYSTEM, tagContent, Tags } from '../scripts/lib/tagging.ts';
import { describePage, Enrichment, SYSTEM as PAGE_SYSTEM } from '../scripts/scrape/enrich.ts';
import { clean, extractPage } from '../scripts/scrape/extract.ts';
import { Fetcher, loadRobots } from '../scripts/scrape/site.ts';
import type { PageMeta } from '../scripts/scrape/types.ts';
import { bareHost, classifyMedia, parseUrl } from '../scripts/scrape/urls.ts';
import { type Capture, captureSource, creatorOf, toCapture } from '../src/media/capture.ts';
import type { Asset, AssetAnalysis, AssetSource } from '../src/media/library.ts';
import { isPlatform } from '../src/search/docs.ts';
import { rateLimit } from './_limit.ts';

const MODEL = BULK_MODEL;
// A 1.3 MP sheet is a few hundred KB; Vercel takes bodies up to 4.5 MB.
const MAX_SHEET = 3_000_000;

class Fail extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// ---- Supabase, as the caller ------------------------------------------------------------

export interface AssetRow {
  id: string;
  origin: string;
  added_by: string | null;
  name: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  source: AssetSource | null;
}

function supabase(token: string) {
  const base = process.env.VITE_SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!base || !key) throw new Fail(503, 'Enrich needs Supabase, which isn’t configured here');
  return (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(15_000) });
}

async function caller(db: ReturnType<typeof supabase>): Promise<string> {
  const user = await db('/auth/v1/user');
  if (!user.ok) throw new Fail(401, 'Sign in again to enrich clips');
  return ((await user.json()) as { id: string }).id;
}

// The caller's row, if it's their own upload.
async function ownUpload(db: ReturnType<typeof supabase>, assetId: string, userId: string): Promise<AssetRow> {
  const res = await db(`/rest/v1/assets?id=eq.${assetId}&select=id,origin,added_by,name,duration,width,height,fps,source`);
  if (!res.ok) throw new Fail(502, `Couldn’t read the clip (HTTP ${res.status})`);
  const [row] = (await res.json()) as AssetRow[];
  if (!row) throw new Fail(404, 'That clip isn’t in the library yet; wait for its upload to finish');
  if (row.origin !== 'upload' || row.added_by !== userId) throw new Fail(403, 'Only the person who uploaded a clip can enrich it');
  return row;
}

// ---- rate limit -------------------------------------------------------------------------

// Each call is a model request, so one person gets 30 calls per 10 minutes;
// pressing Enrich by hand never gets near it. Per instance (see _limit.ts).
export const withinLimit = rateLimit(30, 10 * 60_000);

// ---- the page ---------------------------------------------------------------------------

// Public web pages only: no IP literals, local names or odd ports.
export function publicUrl(raw: string): URL | null {
  const u = parseUrl(raw);
  if (!u) return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.startsWith('[') || /\.(localhost|local|internal|lan|home\.arpa)$/.test(h)) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  if (u.username || u.password) return null;
  return u;
}

async function readPage(url: URL): Promise<{ url: string; meta: PageMeta }> {
  // The link is anyone's input: the fetcher checks every hop's address and
  // caps what it reads.
  const fetcher = new Fetcher(1, 0, { publicOnly: true, maxBytes: 4 << 20, timeoutMs: 12_000 });
  const robots = await loadRobots(fetcher, url);
  if (!robots.allowed(url.href)) throw new Fail(422, `${url.hostname}’s robots.txt asks crawlers not to read that page`);
  const page = await fetcher.page(url.href);
  // Redirects may land somewhere else; that has to be public too.
  if (!publicUrl(page.url)) throw new Fail(422, 'That link redirects somewhere we can’t read');
  if (page.blocked) throw new Fail(422, `${url.hostname} answered with a bot check`);
  if (page.error) throw new Fail(422, `Couldn’t reach ${url.hostname}: ${page.error}`);
  if (page.status >= 400) throw new Fail(422, `${url.hostname} answered ${page.status}`);
  if (!page.html) throw new Fail(422, 'That link isn’t a web page');
  return { url: page.url, meta: extractPage(page.html, page.url, 'static', page.status).meta };
}

type EnrichmentOut = ReturnType<typeof Enrichment.parse>;

// What the page says, in the library's source shape (as build-proxies maps
// a scraper sidecar).
export function toSource(pageUrl: string, meta: PageMeta, out: EnrichmentOut, fallbackTitle: string): AssetSource {
  const host = bareHost(new URL(pageUrl).hostname);
  const p = out.project;
  // On a platform the site's name is the platform's, not the maker's.
  const siteName = isPlatform(host) ? '' : clean(meta.og.site_name, 120);
  const player = classifyMedia(pageUrl);
  const tags = [...new Set([...p.disciplines, ...p.tags].map((t) => t.trim()).filter(Boolean))];
  const title = (out.is_project_page && p.title) || clean(meta.og.title ?? meta.title, 160) || fallbackTitle;
  const description = p.description ?? meta.description;
  return {
    site: host,
    ...(siteName ? { siteName } : {}),
    pageUrl,
    ...(meta.title ? { pageTitle: clean(meta.title, 200) } : {}),
    ...(player?.kind === 'embed' ? { mediaUrl: pageUrl, ...(player.provider ? { provider: player.provider } : {}) } : {}),
    title,
    ...(description ? { description } : {}),
    ...(p.client ? { client: p.client } : {}),
    ...(p.agency ? { agency: p.agency } : {}),
    ...(p.year ? { year: p.year } : {}),
    ...(p.credits.length ? { credits: p.credits } : {}),
    ...(tags.length ? { tags } : {}),
    scrapedAt: new Date().toISOString(),
  };
}

export async function enrichPage(client: Anthropic, usage: Usage, url: URL, row: AssetRow): Promise<AssetSource> {
  const page = await readPage(url);
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: zodOutputFormat(Enrichment) },
    thinking: { type: 'disabled' },
    system: PAGE_SYSTEM,
    messages: [{ role: 'user', content: describePage({ url: page.url, meta: page.meta, items: [] }) }],
  });
  addUsage(usage, response.usage);
  const out = response.parsed_output;
  if (response.stop_reason === 'refusal' || !out) throw new Fail(502, 'The model couldn’t read that page');
  return toSource(page.url, page.meta, out, row.name);
}

// ---- a capture ----------------------------------------------------------------------------

// The prompt for a captured page: the scraper's page description with the
// clip as its one video, then what a feed post or the player adds.
export function describeCapture(c: Capture, meta: PageMeta): string {
  const { post, ...context } = c.context ?? {};
  const appearance = { pageUrl: meta.url, url: c.media?.url ?? c.url, tier: 'render' as const, via: 'extension', context: { ...context, index: 0 } };
  const base = describePage({ url: meta.url, meta, items: [{ appearances: [appearance], ...(c.embed ? { embed: { ...c.embed } } : {}) }] });
  const e = c.embed;
  const poster = creatorOf(e);
  const extra = [
    post && `Post text: ${post}`,
    e?.description && e.description !== meta.description && `Player description: ${e.description.slice(0, 3000)}`,
    poster?.name && `Posted by: ${poster.name}${poster.handle && poster.handle !== poster.name ? ` (@${poster.handle})` : ''}`,
    e?.tags?.length && `Player tags: ${e.tags.join(', ')}`,
    c.slide && `The clip is slide ${c.slide.index} of ${c.slide.count} in the post.`,
  ].filter((l): l is string => typeof l === 'string');
  return extra.length ? `${base}\n\n${extra.join('\n')}` : base;
}

// Reads a capture as enrichPage reads a fetched page. Who posted it and
// when come from the player's metadata, which the page prompt doesn't ask.
export async function enrichCapture(client: Anthropic, usage: Usage, c: Capture, row: AssetRow): Promise<AssetSource> {
  const meta: PageMeta = { og: {}, twitter: {}, meta: {}, jsonLd: [], text: '', ...c.page, url: c.page?.url ?? c.url, status: 200 };
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: 'low', format: zodOutputFormat(Enrichment) },
    thinking: { type: 'disabled' },
    system: PAGE_SYSTEM,
    messages: [{ role: 'user', content: describeCapture(c, meta) }],
  });
  addUsage(usage, response.usage);
  const out = response.parsed_output;
  if (response.stop_reason === 'refusal' || !out) throw new Fail(502, 'The model couldn’t read that page');
  const own = captureSource(c, row.name);
  const source = toSource(c.url, meta, out, own.title);
  return {
    ...source,
    ...(own.mediaUrl && !source.mediaUrl ? { mediaUrl: own.mediaUrl, ...(own.provider ? { provider: own.provider } : {}) } : {}),
    ...(!source.description && own.description ? { description: own.description } : {}),
    ...(!source.tags && own.tags ? { tags: own.tags } : {}),
    ...(own.creator ? { creator: own.creator } : {}),
    ...(own.published ? { published: own.published } : {}),
  };
}

// ---- the frames -------------------------------------------------------------------------

export async function tagSheet(client: Anthropic, usage: Usage, sheet: string, row: AssetRow, source: AssetSource | null): Promise<AssetAnalysis> {
  const clip: Asset = {
    id: row.id,
    name: row.name,
    duration: row.duration,
    width: row.width,
    height: row.height,
    fps: row.fps,
    l0: null,
    l1: { url: '', width: row.width, height: row.height, bytes: 0 },
    l2: null,
    ...(source ? { source } : {}),
  };
  // A still is a one-frame, one-second clip; its sheet is that one frame.
  const still = row.fps <= 1 && row.duration <= 1;
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 1024,
    system: TAG_SYSTEM,
    messages: [{ role: 'user', content: tagContent(sheet, clip, still ? 'This is a still image, so the sheet holds one frame: judge what it shows, and leave motion-only fields empty.' : undefined) }],
    output_config: { effort: 'low', format: zodOutputFormat(Tags) },
    thinking: { type: 'disabled' },
  });
  addUsage(usage, response.usage);
  const out = response.parsed_output;
  if (response.stop_reason === 'refusal' || !out) throw new Fail(502, 'The model couldn’t tag this clip');
  return { caption: out.caption.trim(), tags: flattenTags(out).tags, model: MODEL, at: new Date().toISOString() };
}

// ---- handler ----------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  try {
    const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    if (!token) throw new Fail(401, 'Sign in to enrich clips');
    const body = (await request.json().catch(() => null)) as { assetId?: unknown; url?: unknown; sheet?: unknown; capture?: unknown } | null;
    const assetId = typeof body?.assetId === 'string' && /^[0-9a-f]{16}$/.test(body.assetId) ? body.assetId : null;
    if (!assetId) throw new Fail(400, 'missing assetId');
    // The capture's link is where the clip came from; it replaces `url`.
    const capture = body?.capture == null ? null : toCapture(body.capture);
    if (body?.capture != null && !capture) throw new Fail(400, 'capture isn’t one the extension wrote');
    const rawUrl = capture?.url ?? (typeof body?.url === 'string' ? body.url.trim() : '');
    const url = rawUrl ? publicUrl(rawUrl) : null;
    if (rawUrl && !url) throw new Fail(400, 'That doesn’t look like a public web link');
    const sheet = typeof body?.sheet === 'string' && body.sheet ? body.sheet : null;
    // JPEG data starts FF D8 FF, which is "/9j/" in base64.
    if (sheet && (sheet.length > MAX_SHEET || !sheet.startsWith('/9j/'))) throw new Fail(400, 'sheet must be a base64 JPEG under 3 MB');
    if (!url && !sheet) throw new Fail(400, 'nothing to enrich: send a url or a sheet');

    const db = supabase(token);
    const userId = await caller(db);
    if (!withinLimit(userId)) throw new Fail(429, 'That’s a lot of enriching at once; try again in a few minutes');
    const row = await ownUpload(db, assetId, userId);
    const client = new Anthropic({ maxRetries: 2, timeout: 45_000 });
    const usage = emptyUsage();

    // The page first: what it says is a hint for the tagger.
    let source: AssetSource | null = null;
    let warning: string | undefined;
    if (capture) {
      try {
        source = await enrichCapture(client, usage, capture, row);
      } catch (e) {
        if (!(e instanceof Fail)) throw e;
        // What the capture says on its own is still worth keeping.
        source = captureSource(capture, row.name);
        warning = e.message;
      }
    } else if (url) {
      try {
        source = await enrichPage(client, usage, url, row);
      } catch (e) {
        if (!(e instanceof Fail) || !sheet) throw e;
        // The frames can still be tagged; the link is kept either way.
        warning = e.message;
      }
    }
    const analysis = sheet ? await tagSheet(client, usage, sheet, row, source ?? row.source) : null;

    const patch = {
      ...(url ? { source_url: (source?.pageUrl ?? url.href) } : {}),
      ...(source ? { source, ...(source.pageTitle ? { source_title: source.pageTitle } : {}) } : {}),
      ...(analysis ? { analysis } : {}),
    };
    const res = await db(`/rest/v1/assets?id=eq.${assetId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Fail(502, `Couldn’t save the details (HTTP ${res.status})`);
    return json({ source, analysis, sourceUrl: patch.source_url ?? null, cost: cost(MODEL, usage), ...(warning ? { warning } : {}) });
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.message }, e.status);
    console.error('enrich failed', e);
    const api = e instanceof Anthropic.APIError;
    return json({ error: api ? `The model is unavailable right now (${e.status})` : 'Enrich failed' }, api ? 503 : 500);
  }
}
