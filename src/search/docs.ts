// How one asset becomes search text and facets: the page it came from
// (shared by every clip on that page) and its own doc. The index builder
// (scripts/search-index.ts) runs this over the library; the app runs it live
// for uploads shared to the Feed, which the bundle doesn't cover.

import type { Asset, AssetSource } from '../media/library.ts';
import type { SearchDoc, SearchPage } from './bundle.ts';
import type { PoolDoc } from './engine.ts';
import { classify, PROJECT_TYPES, SECTORS, splitStudios, yearOf } from './taxonomy.ts';

// Sites that host other people's work. A clip linked from one was made by
// whoever the page credits, not by the site, so the site isn't its studio.
const PLATFORMS: Record<string, string> = {
  'vimeo.com': 'Vimeo',
  'youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'instagram.com': 'Instagram',
  'x.com': 'X',
  'twitter.com': 'X',
  'threads.net': 'Threads',
  'tiktok.com': 'TikTok',
  'linkedin.com': 'LinkedIn',
  'behance.net': 'Behance',
  'dribbble.com': 'Dribbble',
  'artstation.com': 'ArtStation',
  'pinterest.com': 'Pinterest',
  'are.na': 'Are.na',
};

const platformOf = (host: string) => Object.keys(PLATFORMS).find((p) => host === p || host.endsWith(`.${p}`));

export const isPlatform = (host: string) => !!platformOf(host);

// A site's name when nothing better is known: the platform's own name, else
// the host's first label ("portorocha.com" -> "Portorocha").
export function hostLabel(host: string): string {
  const platform = platformOf(host);
  if (platform) return PLATFORMS[platform];
  const base = host.replace(/^www\./, '').split('.')[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function searchPage(src: AssetSource, siteName: string): SearchPage {
  const seen = new Set<string>();
  const tags = (src.tags ?? []).map((t) => t.trim()).filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
  const studios = [...new Set([...(isPlatform(src.site) ? [] : [siteName]), ...splitStudios(src.agency)])];
  const year = yearOf(src.year);
  return {
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
}

// `page` indexes the bundle's pages (-1: none).
export function searchDoc(a: Asset, page: number): SearchDoc {
  return {
    id: a.id,
    title: a.source?.title || a.name,
    page,
    ...(a.analysis?.caption ? { caption: a.analysis.caption } : {}),
    tags: a.analysis?.tags ?? [],
    duration: a.duration,
    width: a.width,
    height: a.height,
    added: a.source ? Math.round(Date.parse(a.source.scrapedAt) / 1000) || 0 : 0,
  };
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// A site's name from one source: what the page called it, else a credited
// studio that spells the host ("Studio Dumbar" for studiodumbar.com), else
// the host. The index builder also looks across the whole library.
export function siteNameOf(src: AssetSource): string {
  if (src.siteName) return src.siteName;
  const base = squash(src.site.replace(/^www\./, '').split('.')[0]);
  return splitStudios(src.agency).find((name) => squash(name) === base) ?? hostLabel(src.site);
}

// An upload shared to the Feed, as the search worker takes it. `added` is
// when it was uploaded (seconds), for "Newest"; `title` stands in until a
// source names it.
export function uploadDoc(a: Asset, added: number, title: string): PoolDoc {
  const src = a.source;
  const siteName = src ? siteNameOf(src) : '';
  return {
    rev: `${src?.scrapedAt ?? ''}|${a.analysis?.at ?? ''}`,
    doc: { ...searchDoc(a, -1), title: src?.title || title, added },
    page: src ? searchPage(src, siteName) : null,
    siteName,
  };
}
