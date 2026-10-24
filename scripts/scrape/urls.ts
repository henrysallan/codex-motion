// URL helpers for the scraper: normalizing page links, and recognizing a
// video when we see one. Every extractor funnels URLs through classifyMedia,
// so "what counts as a video" lives in one place.

import type { MediaKind } from './types.ts';

export interface MediaRef {
  kind: MediaKind;
  // A hint about where the file lives (vimeo, webflow, framer, ...).
  provider?: string;
  // Two references to the same video share a key: provider and id for
  // players, host and path for files.
  key: string;
  // The URL to fetch, when it differs from the one we were given (a Mux
  // player page becomes its HLS manifest).
  url: string;
}

const FILE_EXT = /\.(mp4|m4v|mov|webm|ogv|mkv)$/i;
const STREAM_EXT = /\.(m3u8|mpd)$/i;
// Pieces of a stream rather than a video: HLS/DASH segments, Vimeo's MSE ranges.
const SEGMENT = /\.(ts|m4s|m4a|aac|vtt)$|\/(range|segment|segments|chunk|frag)\/|[-_/](seg|segment|chunk|frag|init)[-_]?\d*\.(mp4|m4s|ts)$/i;

// Players whose pages yt-dlp knows how to resolve.
const EMBEDS: [provider: string, pattern: RegExp][] = [
  ['vimeo', /^(?:player\.)?vimeo\.com\/(?:video\/|channels\/[^/]+\/|groups\/[^/]+\/videos\/|showcase\/\d+\/video\/|album\/\d+\/video\/)?(\d{6,})(?:[/?#]|$)/i],
  ['youtube', /^(?:www\.|m\.)?(?:youtube(?:-nocookie)?\.com\/(?:embed\/|shorts\/|live\/|v\/|watch\?(?:.*&)?v=)|youtu\.be\/)([\w-]{11})/i],
  ['wistia', /^(?:fast\.)?wistia\.(?:com|net)\/(?:embed\/(?:iframe|medias)\/|medias\/)(\w{10})/i],
  ['wistia', /^[\w-]+\.wistia\.com\/medias\/(\w{10})/i],
  ['loom', /^(?:www\.)?loom\.com\/(?:share|embed)\/([0-9a-f]{32})/i],
  ['streamable', /^(?:www\.)?streamable\.com\/(?:e\/|o\/)?(\w{5,8})(?:[/?#]|$)/i],
  ['vidyard', /^(?:play|embed|video)\.vidyard\.com\/(?:watch\/)?([\w-]{16,})/i],
  ['dailymotion', /^(?:www\.dailymotion\.com\/(?:embed\/)?video\/|dai\.ly\/|geo\.dailymotion\.com\/player\.html\?video=)(\w+)/i],
  ['jwplayer', /^(?:cdn\.jwplayer\.com|content\.jwplatform\.com)\/(?:players|previews)\/(\w{8})/i],
  ['bunny', /^(?:iframe|player)\.mediadelivery\.net\/(?:embed|play)\/(\d+\/[\w-]+)/i],
  ['brightcove', /^players\.brightcove\.net\/\d+\/[\w-]+\/index\.html\?(?:.*&)?videoId=(\d+)/i],
  ['tiktok', /^(?:www\.)?tiktok\.com\/(?:@[\w.]+\/video|embed(?:\/v2)?)\/(\d+)/i],
  ['instagram', /^(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]{6,})/i],
];

// Hosted players we can turn straight into their stream.
const HOSTED_STREAMS: [provider: string, pattern: RegExp, manifest: (id: string) => string][] = [
  ['mux', /^(?:stream|player)\.mux\.com\/([A-Za-z0-9]{20,})/, (id) => `https://stream.mux.com/${id}.m3u8`],
  ['cloudflare', /^(?:iframe\.|watch\.)?(?:videodelivery\.net|[\w-]+\.cloudflarestream\.com)\/([0-9a-f]{32})/, (id) => `https://videodelivery.net/${id}/manifest/video.m3u8`],
];

// Where a direct file is hosted, for the record. Matched against the host.
const FILE_HOSTS: [provider: string, pattern: RegExp][] = [
  ['vimeo', /(^|\.)(vimeo\.com|vimeocdn\.com|akamaized\.net)$/],
  ['webflow', /(^|\.)(website-files\.com|webflow\.com)$/],
  ['framer', /(^|\.)framerusercontent\.com$/],
  ['squarespace', /(^|\.)squarespace(-cdn)?\.com$/],
  ['cargo', /(^|\.)cargo\.site$/],
  ['sanity', /(^|\.)sanity\.io$/],
  ['contentful', /(^|\.)ctfassets\.net$/],
  ['cloudinary', /(^|\.)cloudinary\.com$/],
  ['prismic', /(^|\.)prismic\.io$/],
  ['datocms', /(^|\.)datocms-assets\.com$/],
  ['shopify', /(^|\.)shopify\.com$/],
  ['storyblok', /(^|\.)storyblok\.com$/],
  ['wix', /(^|\.)wixstatic\.com$/],
  ['bunny', /(^|\.)b-cdn\.net$/],
  ['cloudfront', /(^|\.)cloudfront\.net$/],
  ['s3', /(^|\.)amazonaws\.com$/],
];

export const isSegment = (url: string) => {
  const u = parseUrl(url);
  return !!u && SEGMENT.test(safeDecode(u.pathname));
};

export function parseUrl(href: string, base?: string): URL | null {
  try {
    const u = new URL(href.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

export const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, '');

// Same site: the same host, give or take `www.`, or one of its subdomains.
export function sameSite(url: string | URL, root: URL): boolean {
  const u = typeof url === 'string' ? parseUrl(url) : url;
  if (!u) return false;
  const h = bareHost(u.hostname);
  const r = bareHost(root.hostname);
  return h === r || h.endsWith(`.${r}`);
}

const TRACKING = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|_ga|_gl|ref|hsCtaTracking)$/i;
const NOT_PAGE = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|rar|7z|dmg|exe|mp3|wav|aac|mp4|m4v|mov|webm|mkv|m3u8|mpd|css|js|mjs|json|xml|txt|rss|atom|woff2?|ttf|otf|eot)$/i;

// A crawlable page URL: no fragment, no tracking params, no trailing slash
// (except the root), or null for things that are not pages.
export function normalizePage(href: string, base?: string): string | null {
  const u = parseUrl(href, base);
  if (!u || NOT_PAGE.test(u.pathname)) return null;
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

export function classifyMedia(href: string, base?: string): MediaRef | null {
  const u = parseUrl(href, base);
  if (!u) return null;
  const host = u.hostname.toLowerCase();
  const path = safeDecode(u.pathname);
  const rest = host.replace(/^www\./, '') + u.pathname + u.search;
  // Placeholders left in templates and player configs (RFC 2606 names).
  if (/(^|\.)example\.(com|org|net)$/.test(host)) return null;

  // Vimeo's progressive files carry the video id; key them with the player
  // so the embed and its file land in one item.
  const vimeoFile = /vimeo\.com\/(?:external\/(\d+)|progressive_redirect\/playback\/(\d+))/.exec(host + u.pathname);
  if (vimeoFile) return { kind: 'file', provider: 'vimeo', key: `vimeo:${vimeoFile[1] ?? vimeoFile[2]}`, url: u.toString() };

  if (SEGMENT.test(path)) return null;
  // Mux's per-rendition playlists (one per quality and one for audio) hang
  // off a master on stream.mux.com that the player always loads first.
  if (/^manifest-[\w-]+\.(fastly\.)?mux\.com$/.test(host)) return null;
  // An image CDN rendering a still of the video (imgix/Sanity ?fm=jpg).
  if (/^(jpe?g|pjpg|png|webp|avif|gif)$/i.test(u.searchParams.get('fm') ?? '')) return null;
  if (STREAM_EXT.test(path)) {
    const hosted = HOSTED_STREAMS.find(([, p]) => p.test(rest));
    if (hosted) return { kind: 'stream', provider: hosted[0], key: `${hosted[0]}:${hosted[1].exec(rest)![1]}`, url: u.toString() };
    return { kind: 'stream', provider: fileProvider(host), key: fileKey(u), url: u.toString() };
  }
  if (FILE_EXT.test(path) || (/cloudinary\.com$/.test(host) && /\/video\/upload\//.test(path))) {
    return { kind: 'file', provider: fileProvider(host), key: fileKey(u), url: u.toString() };
  }
  for (const [provider, p, manifest] of HOSTED_STREAMS) {
    const m = p.exec(rest);
    if (m) return { kind: 'stream', provider, key: `${provider}:${m[1]}`, url: manifest(m[1]) };
  }
  for (const [provider, p] of EMBEDS) {
    const m = p.exec(rest);
    if (m) return { kind: 'embed', provider, key: `${provider}:${m[1]}`, url: provider === 'vimeo' ? vimeoPlayer(m[1], u) : u.toString() };
  }
  return null;
}

// Vimeo's page URLs (vimeo.com/<id>/<hash>) need a signed-in session to
// resolve now; the embeddable player form, with the unlisted hash as ?h=,
// does not.
function vimeoPlayer(id: string, u: URL): string {
  const hash = u.searchParams.get('h') ?? new RegExp(`/${id}/([0-9a-f]{6,})(?:[/?#]|$)`).exec(u.pathname + '/')?.[1];
  return `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ''}`;
}

function fileProvider(host: string): string | undefined {
  return FILE_HOSTS.find(([, p]) => p.test(host))?.[0];
}

// Signed CDN URLs differ only in their query, so the key ignores it.
const fileKey = (u: URL) => `${u.hostname.toLowerCase()}${u.pathname}`;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Names that are an upload's file name rather than a title
// ("_Copilot_HumanistAI_CS_01_Hero", "NIKE_AIR_final_v3_1080p", "14").
export function looksLikeFilename(t: string): boolean {
  const s = t.trim();
  return (
    /_.*_|^_|\.(mp4|mov|webm|m4v)$|\bv\d+\b|\bfinal\b|\d{3,4}p\b|\d{3,4}x\d{3,4}/i.test(s) ||
    (s.match(/\p{L}/gu) ?? []).length < 3 ||
    /^(untitled|video|vimeo video player|youtube video player)$/i.test(s)
  );
}

// Rough rank of how good a rendition a URL is, from the hints sites leave
// in filenames and <source media>. Higher is better; unknown sits mid-pack.
export function qualityScore(url: string, media?: string): number {
  const s = url.toLowerCase();
  let score = 600;
  const p = /(?:^|[^\d])(2160|1440|1080|720|540|480|360|240)p?(?:[^\d]|$)/.exec(s);
  if (p) score = Number(p[1]);
  else if (/(^|[^a-z])(4k|uhd)([^a-z]|$)/.test(s)) score = 2160;
  else if (/(^|[^a-z])(fhd|full|original|source|master)([^a-z]|$)/.test(s)) score = 1080;
  else if (/(^|[^a-z])(hd|high|large|desktop|hq)([^a-z]|$)/.test(s)) score = 900;
  else if (/(^|[^a-z])(sd|medium|med|tablet)([^a-z]|$)/.test(s)) score = 540;
  else if (/(^|[^a-z])(mobile|small|low|lq|preview|thumb|tiny|lite)([^a-z]|$)/.test(s)) score = 360;
  if (media && /max-width/.test(media)) score -= 500;
  if (/\.mp4(\?|$)/.test(s)) score += 1;
  return score;
}
