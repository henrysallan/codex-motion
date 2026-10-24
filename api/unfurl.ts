// POST /api/unfurl: a link's preview, for the links in a clip's notes
// (src/app/detail/notes.ts). Body: { url }. Answers { url, title?,
// description?, site, image?, icon? }, with the page's og:image and its
// icon as data: URIs. The app shrinks them to thumbnails and keeps them with
// the note, so a note never loads anything from the sites it links to, and
// the CSP's img-src stays as it is.
//
// YouTube and Vimeo links go through their oEmbed endpoints, which answer
// datacenter addresses reliably; other pages are read as served (robots.txt
// honoured, no headless browser). Every fetch only reaches public addresses
// (Fetcher's publicOnly) and stops at a byte cap.
//
// The bearer is the caller's Supabase access token, checked with Supabase,
// and each person gets 60 previews per 10 minutes. With no Supabase configured
// (local mode, the dev server only) it's open, counted per address.
//
// A Vercel Function in production; the Vite dev server serves the same
// handler (vite.config.ts).

import { load } from 'cheerio';
import { clean } from '../scripts/scrape/extract.ts';
import { Fetcher, loadRobots } from '../scripts/scrape/site.ts';
import { bareHost, parseUrl } from '../scripts/scrape/urls.ts';
import { rateLimit } from './_limit.ts';

export interface Preview {
  url: string;
  title?: string;
  description?: string;
  // The site's name, or its host.
  site: string;
  image?: string;
  icon?: string;
}

const PAGE_BYTES = 4 << 20;
const IMAGE_BYTES = 1536 << 10;
const ICON_BYTES = 256 << 10;
const TIMEOUT_MS = 8_000;
const IMAGE_TYPES = /^image\/(jpeg|png|webp|gif|avif)$/;
const ICON_TYPES = /^image\/(jpeg|png|webp|gif|avif|x-icon|vnd\.microsoft\.icon|svg\+xml)$/;

class Fail extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// ---- who's asking -----------------------------------------------------------------------

async function caller(request: Request): Promise<string> {
  const base = process.env.VITE_SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.VITE_SUPABASE_ANON_KEY;
  if (!base || !key) {
    // Deployed, previews are for signed-in people only.
    if (process.env.VERCEL) throw new Fail(503, 'Link previews need Supabase, which isn’t configured here');
    return `local:${request.headers.get('x-forwarded-for') ?? ''}`;
  }
  const token = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
  if (!token) throw new Fail(401, 'Sign in to preview links');
  const res = await fetch(`${base}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Fail(401, 'Sign in again to preview links');
  return ((await res.json()) as { id: string }).id;
}

// A note full of links unfurls them all at once; 60 per 10 minutes leaves
// room for that and stops a script.
export const withinLimit = rateLimit(60, 10 * 60_000);

// ---- reading ----------------------------------------------------------------------------

const fetcher = () => new Fetcher(3, 0, { publicOnly: true, maxBytes: PAGE_BYTES, timeoutMs: TIMEOUT_MS });

async function readBytes(res: Response, max: number): Promise<Buffer | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

// An image as a data: URI, if it's one of `types` and under `max` bytes.
export async function imageData(f: Fetcher, href: string | undefined, base: string, types: RegExp, max: number): Promise<string | undefined> {
  const u = href ? parseUrl(href, base) : null;
  if (!u) return undefined;
  try {
    const res = await f.get(u.href, 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8,*/*;q=0.5');
    const type = (res.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    if (!res.ok || !types.test(type) || Number(res.headers.get('content-length') ?? 0) > max) {
      await res.body?.cancel();
      return undefined;
    }
    const bytes = await readBytes(res, max);
    return bytes?.length ? `data:${type};base64,${bytes.toString('base64')}` : undefined;
  } catch {
    return undefined;
  }
}

const OEMBED: { host: RegExp; endpoint: string; name: string }[] = [
  { host: /^(youtube\.com|m\.youtube\.com|youtu\.be)$/, endpoint: 'https://www.youtube.com/oembed?format=json&url=', name: 'YouTube' },
  { host: /^(vimeo\.com|player\.vimeo\.com)$/, endpoint: 'https://vimeo.com/api/oembed.json?url=', name: 'Vimeo' },
];

function parseOEmbed(text: string | null): { title?: unknown; author_name?: unknown; thumbnail_url?: unknown } | null {
  try {
    const o: unknown = text ? JSON.parse(text) : null;
    return o && typeof o === 'object' ? o : null;
  } catch {
    // Not JSON: the page is read instead.
    return null;
  }
}

async function viaOEmbed(f: Fetcher, url: URL): Promise<Preview | null> {
  const host = bareHost(url.hostname);
  const provider = OEMBED.find((o) => o.host.test(host));
  if (!provider) return null;
  const o = parseOEmbed(await f.text(provider.endpoint + encodeURIComponent(url.href)));
  if (!o || typeof o.title !== 'string') return null;
  const [image, icon] = await Promise.all([
    imageData(f, typeof o.thumbnail_url === 'string' ? o.thumbnail_url : undefined, url.href, IMAGE_TYPES, IMAGE_BYTES),
    imageData(f, `https://${host === 'youtu.be' ? 'www.youtube.com' : host.replace(/^player\./, '')}/favicon.ico`, url.href, ICON_TYPES, ICON_BYTES),
  ]);
  const author = typeof o.author_name === 'string' ? clean(o.author_name, 120) : '';
  return {
    url: url.href,
    title: clean(o.title, 200),
    ...(author ? { description: author } : {}),
    site: provider.name,
    ...(image ? { image } : {}),
    ...(icon ? { icon } : {}),
  };
}

