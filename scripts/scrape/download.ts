// Fetching an item's video: direct files over HTTP, players and streams
// through yt-dlp. Each URL the item was seen at is tried in order until one
// yields a file that probes as video. Files land content-addressed
// (<id>.<ext>), so a re-run or a second site that finds the same bytes
// reuses them.

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { gifRejection, gifToMp4, readGif } from '../lib/gif.ts';
import { hashFile, probe } from '../lib/media.ts';
import type { ItemGroup } from './items.ts';
import { USER_AGENT } from './site.ts';
import type { ScrapedItem } from './types.ts';
import { looksLikeFilename } from './urls.ts';

export const YTDLP = process.env.YTDLP ?? 'yt-dlp';

export interface DownloadOptions {
  dir: string;
  maxBytes: number;
  // Seconds; longer player-hosted videos are skipped.
  maxDuration: number;
  // Player-hosted videos come down at up to this height; L2 tops out at 1080p.
  maxHeight: number;
  dryRun: boolean;
}

class Skip extends Error {}

export function ytdlpVersion(): string | null {
  const r = spawnSync(YTDLP, ['--version'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const EXT_FOR_TYPE: Record<string, string> = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-matroska': 'mkv', 'video/ogg': 'ogv', 'video/x-m4v': 'm4v', 'image/gif': 'gif' };

function extFor(contentType: string, url: string): string {
  const fromType = EXT_FOR_TYPE[contentType.split(';')[0].trim().toLowerCase()];
  if (fromType) return fromType;
  const m = /\.(mp4|m4v|mov|webm|ogv|mkv|gif)$/i.exec(new URL(url).pathname);
  return m ? m[1].toLowerCase() : 'mp4';
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

// Downloads (or, in a dry run, checks) one item, filling in its id, file
// and media facts. Never throws: failures land in item.status/reason.
export async function fetchItem(item: ScrapedItem, group: ItemGroup, opts: DownloadOptions): Promise<void> {
  const referer = group.primary.pageUrl;
  const tmp = path.join(opts.dir, '.tmp', randomUUID());
  fs.mkdirSync(tmp, { recursive: true });
  const errors: string[] = [];
  try {
    for (const { url, kind } of group.urls) {
      try {
        if (opts.dryRun) {
          await check(item, url, kind, referer);
        } else {
          const got = kind === 'file' ? await downloadFile(url, referer, tmp, opts.maxBytes) : await ytdlp(url, referer, tmp, opts);
          await settle(item, got.file.endsWith('.gif') ? await fromGif(got) : got, opts.dir);
        }
        item.media.downloadedFrom = url;
        return;
      } catch (e) {
        if (e instanceof Skip) {
          item.status = 'skipped';
          item.reason = e.message;
          return;
        }
        errors.push(`${shortUrl(url)}: ${(e as Error).message}`);
      }
    }
    item.status = 'failed';
    item.reason = errors.join('; ').slice(0, 1000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

interface Got {
  file: string;
  hash?: string;
  contentType?: string;
  lastModified?: string;
  etag?: string;
  info?: Record<string, unknown>;
  convertedFrom?: 'gif';
}

// An animated GIF becomes an MP4 beside it. The id stays the GIF's hash, so
// the same GIF found again maps to the same clip.
async function fromGif(got: Got): Promise<Got> {
  const g = readGif(fs.readFileSync(got.file));
  if (!g) throw new Error('not a readable GIF');
  const why = gifRejection(g);
  if (why) throw new Skip(why);
  const hash = got.hash ?? (await hashFile(got.file));
  const mp4 = got.file.replace(/\.gif$/, '.mp4');
  await gifToMp4(got.file, mp4, g);
  fs.rmSync(got.file);
  return { ...got, file: mp4, hash, convertedFrom: 'gif' };
}

// Probe, hash and move a downloaded file into place.
async function settle(item: ScrapedItem, got: Got, dir: string): Promise<void> {
  const p = await probe(got.file).catch((e: Error) => {
    throw new Error(`not a playable video (${e.message})`);
  });
  const id = got.hash ?? (await hashFile(got.file));
  const ext = path.extname(got.file).slice(1).toLowerCase() || 'mp4';
  const name = `${id}.${ext}`;
  const dest = path.join(dir, name);
  if (fs.existsSync(dest)) fs.rmSync(got.file);
  else fs.renameSync(got.file, dest);
  item.status = 'downloaded';
  item.id = id;
  item.file = name;
  Object.assign(item.media, {
    bytes: fs.statSync(dest).size,
    width: p.width,
    height: p.height,
    duration: Number(p.duration.toFixed(3)),
    fps: Number(p.fps.toFixed(3)),
    ...(p.codec ? { codec: p.codec } : {}),
    audio: p.audio,
    ...(got.contentType ? { contentType: got.contentType } : {}),
    ...(got.lastModified ? { lastModified: got.lastModified } : {}),
    ...(got.etag ? { etag: got.etag } : {}),
    ...(got.convertedFrom ? { convertedFrom: got.convertedFrom } : {}),
  });
  if (got.info) applyEmbedInfo(item, got.info);
}

// One at a time when it's a Vimeo link, so the pacer sees the whole download.
const downloadFile = (url: string, referer: string, tmp: string, maxBytes: number): Promise<Got> => paced(url, () => fetchFile(url, referer, tmp, maxBytes));

async function fetchFile(url: string, referer: string, tmp: string, maxBytes: number): Promise<Got> {
  const gif = /\.gif$/i.test(new URL(url).pathname);
  const res = await fetch(url, {
    // For a GIF, no image/webp or avif: an image CDN would re-encode it.
    headers: { 'user-agent': USER_AGENT, referer, accept: gif ? 'image/gif,*/*;q=0.5' : 'video/webm,video/mp4,video/*;q=0.9,*/*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw httpError(url, res.status);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (/^text\/|json|xml/i.test(contentType) || (/^image\//i.test(contentType) && !/^image\/gif/i.test(contentType))) {
    await res.body.cancel();
    throw new Error(`not a video (${contentType})`);
  }
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > maxBytes) {
    await res.body.cancel();
    throw new Skip(`larger than --max-size (${mb(length)})`);
  }
  const file = path.join(tmp, `download.${extFor(contentType, res.url || url)}`);
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) return done(new Skip(`larger than --max-size (over ${mb(maxBytes)})`));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream), meter, fs.createWriteStream(file));
  return {
    file,
    hash: hash.digest('hex').slice(0, 16),
    contentType,
    lastModified: res.headers.get('last-modified') ?? undefined,
    etag: res.headers.get('etag') ?? undefined,
  };
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    p.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-8000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e.message.includes('ENOENT') ? new Error(`${cmd} not found; install yt-dlp or set YTDLP`) : e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const VIMEO_REFUSED = /blocked due to its TLS fingerprint|HTTP Error 429/;

const lastError = (stderr: string) =>
  VIMEO_REFUSED.test(stderr) ? 'Vimeo is refusing automated requests from this machine for now (bot protection); retry later' :
  stderr
    .split('\n')
    .filter((l) => /ERROR/.test(l))
    .pop()
    ?.replace(/^.*?ERROR:\s*/, '')
    .slice(0, 300) ?? stderr.trim().split('\n').pop()?.slice(0, 300);

function ytdlpArgs(referer: string): string[] {
  return ['--no-playlist', '--no-colors', '--referer', referer, '--add-headers', `User-Agent:${USER_AGENT}`];
}

// A response that means Vimeo is refusing this machine, not this video.
export class Refused extends Error {}

export const HELD_BACK = 'Vimeo refused several requests in a row (bot protection), so this run left the rest of its videos alone; re-run later to retry';

// Every Vimeo request (players, progressive files, dry-run checks) goes
// through one queue: one at a time, several seconds apart. Vimeo blocks
// clients that hammer it: after a few thousand requests in a day it refused
// this machine outright for some hours. We don't work around that. After a
// few refusals in a row the pacer stops sending, and the rest of the run's
// Vimeo work fails at once and stays queued for a re-run.
export function pacer(opts: { gapMs: number; jitterMs: number; tripAfter: number; onTrip?: () => void }) {
  let turn: Promise<unknown> = Promise.resolve();
  let strikes = 0;
  let tripped = false;
  const gap = () => (tripped ? undefined : new Promise((r) => setTimeout(r, opts.gapMs + Math.random() * opts.jitterMs)));
  return {
    get tripped() {
      return tripped;
    },
    run<T>(task: () => Promise<T>): Promise<T> {
      const run = turn.then(async () => {
        if (tripped) throw new Error(HELD_BACK);
        try {
          const out = await task();
          strikes = 0;
          return out;
        } catch (e) {
          if (!(e instanceof Refused)) strikes = 0;
          else if (++strikes >= opts.tripAfter && !tripped) {
            tripped = true;
            opts.onTrip?.();
          }
          throw e;
        }
      });
      turn = run.then(gap, gap);
      return run;
    },
  };
}

const vimeo = pacer({
  gapMs: 5000,
  jitterMs: 3000,
  tripAfter: 3,
  onTrip: () => {
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
    console.log('  Vimeo is refusing requests from this machine; leaving its remaining videos for a later run');
  },
});

const isVimeo = (url: string) => /(^|\.)vimeo\.com$/.test(new URL(url).hostname);
const paced = <T>(url: string, task: () => Promise<T>): Promise<T> => (isVimeo(url) ? vimeo.run(task) : task());

// HTTP refusals from Vimeo's file links count against the pacer.
function httpError(url: string, status: number): Error {
  return isVimeo(url) && (status === 403 || status === 429) ? new Refused(`HTTP ${status}`) : new Error(`HTTP ${status}`);
}

// yt-dlp, with Vimeo's refusals surfaced to the pacer.
const ytdlpRun = (url: string, args: string[], timeoutMs: number) =>
  paced(url, async () => {
    const r = await run(YTDLP, args, timeoutMs);
    if (r.code !== 0 && VIMEO_REFUSED.test(r.stderr)) throw new Refused(lastError(r.stderr));
    return r;
  });

// Players and HLS/DASH: best video plus best audio, merged by ffmpeg.
async function ytdlp(url: string, referer: string, tmp: string, opts: DownloadOptions): Promise<Got> {
  const args = [
    ...ytdlpArgs(referer),
    '--no-progress',
    // Vimeo's CDN answers 503 now and then under load.
    '--retries', '5', '--fragment-retries', '10', '--extractor-retries', '3', '--retry-sleep', 'exp=1:20',
    '-f', 'bv*+ba/b',
    '-S', `res:${opts.maxHeight}`,
    '--merge-output-format', 'mp4/mkv',
    '--write-info-json',
    '--no-write-playlist-metafiles',
    '--no-mtime',
    '--match-filter', `duration <=? ${opts.maxDuration}`,
    '--max-filesize', `${Math.round(opts.maxBytes / 1e6)}M`,
    '-o', path.join(tmp, 'media.%(ext)s'),
    ...(process.env.FFMPEG ? ['--ffmpeg-location', process.env.FFMPEG] : []),
    url,
  ];
  const r = await ytdlpRun(url, args, 30 * 60_000);
  const infoPath = path.join(tmp, 'media.info.json');
  const info = fs.existsSync(infoPath) ? (JSON.parse(fs.readFileSync(infoPath, 'utf8')) as Record<string, unknown>) : undefined;
  const file = fs.readdirSync(tmp).find((f) => f.startsWith('media.') && !/\.(json|part|ytdl)$/.test(f) && !/\.f[\w-]+\.\w+$/.test(f));
  const out = `${r.stdout}\n${r.stderr}`;
  if (!file) {
    if (/does not pass filter/i.test(out)) throw new Skip(`longer than --max-duration${info?.duration ? ` (${Math.round(Number(info.duration))} s)` : ''}`);
    if (/larger than max-filesize/i.test(out)) throw new Skip('larger than --max-size');
    throw new Error(lastError(r.stderr) ?? `yt-dlp exited ${r.code}`);
  }
  return { file: path.join(tmp, file), info };
}

// Dry run: confirm the URL resolves and record what it would give us.
async function check(item: ScrapedItem, url: string, kind: string, referer: string): Promise<void> {
  if (kind === 'file') {
    const res = await paced(url, async () => {
      const res = await fetch(url, { method: 'HEAD', headers: { 'user-agent': USER_AGENT, referer }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
      if (!res.ok && res.status !== 405) throw httpError(url, res.status);
      return res;
    });
    const type = res.headers.get('content-type') ?? '';
    if (/text\/html/i.test(type)) throw new Error(`not a video (${type})`);
    const bytes = Number(res.headers.get('content-length') ?? 0);
    Object.assign(item.media, { ...(type ? { contentType: type } : {}), ...(bytes ? { bytes } : {}), ...(res.headers.get('last-modified') ? { lastModified: res.headers.get('last-modified')! } : {}) });
    return;
  }
  const r = await ytdlpRun(url, [...ytdlpArgs(referer), '--skip-download', '--dump-single-json', '--no-warnings', url], 120_000);
  if (r.code !== 0) throw new Error(lastError(r.stderr) ?? `yt-dlp exited ${r.code}`);
  const info = JSON.parse(r.stdout) as Record<string, unknown>;
  applyEmbedInfo(item, info);
  for (const k of ['width', 'height', 'duration', 'fps'] as const) {
    if (typeof info[k] === 'number' && item.media[k] === undefined) item.media[k] = info[k] as number;
  }
}

// yt-dlp's metadata minus the bulky or expiring parts: format tables,
// signed media URLs, local paths.
const DROP = new Set([
  'formats', 'requested_formats', 'thumbnails', 'automatic_captions', 'subtitles', 'heatmap', 'requested_downloads',
  'requested_subtitles', 'http_headers', 'url', 'manifest_url', 'fragments', 'fragment_base_url', 'downloader_options',
  'cookies', 'filepath', 'filename', 'protocol', 'epoch',
]);

function applyEmbedInfo(item: ScrapedItem, info: Record<string, unknown>): void {
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(info)) {
    if (DROP.has(k) || k.startsWith('_') || v === null || v === undefined || v === '') continue;
    kept[k] = v;
  }
  item.embed = kept;
  titleFromEmbed(item);
}

// A player's title beats a page-level guess, unless it's an upload's file name.
export function titleFromEmbed(item: ScrapedItem): void {
  const t = typeof item.embed?.title === 'string' ? item.embed.title.trim() : '';
  if (t && !looksLikeFilename(t) && (item.titleSource === 'page' || item.titleSource === 'url')) {
    item.title = t.slice(0, 160);
    item.titleSource = 'embed';
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
}
