// Headless Chrome for the scraper, driven by playwright-core against the
// installed Google Chrome (no browser download). The render pass loads a
// page, scrolls it, nudges hover-to-play players, and records every media
// request it sees; the hydrated DOM then goes through the same extractors
// as static HTML.

import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { isChallenge, USER_AGENT } from './site.ts';
import { classifyMedia, isMuxRendition, isSegment, type MediaRef, parseUrl } from './urls.ts';

export async function launchBrowser(): Promise<Browser> {
  const exe = process.env.CHROME_PATH;
  try {
    return await chromium.launch(exe ? { executablePath: exe, headless: true } : { channel: 'chrome', headless: true });
  } catch (e) {
    throw new Error(`could not start Chrome (${(e as Error).message.split('\n')[0]}). Install Google Chrome or set CHROME_PATH to a Chromium binary.`);
  }
}

export function newContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    userAgent: USER_AGENT,
    locale: 'en-US',
    // A service worker can answer media requests out of our sight.
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
}

export interface SeenMedia extends MediaRef {
  status?: number;
  contentType?: string;
  bytes?: number;
}

const MEDIA_TYPE = /^video\/(?!mp2t)|mpegurl|dash\+xml/i;

// Calls `onMedia` for each video file or stream manifest the page requests,
// leaving out what player iframes fetch for themselves (the iframe is the
// better reference: yt-dlp resolves it with metadata).
export function watchMedia(page: Page, onMedia: (m: SeenMedia) => void): void {
  const inPlayer = (frameUrl: string) => classifyMedia(frameUrl)?.kind === 'embed';
  page.on('request', (req) => {
    // A redirect hop (Vimeo's progressive links land on a CDN) is the same video.
    if (req.redirectedFrom()) return;
    const ref = classifyMedia(req.url());
    if (!ref || ref.kind === 'embed' || inPlayer(safeFrameUrl(() => req.frame()))) return;
    onMedia(ref);
  });
  page.on('response', (res) => {
    const type = res.headers()['content-type'] ?? '';
    const url = res.url();
    if (!MEDIA_TYPE.test(type) || isSegment(url) || res.request().redirectedFrom() || inPlayer(safeFrameUrl(() => res.frame()))) return;
    const u = parseUrl(url);
    if (!u || isMuxRendition(u.hostname)) return;
    const ref = classifyMedia(url) ?? { kind: /mpegurl|dash/i.test(type) ? 'stream' : 'file', key: `${u.hostname}${u.pathname}${u.search}`, url };
    if (ref.kind === 'embed') return;
    const bytes = Number(res.headers()['content-length'] ?? 0);
    onMedia({ ...ref, status: res.status(), contentType: type, ...(bytes && res.status() === 200 ? { bytes } : {}) });
  });
}

function safeFrameUrl(frame: () => { url(): string }): string {
  try {
    return frame().url();
  } catch {
    return '';
  }
}

// Scroll with wheel events rather than window.scrollTo, so smooth-scroll
// libraries (Lenis, Locomotive) move too and lazy loaders fire.
export async function autoScroll(page: Page, maxSteps = 60): Promise<void> {
  let stuck = 0;
  let lastY = -1;
  for (let i = 0; i < maxSteps; i++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(220);
    const s = await page.evaluate(() => ({ y: window.scrollY, h: window.innerHeight, H: document.documentElement.scrollHeight })).catch(() => null);
    if (!s) break;
    if (s.y + s.h >= s.H - 4) break;
    stuck = s.y === lastY ? stuck + 1 : 0;
    if (stuck >= 8) break;
    lastY = s.y;
  }
  await page.waitForTimeout(500);
}

// Hover-to-play grids attach their source on mouseenter.
export async function nudgeVideos(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const targets = new Set<Element>();
      for (const el of document.querySelectorAll('video, [class*="video" i], [class*="project" i], [class*="card" i], [class*="thumb" i]')) {
        if (targets.size > 120) break;
        let node: Element | null = el;
        for (let i = 0; i < 3 && node; i++, node = node.parentElement) targets.add(node);
      }
      for (const el of targets) {
        for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter']) {
          el.dispatchEvent(new MouseEvent(type, { bubbles: type.endsWith('over'), cancelable: true }));
        }
      }
    })
    .catch(() => {});
}

