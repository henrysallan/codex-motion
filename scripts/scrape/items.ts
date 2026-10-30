// Candidates to items: every reference to the same video, from any page or
// tier, becomes one item. Its primary appearance is the most specific one
// (a <video> on a project page beats a homepage reel or a URL in inline
// JSON), and that page's metadata travels with the file.

import type { Appearance, Candidate, MediaKind, PageMeta, PageSummary, ScrapedItem, Tier } from './types.ts';
import { classifyMedia, qualityScore } from './urls.ts';
import { clean } from './extract.ts';

export interface ItemGroup {
  key: string;
  provider?: string;
  // Download order: players first (yt-dlp picks the best rendition and
  // brings metadata), then streams, then files best-first.
  urls: { url: string; kind: MediaKind }[];
  appearances: Candidate[];
  primary: Candidate;
  // The cheapest tier that saw it, from every appearance before the cap.
  foundBy: Tier;
}

const VIA_RANK: Record<string, number> = {
  'video-tag': 5, iframe: 5, 'player-id': 5, agent: 5,
  'data-attr': 4, 'json-ld': 4,
  link: 3, preload: 3, 'og:video': 3, 'twitter:player': 3,
  network: 2,
  'inline-json': 1,
};
const KIND_ORDER: Record<MediaKind, number> = { embed: 0, stream: 1, file: 2 };
const TIER_ORDER: Record<Tier, number> = { static: 0, render: 1, agent: 2 };
const MAX_APPEARANCES = 30;

export function groupItems(candidates: Candidate[]): ItemGroup[] {
  // How many videos each page mentions: fewer means a more specific page
  // (a project rather than the listing whose data names every project).
  const perPage = new Map<string, Set<string>>();
  for (const c of candidates) {
    let s = perPage.get(c.pageUrl);
    if (!s) perPage.set(c.pageUrl, (s = new Set()));
    s.add(c.key);
  }
  // How a video is referenced dominates; page specificity breaks ties.
  const score = (c: Candidate) => {
    const isRoot = new URL(c.pageUrl).pathname === '/';
    return (VIA_RANK[c.via] ?? 0) * 10_000 - Math.min(9_000, (perPage.get(c.pageUrl)?.size ?? 0) * 10) - (isRoot ? 500 : 0) + (c.context?.heading ? 1 : 0);
  };

  const groups: ItemGroup[] = [];
  const byKey = new Map<string, ItemGroup>();
  for (const c of candidates) {
    const keys = [c.key, ...(c.variants ?? []).map((v) => classifyMedia(v)?.key).filter((k): k is string => !!k)];
    let g = keys.map((k) => byKey.get(k)).find(Boolean);
    if (!g) {
      g = { key: c.key, provider: c.provider, urls: [], appearances: [], primary: c, foundBy: c.tier };
      groups.push(g);
    }
    for (const k of keys) byKey.set(k, g);
    g.provider ??= c.provider;
    if (TIER_ORDER[c.tier] < TIER_ORDER[g.foundBy]) g.foundBy = c.tier;
    g.appearances.push(c);
    for (const url of [c.url, ...(c.variants ?? [])]) {
      const kind = url === c.url ? c.kind : (classifyMedia(url)?.kind ?? c.kind);
      if (!g.urls.some((u) => u.url === url)) g.urls.push({ url, kind });
    }
  }
  for (const g of groups) {
    g.appearances.sort((a, b) => score(b) - score(a));
    g.primary = g.appearances[0];
    g.appearances = dedupeAppearances(g.appearances).slice(0, MAX_APPEARANCES);
    g.urls.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || qualityScore(b.url) - qualityScore(a.url));
    // Prefer the item's key to name a player-hosted video.
    if (g.urls[0].kind === 'embed') g.key = classifyMedia(g.urls[0].url)?.key ?? g.key;
  }
  return groups;
}

