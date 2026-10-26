// Instagram's post and profile pages, read in headless Chrome. Both pages
// server-render their data as JSON in <script type="application/json">
// blocks (Relay payloads), logged out as well as logged in, so we load the
// page once and walk that JSON for the post or the user, rather than
// calling Instagram's private API.
//
// Page views go one at a time, several seconds apart. Logged out, Instagram
// eventually answers with a login wall; then, if a saved session exists
// (scripts/instagram-cookies.sh), the page is retried logged in. A
// checkpoint or "try again later" stops the run's page views: we don't try
// to get past those.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext } from 'playwright-core';
import { launchBrowser, newContext } from '../scrape/browser.ts';

export const COOKIES = process.env.INSTAGRAM_COOKIES ?? path.join(os.homedir(), '.config', 'codex-motion', 'instagram-cookies.txt');

export interface IgUserRef {
  username: string;
  fullName?: string;
  verified?: boolean;
}

export interface IgUser extends IgUserRef {
  pk?: string;
  biography?: string;
  links: { title?: string; url: string }[];
  // Shown only to logged-in viewers ("Digital creator", "Design studio").
  category?: string;
  followers?: number;
  following?: number;
  posts?: number;
  private?: boolean;
  business?: boolean;
}

export interface IgMedia {
  code: string;
  pk?: string;
  takenAt?: string;
  // 1 photo, 2 video, 8 carousel.
  mediaType?: number;
  productType?: string;
  caption?: string;
  user?: IgUserRef;
  coauthors: IgUserRef[];
  // People tagged on the post or any of its slides.
  tagged: IgUserRef[];
  location?: string;
  music?: { title?: string; artist?: string; original?: boolean };
  // Instagram's own "AI info" label, when the post carries one.
  aiLabel?: string;
  likes?: number;
  comments?: number;
  // Per slide, for carousels: what each one is.
  slides?: { mediaType?: number; width?: number; height?: number }[];
}

export type PageResult<T> = { data: T; loggedIn: boolean } | { error: string; wall?: boolean; stop?: boolean };

type Json = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const arr = (v: unknown) => (Array.isArray(v) ? v : []);
const defined = <K extends string, V>(k: K, v: V | undefined) => (v === undefined ? {} : ({ [k]: v } as Record<K, V>));

// Email addresses and phone numbers in bios stay out of what we keep: the
// sidecar is published with the clip.
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    // Nine digits or more: a phone number, not a year range ("2018-2026").
    .replace(/\+?\(?\d[\d ().-]{7,}\d/g, (m) => (m.replace(/\D/g, '').length >= 9 ? '[phone]' : m));
}

function walk(v: unknown, visit: (o: Json) => boolean): Json | undefined {
  const stack = [v];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) stack.push(...cur);
    else if (cur && typeof cur === 'object') {
      const o = cur as Json;
      if (visit(o)) return o;
      stack.push(...Object.values(o));
    }
  }
  return undefined;
}

export function jsonBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      out.push(JSON.parse(m[1]));
    } catch {
      // Not every block parses; skip it.
    }
  }
  return out;
}

const userRef = (u: Json | undefined): IgUserRef | undefined => {
  const username = str(u?.username);
  if (!username) return undefined;
  return { username, ...(str(u?.full_name) ? { fullName: str(u?.full_name) } : {}), ...(u?.is_verified === true ? { verified: true } : {}) };
};

export function findMedia(blocks: unknown[], code: string): IgMedia | null {
  let m: Json | undefined;
  for (const b of blocks) if ((m = walk(b, (o) => o.code === code && 'user' in o && ('caption' in o || 'usertags' in o)))) break;
  if (!m) return null;
  const slides = arr(m.carousel_media).map(obj).filter((s): s is Json => !!s);
  const tagged = new Map<string, IgUserRef>();
  for (const s of [m, ...slides]) {
    for (const t of arr(obj(s.usertags)?.in)) {
      const ref = userRef(obj(obj(t)?.user));
      if (ref) tagged.set(ref.username, ref);
    }
  }
  const clips = obj(m.clips_metadata);
  const asset = obj(obj(clips?.music_info)?.music_asset_info);
  const original = obj(clips?.original_sound_info);
  const music = asset
    ? { title: str(asset.title), artist: str(asset.display_artist) }
    : original
      ? { title: str(original.original_audio_title), artist: str(obj(original.ig_artist)?.username), original: true }
      : undefined;
  const loc = obj(m.location);
  const ai = obj(m.ai_label_info);
  const taken = num(m.taken_at);
  return {
    code,
    ...(str(m.pk) ? { pk: str(m.pk) } : {}),
    ...(taken ? { takenAt: new Date(taken * 1000).toISOString() } : {}),
    ...(num(m.media_type) ? { mediaType: num(m.media_type) } : {}),
    ...(str(m.product_type) ? { productType: str(m.product_type) } : {}),
    ...(str(obj(m.caption)?.text) ? { caption: str(obj(m.caption)?.text) } : {}),
    ...(userRef(obj(m.user) ?? obj(m.owner)) ? { user: userRef(obj(m.user) ?? obj(m.owner)) } : {}),
    coauthors: arr(m.coauthor_producers).map((u) => userRef(obj(u))).filter((u): u is IgUserRef => !!u),
    tagged: [...tagged.values()],
    ...(loc && str(loc.name) ? { location: str(loc.name) } : {}),
    ...(music && (music.title || music.artist) ? { music } : {}),
    ...(ai && Object.keys(ai).length ? { aiLabel: str(ai.label) ?? str(ai.title) ?? JSON.stringify(ai).slice(0, 200) } : {}),
    ...(num(m.like_count) !== undefined ? { likes: num(m.like_count) } : {}),
    ...(num(m.comment_count) !== undefined ? { comments: num(m.comment_count) } : {}),
    ...(slides.length ? { slides: slides.map((s) => ({ mediaType: num(s.media_type), width: num(s.original_width), height: num(s.original_height) })) } : {}),
  };
}