export interface Rendered {
  url: string;
  status: number;
  html: string;
  media: SeenMedia[];
  frames: string[];
  blocked?: boolean;
  error?: string;
}

export async function renderPage(context: BrowserContext, url: string): Promise<Rendered> {
  const page = await context.newPage();
  const media = new Map<string, SeenMedia>();
  watchMedia(page, (m) => media.set(m.key, { ...media.get(m.key), ...m }));
  // We only need media URLs here, not the bytes.
  await page.route(/\.(mp4|m4v|mov|webm)(\?|$)/i, (route) => (route.request().resourceType() === 'media' ? route.abort() : route.continue()));
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
    await autoScroll(page);
    await nudgeVideos(page);
    await page.waitForTimeout(1200);
    const html = await page.content();
    // A source set as a property (video.src = ...) shows up here even when
    // the markup doesn't carry it.
    const current = await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => v.currentSrc).filter((s) => s && !s.startsWith('blob:'))).catch(() => [] as string[]);
    for (const src of current) {
      const ref = classifyMedia(src);
      if (ref && !media.has(ref.key)) media.set(ref.key, ref);
    }
    return {
      url: page.url(),
      status: res?.status() ?? 0,
      html,
      media: [...media.values()],
      frames: page.frames().map((f) => f.url()).filter((u) => /^https?:/.test(u)),
      blocked: isChallenge(html),
    };
  } catch (e) {
    return { url, status: 0, html: '', media: [...media.values()], frames: [], error: (e as Error).message.split('\n')[0] };
  } finally {
    await page.close().catch(() => {});
  }
}

export interface FrameRateVideo {
  // The Mux HLS master the player loads.
  stream: string;
  title?: string;
  uploader?: string;
}

// FrameRate's pages are an app that looks its video up after loading, so the
// static HTML doesn't name it. Load the watch page (it titles itself
// "<title> — <uploader> | FrameRate"; the embed doesn't) or failing that the
// embed, and read the Mux playback id off its player.
export async function resolveFrameRate(context: BrowserContext, embedUrl: string): Promise<FrameRateVideo | null> {
  const id = /framerate\.tv\/\w+\/([\w-]+)/.exec(embedUrl)?.[1];
  if (!id) return null;
  for (const kind of ['watch', 'embed']) {
    const video = await frameRatePage(context, `https://framerate.tv/${kind}/${id}`);
    if (video) return video;
  }
  return null;
}

async function frameRatePage(context: BrowserContext, url: string): Promise<FrameRateVideo | null> {
  const page = await context.newPage();
  let requested: string | undefined;
  page.on('request', (req) => {
    requested ??= /^https:\/\/stream\.mux\.com\/([A-Za-z0-9]{20,})\.m3u8/.exec(req.url())?.[1];
  });
  await page.route(/\.(mp4|m4v|mov|webm|ts|m4s)(\?|$)/i, (route) => route.abort());
  const playerId = () => page.evaluate(() => document.querySelector('mux-player, mux-video')?.getAttribute('playback-id') ?? null).catch(() => null);
  const pageTitle = async () => (await page.title().catch(() => '')).trim();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    let playback: string | null | undefined;
    for (let waited = 0; !(playback = (await playerId()) ?? requested) && waited < 15_000; waited += 500) await page.waitForTimeout(500);
    if (!playback) return null;
    // The title follows the video's data; give it a moment.
    let full = await pageTitle();
    for (let waited = 0; /^FrameRate\b/i.test(full) && waited < 3000; waited += 500) {
      await page.waitForTimeout(500);
      full = await pageTitle();
    }
    const out: FrameRateVideo = { stream: `https://stream.mux.com/${playback}.m3u8` };
    if (!/^FrameRate\b/i.test(full)) {
      const name = full.replace(/\s*\|\s*FrameRate\s*$/i, '');
      const cut = name.lastIndexOf(' — ');
      out.title = cut > 0 ? name.slice(0, cut) : name;
      if (cut > 0) out.uploader = name.slice(cut + 3);
    }
    return out;
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}
