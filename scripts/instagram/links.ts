// The links in a creator's bio, read as plain HTML: the page's title, site
// name and description say who runs it ("Irakli — Motion Designer"), and a
// link-in-bio page (Linktree and the like) lists where else they are. No
// browser and no Claude: one polite request per link.

import { extractPage } from '../scrape/extract.ts';
import { Fetcher } from '../scrape/site.ts';
import { bareHost, parseUrl } from '../scrape/urls.ts';

export interface LinkPage {
  url: string;
  finalUrl?: string;
  status?: number;
  title?: string;
  siteName?: string;
  description?: string;
  h1?: string;
  // The opening of the page's visible text.
  text?: string;
  // Off-site links, for link-in-bio pages and portfolio homepages.
  links?: string[];
  // The site's own pages it links to: a portfolio's project pages.
  pages?: string[];
  // Why it wasn't read: a social network that needs a login or scripts,
  // an error, or a bot check.
  skipped?: string;
}

// Hosts that serve nothing useful to a plain request.
const SOCIAL = /(^|\.)(instagram\.com|facebook\.com|fb\.com|x\.com|twitter\.com|tiktok\.com|threads\.(net|com)|linkedin\.com|youtube\.com|youtu\.be|wa\.me|t\.me|discord\.gg|discord\.com|snapchat\.com|pinterest\.[a-z.]+)$/i;

// Link-in-bio services: their whole point is the list of links.
export const AGGREGATOR = /(^|\.)(linktr\.ee|beacons\.ai|bio\.link|lnk\.bio|linkin\.bio|bio\.site|tap\.bio|solo\.to|campsite\.bio|carrd\.co|msha\.ke|hoo\.be|stan\.store|withkoji\.com|koji\.to|komi\.io|snipfeed\.co|direct\.me|allmylinks\.com|linkbio\.co|flowcode\.com|later\.com|milkshake\.app|contactinbio\.com|lynk\.id|biolinky\.co|taplink\.cc|heylink\.me)$/i;

// One fetcher for the run: public addresses only (the URLs come from
// strangers' bios), small bodies, short timeouts.
const fetcher = new Fetcher(2, 1000, { publicOnly: true, maxBytes: 4 << 20, timeoutMs: 15_000 });

export function isSocial(url: string): boolean {
  const u = parseUrl(url);
  return !!u && SOCIAL.test(u.hostname);
}

export async function readLink(href: string): Promise<LinkPage> {
  const u = parseUrl(/^https?:\/\//i.test(href) ? href : `https://${href}`);
  if (!u) return { url: href, skipped: 'not a URL' };
  const url = u.toString();
  if (SOCIAL.test(u.hostname)) return { url, skipped: `${bareHost(u.hostname)} needs a login or scripts` };
  const res = await fetcher.page(url);
  if (res.blocked) return { url, finalUrl: res.url, status: res.status, skipped: 'bot check' };
  if (!res.html) return { url, finalUrl: res.url, status: res.status, skipped: res.error ?? `HTTP ${res.status}` };
  const ex = extractPage(res.html, res.url, 'static', res.status);
  const m = ex.meta;
  const home = parseUrl(res.url)?.hostname ?? u.hostname;
  const onSite = (l: string) => {
    const h = parseUrl(l)?.hostname;
    return !!h && bareHost(h) === bareHost(home);
  };
  const offsite = [...new Set(ex.links.filter((l) => !onSite(l)))];
  const own = [...new Set(ex.links.filter((l) => onSite(l) && parseUrl(l)!.pathname.length > 1))];
  const aggregator = AGGREGATOR.test(home);
  return {
    url,
    ...(res.url !== url ? { finalUrl: res.url } : {}),
    status: res.status,
    ...(m.title ? { title: m.title } : {}),
    ...(m.og.site_name ? { siteName: m.og.site_name } : {}),
    ...(m.description ?? m.og.description ? { description: m.description ?? m.og.description } : {}),
    ...(m.h1 ? { h1: m.h1 } : {}),
    ...(m.text ? { text: m.text.slice(0, aggregator ? 1500 : 800) } : {}),
    ...(offsite.length ? { links: offsite.slice(0, aggregator ? 40 : 15) } : {}),
    ...(own.length && !aggregator ? { pages: own.slice(0, 60) } : {}),
  };
}
