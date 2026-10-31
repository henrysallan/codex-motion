// The capture record the Chrome extension (extension/) writes into a video
// it saves: the page the video was seen on, what that page said about it
// (scripts/scrape/types.ts PageMeta), the card around it (VideoContext,
// plus a feed post's text), where the file came from, and the player's own
// metadata from yt-dlp. It's JSON in the file's comment tag, marked with
// CAPTURE_KEY (extension/background.js buildCapture, host/motion_host.py
// write_capture).
//
// The app reads it when the file is dropped (src/ingest/ingest.worker.ts),
// shows it as the clip's source straight away (captureSource), and sends
// it to /api/enrich, which reads it in place of fetching the page: it's the
// page as the person saw it, signed in, which a server can't fetch.
//
// Anyone can write a comment tag, so readCapture keeps only the known
// fields, as the types they should be, within size limits. The server runs
// the same function on what the app sends.

import { isPlatform } from '../search/docs.ts';
import type { AssetSource, Creator } from './library.ts';

export const CAPTURE_KEY = 'motion.isthishenry';
const VERSION = 1;

export interface CapturePage {
  url: string;
  title?: string;
  description?: string;
  canonical?: string;
  lang?: string;
  h1?: string;
  og: Record<string, string>;
  twitter: Record<string, string>;
  meta: Record<string, string>;
  jsonLd: unknown[];
  // Visible text, trimmed. Empty on feed pages, where it's every post.
  text: string;
}

export interface CaptureContext {
  heading?: string;
  section?: string;
  caption?: string;
  text?: string;
  link?: { href: string; text?: string };
  // The feed post's text (caption, author, credits), on Instagram, X...
  post?: string;
}

// The fields of yt-dlp's metadata the helper keeps (EMBED_FIELDS).
export interface CaptureEmbed {
  id?: string;
  title?: string;
  description?: string;
  uploader?: string;
  uploader_id?: string;
  uploader_url?: string;
  channel?: string;
  channel_id?: string;
  channel_url?: string;
  creators?: string[];
  // YYYYMMDD.
  upload_date?: string;
  release_date?: string;
  // Seconds since the epoch.
  timestamp?: number;
  webpage_url?: string;
  extractor_key?: string;
  tags?: string[];
  categories?: string[];
  duration?: number;
  location?: string;
}

export interface Capture {
  // The post or page the video belongs to.
  url: string;
  page?: CapturePage;
  context?: CaptureContext;
  media?: { url: string; provider?: string };
  // Which slide of a carousel post.
  slide?: { index: number; count: number };
  embed?: CaptureEmbed;
}

// ---- reading ------------------------------------------------------------------

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

