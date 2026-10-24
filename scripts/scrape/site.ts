// Polite HTTP for the crawler: a per-run request pool with a minimum gap
// between requests, robots.txt rules, sitemap discovery and bot-challenge
// detection. A challenged page is reported, never worked around.

import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { pipeline, Readable } from 'node:stream';
import zlib from 'node:zlib';
import { normalizePage, parseUrl, sameSite } from './urls.ts';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const MAX_HTML_BYTES = 8 << 20;
const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const CHALLENGE = /cf-chl|challenge-platform|cf_chl_opt|just a moment\.\.\.|attention required|captcha|are you a robot|px-captcha|datadome|verify you are human/i;

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  html?: string;
  blocked?: boolean;
  error?: string;
}

export interface FetcherOptions {
  // For links from untrusted input (api/enrich.ts). Every hop, redirects
  // included, must be http(s) on a standard port and resolve only to public
  // addresses, and the connection goes to the address that was checked, so
  // a second DNS answer can't swap in a private one.
  publicOnly?: boolean;
  // Bodies read as text stop here, counted after decompression; a longer
  // one is an error. Unlimited by default.
  maxBytes?: number;
  // Per request: connection, redirects and body.
  timeoutMs?: number;
  // What publicOnly lets through. Tests widen these to reach a local server.
  allowAddress?: (ip: string) => boolean;
  allowPort?: (port: string) => boolean;
}

export class Fetcher {
  #active = 0;
  #waiting: (() => void)[] = [];
  #lastStart = 0;
  readonly #options: FetcherOptions;
  readonly concurrency: number;
  delayMs: number;

  constructor(concurrency: number, delayMs: number, options: FetcherOptions = {}) {
    this.concurrency = concurrency;
    this.delayMs = delayMs;
    this.#options = options;
  }

  get #maxBytes(): number {
    return this.#options.maxBytes ?? Infinity;
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
    const headers = { 'user-agent': USER_AGENT, accept, 'accept-language': 'en-US,en;q=0.9' };
    return this.#slot(() => {
      const signal = AbortSignal.timeout(this.#options.timeoutMs ?? 25_000);
      if (this.#options.publicOnly) return this.#getPublic(url, headers, signal);
      return fetch(url, { headers, redirect: 'follow', signal });
    });
  }

  // Redirects by hand, so each hop is checked before it's requested.
  async #getPublic(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
    const allowAddress = this.#options.allowAddress ?? isPublicAddress;
    const allowPort = this.#options.allowPort ?? ((port: string) => port === '80' || port === '443');
    const lookup = publicLookup(allowAddress);
    let target = url;
    for (let hop = 0; ; hop++) {
      const u = new URL(target);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`won’t fetch ${u.protocol} links`);
      if (u.username || u.password) throw new Error('won’t fetch a link with credentials in it');
      if (u.port && !allowPort(u.port)) throw new Error(`won’t fetch port ${u.port}`);
      // An IP literal connects without a lookup, so it's checked here.
      const literal = u.hostname.replace(/^\[(.*)\]$/, '$1');
      if (isIP(literal) && !allowAddress(literal)) throw new Error(`${literal} isn’t a public address`);
      const res = await request(u, headers, signal, lookup);
      const location = res.headers.get('location');
      if (!REDIRECTS.has(res.status) || !location) return res;
      await res.body?.cancel();
      if (hop === MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
      target = new URL(location, u).href;
    }
  }

  async page(url: string): Promise<FetchedPage> {
    try {
      const res = await this.get(url);
      const contentType = res.headers.get('content-type') ?? '';
      const len = Number(res.headers.get('content-length') ?? 0);
      if (/html|xml/i.test(contentType) && len > this.#maxBytes) {
        await res.body?.cancel();
        throw new Error(`the page is over ${this.#maxBytes} bytes`);
      }
      if (!/html|xml/i.test(contentType) || len > MAX_HTML_BYTES) {
        await res.body?.cancel();
        return { url: res.url || url, status: res.status, contentType };
      }
      const html = await readText(res, this.#maxBytes);
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
      return await readText(res, this.#maxBytes);
    } catch {
      return null;
    }
  }
}

async function readText(res: Response, maxBytes: number): Promise<string> {
  if (maxBytes === Infinity) return res.text();
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error(`the response is over ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// ---- public addresses only -------------------------------------------------------

// Public unicast only: no loopback, private, link-local, CGNAT, multicast,
// documentation or other reserved ranges. IPv6 has to be global unicast
// (2000::/3), which also rules out IPv4-mapped, NAT64 and ULA addresses.
const RESERVED4 = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  RESERVED4.addSubnet(net, bits, 'ipv4');
const GLOBAL6 = new BlockList();
GLOBAL6.addSubnet('2000::', 3, 'ipv6');
const RESERVED6 = new BlockList();
// IETF protocol assignments (Teredo among them), documentation, 6to4.
for (const [net, bits] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  RESERVED6.addSubnet(net, bits, 'ipv6');

export function isPublicAddress(ip: string): boolean {
  try {
    const family = isIP(ip);
    if (family === 4) return !RESERVED4.check(ip, 'ipv4');
    if (family === 6) return GLOBAL6.check(ip, 'ipv6') && !RESERVED6.check(ip, 'ipv6');
  } catch {
    // A zone index or anything else BlockList can't read.
  }
  return false;
}

// Resolves for the socket itself, so the address checked is the one used.
// Every answer has to pass, not just the first.
function publicLookup(allow: (ip: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { family: options.family, hints: options.hints, all: true }, (err, addresses) => {
      if (err) return callback(err, '');
      const bad = addresses.find((a) => !allow(a.address));
      if (bad || !addresses.length) return callback(Object.assign(new Error(`${hostname} points to an address that isn’t public`), { code: 'ENOTPUBLIC' }), '');
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

const NULL_BODY = new Set([204, 205, 304]);

// One GET with node:http, so the connection can use publicLookup. Answers
// a fetch-style Response (no redirects followed), its url set to `u`.
function request(u: URL, headers: Record<string, string>, signal: AbortSignal, lookup: LookupFunction): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = (u.protocol === 'https:' ? https : http).request(
      u,
      { method: 'GET', headers: { ...headers, 'accept-encoding': 'gzip, br' }, lookup, signal, agent: false },
      (msg) => {
        try {
          const status = msg.statusCode ?? 0;
          if (status < 200 || status > 599) throw new Error(`HTTP ${status}`);
          const out = new Headers();
          for (let i = 0; i < msg.rawHeaders.length; i += 2) {
            try {
              out.append(msg.rawHeaders[i], msg.rawHeaders[i + 1]);
            } catch {
              // A header Headers won't hold; nothing here needs it.
            }
          }
          let body: Readable | null = NULL_BODY.has(status) ? null : msg;
          const encoding = out.get('content-encoding')?.trim().toLowerCase();
          const decoder =
            encoding === 'gzip' || encoding === 'x-gzip' ? zlib.createGunzip() : encoding === 'br' ? zlib.createBrotliDecompress() : encoding === 'deflate' ? zlib.createInflate() : null;
          if (body && decoder) {
            body = pipeline(msg, decoder, () => {});
            out.delete('content-encoding');
            out.delete('content-length');
          }
          if (!body) msg.resume();
          const res = new Response(body && (Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>), { status, headers: out });
          Object.defineProperty(res, 'url', { value: u.href });
          resolve(res);
        } catch (e) {
          msg.destroy();
          reject(e);
        }
      },
    );
    req.on('error', reject);
    req.end();
  });
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