export function findUser(blocks: unknown[], username: string): IgUser | null {
  const want = username.toLowerCase();
  let u: Json | undefined;
  for (const b of blocks) if ((u = walk(b, (o) => typeof o.username === 'string' && o.username.toLowerCase() === want && 'biography' in o))) break;
  if (!u) return null;
  const links = new Map<string, { title?: string; url: string }>();
  for (const l of arr(u.bio_links)) {
    const url = str(obj(l)?.url);
    if (url) links.set(url, { ...(str(obj(l)?.title) ? { title: str(obj(l)?.title) } : {}), url });
  }
  const ext = str(u.external_url);
  if (ext && !links.has(ext)) links.set(ext, { url: ext });
  const bio = str(u.biography);
  return {
    username: str(u.username)!,
    ...(str(u.full_name) ? { fullName: str(u.full_name) } : {}),
    ...(u.is_verified === true ? { verified: true } : {}),
    ...(str(u.pk) ?? str(u.id) ? { pk: str(u.pk) ?? str(u.id) } : {}),
    ...(bio ? { biography: redact(bio) } : {}),
    links: [...links.values()],
    ...(str(u.category_name) ?? str(u.category) ? { category: str(u.category_name) ?? str(u.category) } : {}),
    ...defined('followers', num(obj(u.edge_followed_by)?.count) ?? num(u.follower_count)),
    ...defined('following', num(obj(u.edge_follow)?.count) ?? num(u.following_count)),
    ...defined('posts', num(obj(u.edge_owner_to_timeline_media)?.count) ?? num(u.media_count)),
    ...(u.is_private === true ? { private: true } : {}),
    ...(u.is_business_account === true || u.is_business === true ? { business: true } : {}),
  };
}

// Netscape cookies.txt (what yt-dlp writes) to Playwright cookies.
type Cookie = Parameters<BrowserContext['addCookies']>[0][number];

export function readCookies(file: string): Cookie[] {
  const out: Cookie[] = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const httpOnly = raw.startsWith('#HttpOnly_');
    const line = httpOnly ? raw.slice('#HttpOnly_'.length) : raw;
    if (!line.trim() || line.startsWith('#')) continue;
    const [domain, , cpath, secure, expires, name, value] = line.split('\t');
    if (!name || value === undefined) continue;
    // Chrome's own timestamps (microseconds since 1601) show up in some exports.
    const e = Number(expires) > 1e12 ? Math.floor(Number(expires) / 1e6 - 11_644_473_600) : Number(expires);
    out.push({ name, value: value.trim(), domain, path: cpath || '/', secure: secure === 'TRUE', httpOnly, ...(e > 0 ? { expires: e } : {}) });
  }
  return out;
}

const WALL = /\/accounts\/login|\/challenge\/|\/accounts\/suspended/;
const SLOW_DOWN = /Please wait a few minutes before you try again|Try Again Later|We restrict certain activity/i;
// GraphQL queries a logged-in page makes that we have no use for.
const UNNEEDED = /^(IGD|PolarisStories|PolarisFeed|PolarisProfileStory|PolarisProfileSuggested|PolarisProfileDirect|PolarisProfileNote|QuickPromotion|PolarisAPIGetFrCookie|PolarisProfilePosts|PolarisSchoolPartner)/;
const friendlyName = (body: string | null) => /fb_api_req_friendly_name=([^&]+)/.exec(body ?? '')?.[1] ?? '';

export interface PageOptions {
  // auto: logged out, retrying a login wall logged in when a session is
  // saved; always: logged in from the start; never: logged out only.
  login: 'auto' | 'always' | 'never';
  gapMs?: number;
  log?: (s: string) => void;
}

export class InstagramPages {
  #browser: Browser | null = null;
  #out: BrowserContext | null = null;
  #in: BrowserContext | null = null;
  #turn: Promise<unknown> = Promise.resolve();
  #walls = 0;
  stopped: string | null = null;
  views = { loggedOut: 0, loggedIn: 0 };
  readonly opts: PageOptions;