function link(v: unknown): string | undefined {
  const s = str(v, 2000);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function strings(v: unknown, count: number, max: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap((x) => str(x, max) ?? []).slice(0, count);
  return out.length ? out : undefined;
}

function dict(v: unknown, count: number, max: number): Record<string, string> {
  if (!isObj(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v).slice(0, count)) {
    const s = str(x, max);
    if (s && k.length <= 100) out[k] = s;
  }
  return out;
}

// Drops undefined fields, so records compare and serialise cleanly.
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function page(v: unknown, fallbackUrl: string): CapturePage | undefined {
  if (!isObj(v)) return undefined;
  let jsonLd: unknown[] = [];
  if (Array.isArray(v.jsonLd) && JSON.stringify(v.jsonLd).length <= 20_000) jsonLd = v.jsonLd.slice(0, 20);
  return compact({
    url: link(v.url) ?? fallbackUrl,
    title: str(v.title, 300),
    description: str(v.description, 2000),
    canonical: link(v.canonical),
    lang: str(v.lang, 20),
    h1: str(v.h1, 300),
    og: dict(v.og, 40, 2000),
    twitter: dict(v.twitter, 40, 2000),
    meta: dict(v.meta, 60, 1000),
    jsonLd,
    text: str(v.text, 12_000) ?? '',
  });
}

function context(v: unknown): CaptureContext | undefined {
  if (!isObj(v)) return undefined;
  const href = isObj(v.link) ? link(v.link.href) : undefined;
  const out = compact({
    heading: str(v.heading, 300),
    section: str(v.section, 300),
    caption: str(v.caption, 500),
    text: str(v.text, 500),
    link: href ? compact({ href, text: isObj(v.link) ? str(v.link.text, 200) : undefined }) : undefined,
    post: str(v.post, 4000),
  });
  return Object.keys(out).length ? out : undefined;
}

function embed(v: unknown): CaptureEmbed | undefined {
  if (!isObj(v)) return undefined;
  const id = typeof v.id === 'number' ? String(v.id) : str(v.id, 200);
  const out = compact({
    id,
    title: str(v.title, 500),
    description: str(v.description, 5000),
    uploader: str(v.uploader, 200),
    uploader_id: str(v.uploader_id, 200),
    uploader_url: link(v.uploader_url),
    channel: str(v.channel, 200),
    channel_id: str(v.channel_id, 200),
    channel_url: link(v.channel_url),
    creators: strings(v.creators, 10, 200),
    upload_date: /^\d{8}$/.test(String(v.upload_date ?? '')) ? String(v.upload_date) : undefined,
    release_date: /^\d{8}$/.test(String(v.release_date ?? '')) ? String(v.release_date) : undefined,
    timestamp: num(v.timestamp),
    webpage_url: link(v.webpage_url),
    extractor_key: str(v.extractor_key, 100),
    tags: strings(v.tags, 40, 100),
    categories: strings(v.categories, 10, 100),
    duration: num(v.duration),
    location: str(v.location, 200),
  });
  return Object.keys(out).length ? out : undefined;
}

// A capture from parsed JSON, or null when it isn't one.
export function toCapture(v: unknown): Capture | null {
  if (!isObj(v) || v[CAPTURE_KEY] !== VERSION) return null;
  const url = link(v.url);
  if (!url) return null;
  const mediaUrl = isObj(v.media) ? link(v.media.url) : undefined;
  const slide = isObj(v.slide) ? { index: num(v.slide.index), count: num(v.slide.count) } : null;
  return compact({
    url,
    page: page(v.page, url),
    context: context(v.context),
    media: mediaUrl ? compact({ url: mediaUrl, provider: isObj(v.media) ? str(v.media.provider, 60) : undefined }) : undefined,
    slide: slide?.index && slide.count && slide.index >= 1 && slide.index <= slide.count ? { index: slide.index, count: slide.count } : undefined,
    embed: embed(v.embed),
  });
}

// A file's comment tag, if it holds a capture.
export function readCapture(comment: string | undefined): Capture | null {
  if (!comment || !comment.trimStart().startsWith('{')) return null;
  try {
    return toCapture(JSON.parse(comment));
  } catch {
    return null;
  }
}

// What the capture says on its own, with no model involved: the source a
// dropped clip shows until it's enriched. Enrichment (api/enrich.ts) reads
// the page text for client, credits and the rest.
export function captureSource(c: Capture, fallbackTitle: string): AssetSource {
  const host = new URL(c.url).hostname.toLowerCase().replace(/^www\./, '');
  const p = c.page;
  const e = c.embed;
  const named = (t: string | undefined) => (t && !looksLikeFilename(t) && !/^(video|post|reel) by /i.test(t) ? t : undefined);
  const title = named(c.context?.heading) ?? named(e?.title) ?? p?.og.title ?? p?.title ?? fallbackTitle;
  const siteName = isPlatform(host) ? undefined : p?.og.site_name;
  const description = e?.description ?? p?.description;
  const creator = creatorOf(e);
  const published = publishedOf(c);
  return compact({
    site: host,
    siteName,
    pageUrl: c.url,
    pageTitle: p?.title,
    mediaUrl: c.media?.url,
    provider: c.media?.provider,
    title: title.slice(0, 160),
    description: description?.slice(0, 1000),
    tags: e?.tags?.slice(0, 20),
    creator,
    published,
    scrapedAt: new Date().toISOString(),
  });
}

// Who posted it, from the player's metadata. yt-dlp's `uploader` is the
// display name; the handle is `uploader_id` (YouTube's @handle, Vimeo's
// slug) unless that's a numeric id, as on Instagram, whose username is
// `channel`.
export function creatorOf(e: CaptureEmbed | undefined): Creator | undefined {
  if (!e) return undefined;
  const name = e.uploader ?? e.channel ?? e.creators?.[0];
  const id = e.uploader_id && !/^\d+$/.test(e.uploader_id) ? e.uploader_id : e.channel && /^@?[\w.]+$/.test(e.channel) ? e.channel : undefined;
  const handle = id?.replace(/^@/, '');
  const url = e.uploader_url ?? e.channel_url;
  const out = compact({ name, handle, url });
  return Object.keys(out).length ? out : undefined;
}

// When the post or page went up, as an ISO date.
export function publishedOf(c: Capture): string | undefined {
  const e = c.embed;
  if (e?.timestamp) return new Date(e.timestamp * 1000).toISOString().slice(0, 10);
  const day = e?.upload_date ?? e?.release_date;
  if (day) return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
  const meta = c.page?.meta['article:published_time'] ?? c.page?.og['article:published_time'];
  return meta && /^\d{4}-\d{2}-\d{2}/.test(meta) ? meta.slice(0, 10) : undefined;
}

// A player's title is often the uploaded file's name ("Amazon_CS_04_System").
// As in scripts/scrape/urls.ts, which the app doesn't bundle.
function looksLikeFilename(t: string): boolean {
  const s = t.trim();
  return (
    /_.*_|^_|\.(mp4|mov|webm|m4v|gif)$|\bv\d+\b|\bfinal\b|\d{3,4}p\b|\d{3,4}x\d{3,4}/i.test(s) ||
    (s.match(/\p{L}/gu) ?? []).length < 3 ||
    /^(untitled|video|vimeo video player|youtube video player)$/i.test(s)
  );
}