// One appearance per page and URL; the richest one when a page lists the
// same video twice (a <video> and the JSON that fed it).
function dedupeAppearances(list: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = `${c.pageUrl} ${c.key}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function pageSummary(m: PageMeta | undefined, url: string): PageSummary {
  if (!m) return { url };
  const s: PageSummary = {
    url,
    title: m.og.title ?? m.title,
    description: m.description,
    canonical: m.canonical,
    image: m.og.image ?? m.twitter.image,
    siteName: m.og.site_name,
    author: m.meta.author ?? m.meta['article:author'],
    published: m.meta['article:published_time'] ?? m.meta['date'] ?? m.meta['dc.date'],
    modified: m.meta['article:modified_time'] ?? m.og.updated_time,
    keywords: m.meta.keywords,
    lang: m.lang,
    h1: m.h1,
    jsonLd: m.jsonLd.length ? m.jsonLd : undefined,
  };
  for (const k of Object.keys(s) as (keyof PageSummary)[]) if (s[k] === undefined) delete s[k];
  return s;
}

const appearance = (c: Candidate): Appearance => ({
  pageUrl: c.pageUrl,
  url: c.url,
  tier: c.tier,
  via: c.via,
  ...(c.element ? { element: c.element } : {}),
  ...(c.poster ? { poster: c.poster } : {}),
  ...(c.context ? { context: c.context } : {}),
  ...(c.meta ? { meta: c.meta } : {}),
});

// The page a video is about. A video inside a card that links to another
// page on the site (a work-grid thumbnail, a "More projects" teaser) is
// that page's, as long as it never appears on a page of its own.
export function homePage(g: ItemGroup, pages: Map<string, unknown>): string {
  // Only placements in the markup count; a URL in a script or the network
  // log says nothing about which card it belongs to.
  const placed = g.appearances.filter((c) => c.element);
  if (!placed.length) return g.primary.pageUrl;
  const own = placed.find((c) => !c.context?.link || c.context.link.href === c.pageUrl);
  if (own) return own.pageUrl;
  const votes = new Map<string, number>();
  for (const c of g.appearances) {
    const href = c.context?.link?.href;
    if (href && pages.has(href)) votes.set(href, (votes.get(href) ?? 0) + 1);
  }
  return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? g.primary.pageUrl;
}

// A mirror of a page (a print or "machine" view whose canonical names
// another page) gives way to the page it names, when the video is on both
// or the two share a heading (the real page may load its player in script).
export function canonicalPage(g: ItemGroup, url: string, pages: Map<string, PageMeta>): string {
  const here = pages.get(url);
  const canon = here?.canonical;
  const there = canon && canon !== url ? pages.get(canon) : undefined;
  if (!canon || !here || !there) return url;
  return g.appearances.some((c) => c.pageUrl === canon) || (!!here.h1 && here.h1 === there.h1) ? canon : url;
}

export function toItem(g: ItemGroup, pages: Map<string, PageMeta>, site: ScrapedItem['site'], now: string): ScrapedItem {
  const home = canonicalPage(g, homePage(g, pages), pages);
  const page = pages.get(home);
  return {
    key: g.key,
    status: 'found',
    foundBy: g.foundBy,
    ...titleFor(g, page),
    media: {
      urls: g.urls.map((u) => u.url),
      kind: g.urls[0].kind,
      ...(g.provider ? { provider: g.provider } : {}),
    },
    page: pageSummary(page, home),
    appearances: g.appearances.map(appearance),
    site,
    firstSeenAt: now,
    scrapedAt: now,
  };
}

// "Aurora — Fixture Studio" → "Aurora", when the suffix is the site's name.
export function stripSiteName(title: string, siteName?: string): string {
  const t = title.trim();
  if (!siteName) return t;
  const esc = siteName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return t.replace(new RegExp(`\\s*[|—–\\-:·]\\s*${esc}\\s*$`, 'i'), '').replace(new RegExp(`^${esc}\\s*[|—–\\-:·]\\s*`, 'i'), '').trim() || t;
}

// The video's own name where the page gives one, else the page's.
function titleFor(g: ItemGroup, page: PageMeta | undefined): Pick<ScrapedItem, 'title' | 'titleSource'> {
  for (const c of g.appearances) {
    const json = (c.meta?.json ?? {}) as Record<string, unknown>;
    const ld = (c.meta?.jsonLd ?? {}) as Record<string, unknown>;
    const named = c.context?.heading ?? [json.title, json.name, ld.name].find((v): v is string => typeof v === 'string' && !!v.trim());
    if (named) return { title: clean(named, 160), titleSource: 'context' };
  }
  // og:title is the page's own name; <title> usually carries the site's too
  // (named by og:site_name, else often by its host: "Shot | basement.studio").
  // "Behind the Ship | Blog" over an h1 of "Behind the Ship" adds a section.
  const siteName = page?.og.site_name ?? (page?.url ? new URL(page.url).hostname.replace(/^www\./, '') : undefined);
  const og = page?.og.title && stripSiteName(page.og.title, siteName);
  const h1 = page?.h1;
  const named = og && h1 && og.startsWith(h1) && /^\s*[|—–\-:·]\s*\S/.test(og.slice(h1.length)) ? h1 : og;
  const fromPage = page && (named || page.h1 || stripSiteName(page.title ?? '', siteName));
  if (fromPage) return { title: clean(fromPage, 160), titleSource: 'page' };
  const last = new URL(g.urls[0].url).pathname.split('/').filter(Boolean).pop() ?? g.key;
  return { title: clean(decodeURIComponent(last).replace(/\.\w+$/, ''), 160), titleSource: 'url' };
}
