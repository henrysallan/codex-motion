// Static extraction: one HTML document in, the page's metadata, every video
// reference it holds, its links, and signals for whether it is worth a
// headless-Chrome visit. The same function runs on HTML as served and on
// the DOM after rendering, so both tiers see videos the same way.
//
// Extractors, roughly in order of how much context they carry:
//   video-tag    <video src> / <source>, including lazy data-* sources
//   iframe       player iframes (Vimeo, YouTube, Wistia, Mux, ...)
//   player-id    data-vimeo-id, <lite-youtube videoid>, Plyr embed ids
//   img-gif      animated GIFs in <img>, <picture> and CSS backgrounds
//   data-attr    any attribute holding a media URL (Webflow data-video-urls, ...)
//   link         <a href> to a file or a player page
//   og:video     og:video / twitter:player:stream
//   json-ld      schema.org VideoObject contentUrl / embedUrl
//   inline-json  media URLs in inline scripts (__NEXT_DATA__, Framer, Nuxt, ...),
//                with the sibling fields of the object that held them

import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import { type AnyNode, type Element, isTag, isText } from 'domhandler';
import type { Candidate, PageMeta, PageSignals, Tier, VideoContext } from './types.ts';
import { classifyMedia, looksLikeFilename, normalizePage, parseUrl, qualityScore } from './urls.ts';

export interface Extracted {
  meta: PageMeta;
  candidates: Candidate[];
  links: string[];
  signals: PageSignals;
}

const HEADINGS = 'h1,h2,h3,h4,h5,h6';
const PLAYER_HINT = /(^|[-_\s])(video|videos|player|vimeo|youtube|plyr|vjs|video-js|jwplayer|mux|wistia|reel|showreel)($|[-_\s])/i;
const KEEP_ATTRS = new Set(['src', 'autoplay', 'loop', 'muted', 'playsinline', 'controls', 'preload', 'poster', 'width', 'height', 'title', 'aria-label', 'alt', 'id', 'class', 'type', 'allow']);
const MEDIA_HINT = /\.(mp4|m4v|mov|webm|m3u8|mpd|gif)|vimeo|youtu|wistia|mux\.com|videodelivery|cloudflarestream|loom\.com|streamable|vidyard|mediadelivery|jwplayer|jwplatform/i;
// Keys that label a video rather than locate it: players put the file's
// name in a title ("Reel-1080.mp4"), which isn't a URL relative to the page.
const LABEL_KEY = /^(title|name|alt|caption|label|file_?name|description)$/i;
const MORE = /^(load|show|see|view) (more|all)\b|^more (work|projects)\b|^next page$/i;
const SKIP_TEXT = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'video', 'audio', 'canvas']);
const INLINE = new Set(['b', 'i', 'em', 'strong', 'u', 'sup', 'sub', 'small', 'mark', 'abbr', 'code', 'wbr']);