// The page's icon: a declared PNG or SVG first, then any icon, then the
// conventional /favicon.ico.
export function iconHref($: ReturnType<typeof load>): string {
  const icons = $('link[rel][href]')
    .toArray()
    .map((el) => ({ rel: ($(el).attr('rel') ?? '').toLowerCase().split(/\s+/), href: $(el).attr('href')!, type: ($(el).attr('type') ?? '').toLowerCase() }))
    .filter((l) => l.rel.includes('icon') || l.rel.includes('apple-touch-icon'));
  const rank = (l: (typeof icons)[number]) => (l.rel.includes('icon') ? (/png|svg/.test(l.type) || /\.(png|svg)(\?|$)/i.test(l.href) ? 0 : 1) : 2);
  return icons.sort((a, b) => rank(a) - rank(b))[0]?.href ?? '/favicon.ico';
}

export async function unfurl(url: URL, f = fetcher()): Promise<Preview> {
  const embedded = await viaOEmbed(f, url);
  if (embedded) return embedded;

  const robots = await loadRobots(f, url);
  if (!robots.allowed(url.href)) throw new Fail(422, `${url.hostname}’s robots.txt asks crawlers not to read that page`);
  const page = await f.page(url.href);
  if (page.blocked) throw new Fail(422, `${url.hostname} answered with a bot check`);
  if (page.error) throw new Fail(422, `Couldn’t reach ${url.hostname}: ${page.error}`);
  if (page.status >= 400) throw new Fail(422, `${url.hostname} answered ${page.status}`);
  const site = bareHost(new URL(page.url).hostname);

  // A link straight to an image previews as itself.
  if (!page.html) {
    const type = page.contentType.split(';', 1)[0].trim().toLowerCase();
    const image = IMAGE_TYPES.test(type) ? await imageData(f, page.url, page.url, IMAGE_TYPES, IMAGE_BYTES) : undefined;
    if (!image) throw new Fail(422, 'That link isn’t a web page');
    return { url: page.url, title: clean(decodeURIComponent(new URL(page.url).pathname.split('/').pop() ?? ''), 200) || undefined, site, image };
  }

  const $ = load(page.html);
  const base = parseUrl($('base[href]').attr('href') ?? '', page.url)?.href ?? page.url;
  const meta = (...keys: string[]) => {
    for (const k of keys) {
      const v = $(`meta[property="${k}"], meta[name="${k}"]`).first().attr('content')?.trim();
      if (v) return v;
    }
    return undefined;
  };
  const title = clean(meta('og:title', 'twitter:title') ?? $('title').first().text(), 200);
  const description = clean(meta('og:description', 'twitter:description', 'description'), 300);
  const siteName = clean(meta('og:site_name', 'application-name'), 80);
  const [image, icon] = await Promise.all([
    imageData(f, meta('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'), base, IMAGE_TYPES, IMAGE_BYTES),
    imageData(f, iconHref($), base, ICON_TYPES, ICON_BYTES),
  ]);
  return {
    url: page.url,
    ...(title ? { title } : {}),
    ...(description && description !== title ? { description } : {}),
    site: siteName || site,
    ...(image ? { image } : {}),
    ...(icon ? { icon } : {}),
  };
}

// ---- handler ----------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => null)) as { url?: unknown } | null;
    const raw = typeof body?.url === 'string' ? body.url.trim() : '';
    const url = raw.length <= 2048 ? parseUrl(raw) : null;
    if (!url) throw new Fail(400, 'url must be an http(s) link');
    const who = await caller(request);
    if (!withinLimit(who)) throw new Fail(429, 'That’s a lot of links at once; try again in a few minutes');
    return json(await unfurl(url));
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.message }, e.status);
    console.error('unfurl failed', e);
    return json({ error: 'Couldn’t preview that link' }, 500);
  }
}