  constructor(opts: PageOptions) {
    this.opts = opts;
  }

  get hasSession(): boolean {
    return fs.existsSync(COOKIES);
  }

  async #context(loggedIn: boolean): Promise<BrowserContext> {
    this.#browser ??= await launchBrowser();
    if (!loggedIn) return (this.#out ??= await newContext(this.#browser));
    if (!this.#in) {
      this.#in = await newContext(this.#browser);
      await this.#in.addCookies(readCookies(COOKIES));
    }
    return this.#in;
  }

  post(code: string): Promise<PageResult<IgMedia>> {
    return this.#read(`https://www.instagram.com/p/${code}/`, code, (blocks) => findMedia(blocks, code));
  }

  profile(username: string): Promise<PageResult<IgUser>> {
    return this.#read(`https://www.instagram.com/${username}/`, `"${username}"`, (blocks) => findUser(blocks, username));
  }

  // One page view at a time, gapMs (plus jitter) apart.
  #read<T>(url: string, needle: string, find: (blocks: unknown[]) => T | null): Promise<PageResult<T>> {
    const run = this.#turn.then(async (): Promise<PageResult<T>> => {
      if (this.stopped) return { error: this.stopped, stop: true };
      const order = this.opts.login === 'always' ? [true] : this.opts.login === 'never' || !this.hasSession ? [false] : [false, true];
      let last: PageResult<T> = { error: 'not loaded' };
      for (const loggedIn of order) {
        last = await this.#view(url, loggedIn, needle, find);
        if ('data' in last || last.stop || !last.wall) break;
      }
      if ('wall' in last && last.wall) {
        if (++this.#walls >= 3) this.stopped = `Instagram showed a login wall ${this.#walls} times in a row${this.hasSession ? ' (the saved session may have expired: re-run scripts/instagram-cookies.sh)' : ' (save a session with scripts/instagram-cookies.sh)'}`;
      } else if ('data' in last) this.#walls = 0;
      return last;
    });
    const gap = () => new Promise((r) => setTimeout(r, (this.opts.gapMs ?? 4000) + Math.random() * 3000));
    this.#turn = run.then(gap, gap);
    return run;
  }

  // Server-rendered JSON first; a logged-in page fetches the profile over
  // GraphQL instead, so responses that mention what we came for count too.
  // The rest of a logged-in page (feed, stories, inbox, suggestions) is
  // blocked: we only read the one profile or post.
  async #view<T>(url: string, loggedIn: boolean, needle: string, find: (blocks: unknown[]) => T | null): Promise<PageResult<T>> {
    const context = await this.#context(loggedIn);
    const page = await context.newPage();
    await page.route(/\.(jpe?g|png|webp|heic|mp4|m4v|m4s|webm)(\?|$)/i, (r) => r.abort());
    await page.route(/instagram\.com\/(api\/graphql|graphql\/query)/, (r) => (UNNEEDED.test(friendlyName(r.request().postData())) ? r.abort() : r.continue()));
    const fetched: unknown[] = [];
    page.on('response', (res) => {
      if (!/instagram\.com\/(api\/graphql|graphql\/query|api\/v1\/)/.test(res.url())) return;
      res.text().then((t) => {
        if (!t.includes(needle)) return;
        try {
          fetched.push(JSON.parse(t.replace(/^for \(;;\);/, '')));
        } catch {
          // Streamed responses carry several JSON documents, one per line.
          for (const line of t.split('\n')) {
            try {
              fetched.push(JSON.parse(line));
            } catch {
              // Not JSON.
            }
          }
        }
      }, () => {});
    });
    try {
      loggedIn ? this.views.loggedIn++ : this.views.loggedOut++;
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForLoadState('load', { timeout: 8_000 }).catch(() => {});
      if (res?.status() === 404) return { error: 'not found (deleted, or the account is private or renamed)' };
      if (/\/challenge\/|\/accounts\/suspended/.test(page.url())) {
        this.stopped = `Instagram asked for a security check (${new URL(page.url()).pathname}); stopping page views. Open instagram.com in Chrome and clear it there.`;
        return { error: this.stopped, stop: true };
      }
      const html = await page.content();
      if (SLOW_DOWN.test(html.slice(0, 200_000)) || res?.status() === 429) {
        this.stopped = 'Instagram is rate-limiting page views from this machine ("try again later"); stopping. Retry in a while.';
        return { error: this.stopped, stop: true };
      }
      const blocks = jsonBlocks(html);
      for (let waited = 0; ; waited += 500) {
        const found = find([...blocks, ...fetched]);
        if (found) return { data: found, loggedIn };
        if (waited >= 8_000 || WALL.test(page.url())) break;
        await page.waitForTimeout(500);
      }
      return { error: WALL.test(page.url()) ? 'login wall' : 'no data on the page (login wall, or Instagram changed its markup)', wall: true };
    } catch (e) {
      return { error: (e as Error).message.split('\n')[0] };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    await this.#turn.catch(() => {});
    await this.#browser?.close().catch(() => {});
  }
}