export function clean(s: string | undefined | null, max = 400): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Text of a node with a space between elements, so "<h3>Title</h3><p>Client</p>"
// reads "Title Client" rather than cheerio's "TitleClient".
export function textOf(node: AnyNode, limit = 20_000): string {
  const parts: string[] = [];
  let size = 0;
  const walk = (n: AnyNode) => {
    if (size > limit) return;
    if (isText(n)) {
      parts.push(n.data);
      size += n.data.length;
    } else if (isTag(n)) {
      if (SKIP_TEXT.has(n.name) || n.attribs.hidden !== undefined || n.attribs['aria-hidden'] === 'true') return;
      const sep = !INLINE.has(n.name);
      if (sep) parts.push(' ');
      for (const c of n.children) walk(c);
      if (sep) parts.push(' ');
    } else if ('children' in n) {
      for (const c of n.children) walk(c);
    }
  };
  walk(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

const unescapeJs = (s: string) =>
  s.replace(/\\u002[Ff]/g, '/').replace(/\\u0026/g, '&').replace(/\\u003[Dd]/g, '=').replace(/\\\//g, '/').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

const ABS_URL = /(?:https?:)?\/\/[^\s"'<>\\()`{}|^]+/g;
const REL_MEDIA = /(?:^|[\s"'(,=])((?:\.{1,2}\/|\/)?[\w\-./%~]+\.(?:mp4|m4v|mov|webm|m3u8|mpd|gif)(?:\?[^\s"'<>]*)?)(?=$|[\s"'),])/gi;
const GIF = /\.gif(?:[?#\s]|$)/i;

// The URLs of a srcset, largest first (by width or density descriptor).
export function srcsetUrls(srcset: string): string[] {
  return srcset
    .split(/,\s+/)
    .map((part) => {
      const [url, size = '1x'] = part.trim().split(/\s+/);
      return { url, n: parseFloat(size) * (size.endsWith('x') ? 10_000 : 1) };
    })
    .filter((e) => e.url)
    .sort((a, b) => b.n - a.n)
    .map((e) => e.url);
}

// URL-looking substrings of an attribute value or script. Bare relative
// names ("reel.mp4") are only trusted in attributes; in scripts a relative
// path must start with a slash or dot.
export function mediaUrlsIn(text: string, allowBare: boolean): string[] {
  // A comma straight before another URL separates a list (Webflow's
  // data-video-urls); other commas belong to the URL (Cloudinary transforms).
  const t = unescapeJs(text).replace(/,(?=\s*(?:https?:)?\/\/)/g, ' ');
  const out = new Set<string>();
  for (const m of t.matchAll(ABS_URL)) out.add(m[0].replace(/[.,;:]+$/, ''));
  // Relative paths only from what is left once absolute URLs are taken out.
  for (const m of t.replace(ABS_URL, ' ').matchAll(REL_MEDIA)) if (allowBare || /^[./]/.test(m[1])) out.add(m[1]);
  return [...out];
}

// Media URLs held in one attribute value. JSON values (a player's
// data-sources list) are parsed and their strings taken whole: real URLs
// can hold spaces ("file.mp4 (1080p).mp4") that a regex would cut at.
export function urlsInAttr(value: string): string[] {
  if (/^\s*[[{]/.test(value)) {
    try {
      const out: string[] = [];
      walkJson(JSON.parse(value), (obj) => {
        for (const [k, v] of Object.entries(obj)) if (typeof v === 'string' && v.length < 2000 && !LABEL_KEY.test(k) && MEDIA_HINT.test(v)) out.push(v);
      });
      return out;
    } catch {
      // Not JSON; fall through.
    }
  }
  return mediaUrlsIn(value, true);
}

function attrsOf(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(el.attribs ?? {})) {
    if (KEEP_ATTRS.has(k) || k.startsWith('data-')) out[k] = v === '' ? 'true' : clean(v, 300);
  }
  return out;
}

type Extra = Omit<Partial<Candidate>, 'context'> & { context?: Omit<VideoContext, 'index'> };

// Collects one page's candidates, merging references to the same video.
class PageCollector {
  readonly list: Candidate[] = [];
  readonly #byKey = new Map<string, Candidate>();
  readonly pageUrl: string;
  readonly base: string;
  readonly tier: Tier;

  constructor(pageUrl: string, base: string, tier: Tier) {
    this.pageUrl = pageUrl;
    this.base = base;
    this.tier = tier;
  }

  add(href: string, via: string, extra: Extra = {}): Candidate | null {
    const ref = classifyMedia(href, this.base);
    if (!ref) return null;
    const variants = (extra.variants ?? []).filter((v) => v !== ref.url);
    const found = this.#byKey.get(ref.key) ?? variants.map((v) => this.#byKey.get(classifyMedia(v)?.key ?? '')).find(Boolean);
    if (found) {
      // A GIF's resized copies share its key but are different files: keep them as fallbacks.
      if (ref.url !== found.url && GIF.test(ref.url) && !found.variants?.includes(ref.url)) found.variants = [...(found.variants ?? []), ref.url];
      found.element ??= extra.element;
      found.poster ??= extra.poster;
      if (extra.context && !found.context?.heading && !found.context?.text) found.context = { ...extra.context, index: found.context?.index ?? 0 };
      if (variants.length) found.variants = [...new Set([...(found.variants ?? []), ...variants])];
      if (extra.meta) found.meta = { ...extra.meta, ...found.meta };
      this.#byKey.set(ref.key, found);
      return found;
    }
    const c: Candidate = {
      url: ref.url,
      kind: ref.kind,
      key: ref.key,
      provider: ref.provider,
      pageUrl: this.pageUrl,
      tier: this.tier,
      via,
      element: extra.element,
      poster: extra.poster,
      context: { ...extra.context, index: this.list.length },
      variants: variants.length ? variants : undefined,
      meta: extra.meta,
    };
    this.list.push(c);
    this.#byKey.set(ref.key, c);
    for (const v of variants) {
      const k = classifyMedia(v)?.key;
      if (k && !this.#byKey.has(k)) this.#byKey.set(k, c);
    }
    return c;
  }
}

export function extractPage(html: string, pageUrl: string, tier: Tier, status = 200): Extracted {
  const $ = load(html);
  const base = parseUrl($('base[href]').attr('href') ?? '', pageUrl)?.toString() ?? pageUrl;
  const found = new PageCollector(pageUrl, base, tier);
  const abs = (v: string | undefined) => (v ? (parseUrl(v, base)?.toString() ?? undefined) : undefined);
  const meta = pageMeta($, pageUrl, status, abs);
  const ctx = (el: Element) => contextOf($, el, base);
  let unresolvedVideos = 0;

  // <video> and its <source>s. All renditions of one element are one video.
  $('video').each((_, el) => {
    const v = $(el);
    const sources: { url: string; type?: string; media?: string }[] = [];
    const push = (raw: string | undefined, type?: string, media?: string) => {
      if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) return;
      const url = abs(raw.trim());
      if (url && classifyMedia(url) && !sources.some((s) => s.url === url)) sources.push({ url, ...(type ? { type } : {}), ...(media ? { media } : {}) });
    };
    if (el.attribs.src) push(el.attribs.src);
    for (const [k, val] of Object.entries(el.attribs)) if (k.startsWith('data-') && MEDIA_HINT.test(val)) for (const u of urlsInAttr(val)) push(u);
    v.find('source').each((_, s) => {
      push(s.attribs.src ?? s.attribs['data-src'] ?? s.attribs['data-lazy-src'], s.attribs.type, s.attribs.media);
    });
    if (!sources.length) {
      unresolvedVideos++;
      return;
    }
    const ranked = [...sources].sort((a, b) => qualityScore(b.url, b.media) - qualityScore(a.url, a.media));
    const poster = abs(el.attribs.poster ?? el.attribs['data-poster']);
    found.add(ranked[0].url, 'video-tag', {
      element: { tag: 'video', attrs: attrsOf(el), sources },
      poster,
      context: ctx(el),
      variants: ranked.slice(1).map((s) => s.url),
    });
  });

  $('iframe').each((_, el) => {
    for (const k of ['src', 'data-src', 'data-lazy-src', 'data-url']) {
      const src = el.attribs[k];
      if (!src) continue;
      const url = parseUrl(src, base);
      found.add(src, 'iframe', {
        element: { tag: 'iframe', attrs: attrsOf(el) },
        context: ctx(el),
        meta: url && url.search ? { params: Object.fromEntries([...url.searchParams].slice(0, 20)) } : undefined,
      });
    }
  });

  // Players that keep only an id in the markup.
  $('[data-vimeo-id],[data-vimeo-url],[data-youtube-id],[data-yt-id],lite-youtube[videoid],lite-vimeo[videoid],[data-plyr-embed-id]').each((_, el) => {
    const a = el.attribs;
    const provider = a['data-plyr-provider'] ?? (el.name === 'lite-youtube' || a['data-youtube-id'] || a['data-yt-id'] ? 'youtube' : 'vimeo');
    const id = a['data-vimeo-id'] ?? a['data-youtube-id'] ?? a['data-yt-id'] ?? a.videoid ?? a['data-plyr-embed-id'];
    const url = a['data-vimeo-url'] ?? (/^https?:/.test(id ?? '') ? id : id && (provider === 'youtube' ? `https://www.youtube.com/watch?v=${id}` : `https://vimeo.com/${id}`));
    if (url) found.add(url, 'player-id', { element: { tag: el.name, attrs: attrsOf(el) }, context: ctx(el) });
  });

  // Animated GIFs. One element's sizes are one GIF, largest first; the
  // downloader drops stills and icons once it can read the file.
  $('img, picture source, [style*=".gif"]').each((_, el) => {
    const a = el.attribs;
    const urls: string[] = [];
    for (const k of ['srcset', 'data-srcset']) if (a[k] && GIF.test(a[k])) urls.push(...srcsetUrls(a[k]).filter((u) => GIF.test(u)));
    for (const k of ['data-src', 'data-lazy-src', 'data-original', 'src']) if (a[k] && GIF.test(a[k].trim())) urls.push(a[k].trim());
    for (const m of (a.style ?? '').matchAll(/url\(\s*['"]?([^'")]+?\.gif(?:\?[^'")]*)?)['"]?\s*\)/gi)) urls.push(m[1]);
    const unique = [...new Set(urls.map((u) => abs(u)).filter((u): u is string => !!u && !!classifyMedia(u)))];
    if (unique.length) found.add(unique[0], 'img-gif', { element: { tag: el.name, attrs: attrsOf(el) }, context: ctx(el), variants: unique.slice(1) });
  });

  // Any other attribute that holds a media URL.
  $('*').each((_, el) => {
    if (!isTag(el)) return;
    if (el.name === 'video' || el.name === 'source' || el.name === 'iframe' || el.name === 'script' || el.name === 'style' || el.name === 'meta') return;
    if (el.name === 'link' && el.attribs.as !== 'video') return;
    for (const [k, val] of Object.entries(el.attribs)) {
      if ((k === 'href' && el.name === 'a') || k === 'srcset' || k === 'style' || !MEDIA_HINT.test(val)) continue;
      for (const url of urlsInAttr(val)) {
        found.add(url, el.name === 'link' ? 'preload' : 'data-attr', {
          element: { tag: el.name, attrs: attrsOf(el) },
          poster: abs(el.attribs['data-poster-url'] ?? el.attribs['data-poster']),
          context: ctx(el),
        });
      }
    }
  });

  $('a[href]').each((_, el) => {
    if (!MEDIA_HINT.test(el.attribs.href)) return;
    found.add(el.attribs.href, 'link', { element: { tag: 'a', attrs: { ...attrsOf(el), href: el.attribs.href } }, context: ctx(el) });
  });

  for (const k of ['video:secure_url', 'video:url', 'video']) {
    if (meta.og[k]) found.add(meta.og[k], 'og:video', { meta: pick(meta.og, ['video:type', 'video:width', 'video:height', 'title', 'description', 'image']) });
  }
  for (const k of ['player:stream', 'player']) {
    if (meta.twitter[k]) found.add(meta.twitter[k], 'twitter:player', { meta: pick(meta.twitter, ['player:width', 'player:height', 'title', 'description']) });
  }

  walkJson(meta.jsonLd, (obj) => {
    const type = [obj['@type']].flat().map(String);
    const isVideo = type.includes('VideoObject') || 'contentUrl' in obj || 'embedUrl' in obj;
    if (!isVideo) return;
    const ld = pick(obj, ['name', 'description', 'uploadDate', 'duration', 'thumbnailUrl', 'creator', 'author', 'keywords', 'datePublished', 'width', 'height']);
    for (const k of ['contentUrl', 'embedUrl', 'url']) {
      const v = obj[k];
      if (typeof v === 'string') found.add(v, 'json-ld', { context: { heading: typeof obj.name === 'string' ? clean(obj.name, 200) : undefined }, meta: { jsonLd: ld } });
    }
  });

  // Inline data: parse JSON where we can so each URL keeps its neighbours
  // (a project's title, client, slug), else fall back to a regex.
  $('script:not([src])').each((_, el) => {
    const type = (el.attribs.type ?? '').toLowerCase();
    if (type.includes('ld+json')) return;
    const body = $(el).text();
    if (body.length < 20 || body.length > 8e6 || !MEDIA_HINT.test(body)) return;
    if (type.includes('json') || /^\s*[{[]/.test(body)) {
      try {
        walkJson(JSON.parse(body), (obj) => {
          for (const [k, v] of Object.entries(obj)) {
            if (typeof v !== 'string' || v.length > 2000 || LABEL_KEY.test(k) || !MEDIA_HINT.test(v)) continue;
            found.add(v, 'inline-json', Array.isArray(obj) ? {} : { meta: { json: scalars(obj) } });
          }
        });
        return;
      } catch {
        // Not JSON after all; scan it as text.
      }
    }
    for (const url of mediaUrlsIn(body, false)) found.add(url, 'inline-json');
  });

  const links = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = el.attribs.href;
    if (/^(mailto|tel|javascript|data):/i.test(href)) return;
    const page = normalizePage(href, base);
    if (page) links.add(page);
  });

  let playerHints = 0;
  $('[class],[id]').each((_, el) => {
    if (playerHints < 50 && PLAYER_HINT.test(`${el.attribs.class ?? ''} ${el.attribs.id ?? ''}`)) playerHints++;
  });
  const moreButton = $('button, [role="button"], a:not([href]), a[href="#"], a[href^="javascript:"]')
    .toArray()
    .some((el) => MORE.test(clean(textOf(el), 80)));
  const scripts = $('script').length;
  const textLength = meta.text.length;
  return {
    meta,
    candidates: found.list,
    links: [...links],
    signals: { videoTags: $('video').length, unresolvedVideos, playerHints, moreButton, textLength, scripts, shell: textLength < 250 && scripts >= 3 },
  };
}

// Whether the HTML as served may be hiding videos that only appear once
// scripts run: a client-rendered shell, <video>s without a visible source,
// or player-ish markup that yielded nothing.
export function wantsRender(signals: PageSignals, candidates: number): boolean {
  return signals.shell || signals.unresolvedVideos > 0 || (signals.playerHints > 0 && candidates === 0);
}

// Why a page may still hide video after the scripted passes, for the agent
// tier; empty when nothing suggests it. A few sourceless <video>s beside
// plenty of found videos are usually a player's spare elements (Koto keeps
// empty placeholders next to its Vimeo embeds); more of them than videos
// found is a real gap. A "Load more" control or player-ish markup on most
// pages is site chrome (a related-projects strip, a template class), so
// callers pass moreIsChrome / hintsAreChrome for all but the listing page.
export function agentReasons(s: PageSignals, found: number, { moreIsChrome = false, hintsAreChrome = false } = {}): string[] {
  const why: string[] = [];
  if (s.unresolvedVideos > found) why.push(`${s.unresolvedVideos} <video> without a visible source`);
  if (s.moreButton && !moreIsChrome) why.push('a "Load more"-style control');
  if (s.playerHints && !found && !hintsAreChrome) why.push('player markup but no video found');
  return why;
}

function pageMeta($: CheerioAPI, url: string, status: number, abs: (v: string | undefined) => string | undefined): PageMeta {
  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  const meta: Record<string, string> = {};
  $('meta').each((_, el) => {
    const k = (el.attribs.property ?? el.attribs.name ?? el.attribs.itemprop ?? '').trim().toLowerCase();
    const v = el.attribs.content;
    if (!k || v == null || !v.trim()) return;
    if (k.startsWith('og:')) og[k.slice(3)] ??= clean(v, 2000);
    else if (k.startsWith('twitter:')) twitter[k.slice(8)] ??= clean(v, 2000);
    else if (!/^(viewport|theme-color|format-detection|msapplication|apple-|google-site|robots|googlebot|referrer|color-scheme|csrf|_token)/.test(k)) meta[k] ??= clean(v, 1000);
  });
  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed: unknown = JSON.parse($(el).text());
      jsonLd.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // Malformed JSON-LD is common; skip it.
    }
  });
  const body = $('body').get(0);
  return {
    url,
    status,
    title: clean($('title').first().text(), 300) || undefined,
    description: meta.description ?? og.description,
    canonical: abs($('link[rel="canonical"]').attr('href')),
    lang: $('html').attr('lang'),
    h1: clean($('h1').first().text(), 300) || undefined,
    generator: meta.generator,
    og,
    twitter,
    meta,
    jsonLd,
    text: body ? clean(textOf(body, 40_000), 12_000) : '',
  };
}

// What surrounds a video: the smallest ancestor with any text (usually the
// project card: title, client, year), its heading, a figure caption, and
// the link the card points at.
function contextOf($: CheerioAPI, el: Element, base: string): Omit<VideoContext, 'index'> {
  const ctx: Omit<VideoContext, 'index'> = {};
  // An element's own label; a player iframe's title is often the upload's file name.
  const label = clean(el.attribs?.title ?? el.attribs?.['aria-label'] ?? el.attribs?.alt, 200);
  const own = label && !looksLikeFilename(label) ? label : '';
  let node: Cheerio<AnyNode> = $(el);
  let box: Cheerio<AnyNode> | null = null;
  for (let depth = 0; depth < 8; depth++) {
    const parent = node.parent();
    const p = parent.get(0);
    if (!p || parent.is('body,html')) break;
    const t = textOf(p, 4000);
    if (t.length > 1500) break;
    node = parent;
    // Any text at all: a card may hold only its title.
    if (t.replace(/\W/g, '').length >= 3) {
      box = parent;
      // Player chrome ("unmute unmute unmute") isn't context.
      const words = t.toLowerCase().split(/\s+/);
      if (new Set(words).size > 2 || words.length <= 3) ctx.text = clean(t);
      break;
    }
  }
  const fig = $(el).closest('figure').find('figcaption').first().get(0);
  if (fig) ctx.caption = title(textOf(fig)) || undefined;
  // The video's own name lives inside its card: a heading, a title-ish
  // element, or a caption. A heading above the card names the section.
  if (box) {
    const h = box.find(HEADINGS).first();
    const named = h.length ? h : box.find('[class*="title" i],[class*="name" i],[class*="caption" i]').first();
    const n = named.get(0);
    if (n) ctx.heading = title(textOf(n)) || undefined;
  }
  ctx.heading ??= ctx.caption ?? (own || undefined);
  const section = precedingHeading($, el);
  if (section && section !== ctx.heading) ctx.section = section;
  const a = $(el).closest('a[href]').first();
  const link = a.length ? a : box?.find('a[href]').first();
  const href = link?.attr('href');
  const page = href ? normalizePage(href, base) : null;
  const linkText = link?.get(0) ? clean(textOf(link.get(0)!), 200) : '';
  if (link && page) ctx.link = { href: page, ...(linkText ? { text: linkText } : {}) };
  return ctx;
}

// A display title: trimmed, without a dangling separator ("Wabi —").
const title = (s: string) => clean(s, 200).replace(/[\s—–\-|·:,/]+$/u, '');

function precedingHeading($: CheerioAPI, el: Element): string | undefined {
  let node: Cheerio<AnyNode> = $(el);
  for (let depth = 0; depth < 10 && node.length && !node.is('body'); depth++) {
    let sib = node.prev();
    for (let steps = 0; sib.length && steps < 30; steps++) {
      const h = sib.is(HEADINGS) ? sib : sib.find(HEADINGS).last();
      const n = h.get(0);
      if (n) {
        const t = clean(textOf(n), 200);
        if (t) return t;
      }
      sib = sib.prev();
    }
    node = node.parent();
  }
  return undefined;
}

type Json = Record<string, unknown>;

function walkJson(root: unknown, visit: (obj: Json) => void): void {
  let budget = 300_000;
  const walk = (v: unknown, depth: number) => {
    if (--budget < 0 || depth > 60 || v === null || typeof v !== 'object') return;
    // Arrays are visited too: a list of URLs has no object around it.
    visit(v as Json);
    for (const x of Object.values(v as Json)) walk(x, depth + 1);
  };
  walk(root, 0);
}

// The short scalar fields of an object: a title, slug, client name or
// date next to a video URL is the best metadata inline JSON offers.
function scalars(obj: Json): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (n >= 24 || k.startsWith('__')) continue;
    if ((typeof v === 'string' && v.length <= 300) || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
      n++;
    }
  }
  return out;
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== '') out[k] = obj[k];
  return out;
}

