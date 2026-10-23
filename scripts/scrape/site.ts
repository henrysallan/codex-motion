// Polite HTTP for the crawler: a per-run request pool with a minimum gap
// between requests, robots.txt rules, sitemap discovery and bot-challenge
// detection. A challenged page is reported, never worked around.

import { normalizePage, parseUrl, sameSite } from './urls.ts';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const MAX_HTML_BYTES = 8 << 20;
const CHALLENGE = /cf-chl|challenge-platform|cf_chl_opt|just a moment\.\.\.|attention required|captcha|are you a robot|px-captcha|datadome|verify you are human/i;

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  html?: string;
  blocked?: boolean;
  error?: string;
}

export class Fetcher {
  #active = 0;
  #waiting: (() => void)[] = [];
  #lastStart = 0;
  readonly concurrency: number;
  delayMs: number;

  constructor(concurrency: number, delayMs: number) {
    this.concurrency = concurrency;
    this.delayMs = delayMs;
  }

  async #slot<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.concurrency) await new Promise<void>((r) => this.#waiting.push(r));
    this.#active++;
    const wait = this.#lastStart + this.delayMs - Date.now();
    this.#lastStart = Math.max(Date.now(), this.#lastStart + this.delayMs);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await task();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }

  get(url: string, accept = 'text/html,application/xhtml+xml,*/*;q=0.8'): Promise<Response> {
    return this.#slot(() =>
      fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept, 'accept-language': 'en-US,en;q=0.9' },
        redirect: 'follow',
        signal: AbortSignal.timeout(25_000),
      }),
    );
  }

  async page(url: string): Promise<FetchedPage> {
    try {
      const res = await this.get(url);
      const contentType = res.headers.get('content-type') ?? '';
      const len = Number(res.headers.get('content-length') ?? 0);
      if (!/html|xml/i.test(contentType) || len > MAX_HTML_BYTES) {
        await res.body?.cancel();
        return { url: res.url || url, status: res.status, contentType };
      }
      const html = await res.text();
      const blocked = (res.status === 403 || res.status === 429 || res.status === 503) && CHALLENGE.test(html.slice(0, 20_000));
      return { url: res.url || url, status: res.status, contentType, html: blocked ? undefined : html, blocked };
    } catch (e) {
      return { url, status: 0, contentType: '', error: (e as Error).message };
    }
  }

  async text(url: string): Promise<string | null> {
    try {
      const res = await this.get(url, 'text/plain,application/xml,text/xml,*/*;q=0.5');
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      return await res.text();
    } catch {
      return null;
    }
  }
}

export function isChallenge(html: string): boolean {
  return CHALLENGE.test(html.slice(0, 20_000)) && html.length < 200_000;
}

// ---- robots.txt ------------------------------------------------------------------

export interface Robots {
  allowed(url: string): boolean;
  crawlDelay?: number;
  sitemaps: string[];
}

interface Rule {
  allow: boolean;
  pattern: RegExp;
  length: number;
}

// The rules for `*`: we don't claim a crawler name of our own. Longest
// matching rule wins and Allow wins a tie, per RFC 9309.
export function parseRobots(text: string): Robots {
  const sitemaps: string[] = [];
  const rules: Rule[] = [];
  let crawlDelay: number | undefined;
  let agents: string[] = [];
  let inRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
      continue;
    }
    // A crawl-delay before any group applies to everyone.
    if (field === 'crawl-delay' && !agents.length) {
      crawlDelay ??= Number(value) || undefined;
      continue;
    }
    inRules = true;
    if (!agents.includes('*')) continue;
    if (field === 'crawl-delay') crawlDelay = Number(value) || undefined;
    else if ((field === 'allow' || field === 'disallow') && value) {
      // `*` is a wildcard and a trailing `$` anchors the end; the rest is literal.
      const body = value.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      rules.push({ allow: field === 'allow', pattern: new RegExp(`^${body}`), length: value.length });
    }
  }
  return {
    sitemaps,
    crawlDelay,
    allowed(url: string) {
      const u = parseUrl(url);
      if (!u) return false;
      const target = u.pathname + u.search;
      let best: Rule | null = null;
      for (const r of rules) {
        if (!r.pattern.test(target)) continue;
        if (!best || r.length > best.length || (r.length === best.length && r.allow)) best = r;
      }
      return !best || best.allow;
    },
  };
}

export async function loadRobots(fetcher: Fetcher, root: URL): Promise<Robots> {
  const text = await fetcher.text(new URL('/robots.txt', root).toString());
  return parseRobots(text ?? '');
}

// ---- sitemaps --------------------------------------------------------------------

// Page URLs from the site's sitemaps, following sitemap indexes a level or two.
export async function sitemapPages(fetcher: Fetcher, root: URL, robots: Robots, limit = 3000): Promise<string[]> {
  const queue = robots.sitemaps.length ? [...robots.sitemaps] : [new URL('/sitemap.xml', root).toString()];
  const seen = new Set<string>();
  const pages = new Set<string>();
  let fetched = 0;
  while (queue.length && fetched < 25 && pages.size < limit) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const xml = await fetcher.text(url);
    fetched++;
    if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => decodeXml(m[1]));
    if (/<sitemapindex/i.test(xml)) {
      queue.push(...locs.filter((l) => sameSite(l, root)));
      continue;
    }
    for (const loc of locs) {
      const page = normalizePage(loc);
      if (page && sameSite(page, root)) pages.add(page);
      if (pages.size >= limit) break;
    }
  }
  return [...pages];
}

const decodeXml = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
