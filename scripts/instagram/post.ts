// An Instagram post through yt-dlp: its metadata (caption, poster, top
// comments, carousel entries) and its videos. A carousel downloads every
// video slide; photo slides are skipped. Files land content-addressed
// (<id>.<ext>) like the site scraper's, so the proxy builder takes them
// as they are.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { hashFile, probe, type Probe } from '../lib/media.ts';
import { YTDLP } from '../scrape/download.ts';

// /p/, /reel/, /reels/, /tv/, with or without a username in front.
export function shortcodeOf(url: string): string | null {
  const m = /^(?:https?:\/\/)?(?:www\.|m\.)?instagram\.com\/(?:[\w.]+\/)?(?:p|reels?|tv)\/([\w-]{6,})/i.exec(url.trim());
  return m ? m[1] : null;
}

export const postUrl = (code: string) => `https://www.instagram.com/p/${code}/`;

export interface YtComment {
  author: string;
  text: string;
  likes?: number;
  // Replies say who they answer to in yt-dlp's `parent`.
  reply?: boolean;
}

// What we keep from yt-dlp's info: no format tables or signed media URLs.
export interface PostInfo {
  id: string;
  title?: string;
  description?: string;
  channel?: string;
  uploader?: string;
  uploaderId?: string;
  timestamp?: number;
  likes?: number;
  commentCount?: number;
  comments: YtComment[];
  // Video slides in carousel order; one entry for a single video.
  videos: { id: string; index: number; duration?: number; width?: number; height?: number }[];
}

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function run(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    p.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-8000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e.message.includes('ENOENT') ? new Error(`${YTDLP} not found; install yt-dlp or set YTDLP`) : e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const lastError = (stderr: string) =>
  stderr
    .split('\n')
    .filter((l) => /ERROR/.test(l))
    .pop()
    ?.replace(/^.*?ERROR:\s*(\[[^\]]+\]\s*)?/, '')
    .slice(0, 300) ?? stderr.trim().split('\n').pop()?.slice(0, 300) ?? 'yt-dlp failed';

// Instagram's way of saying "not without logging in" or "slow down".
export const NEEDS_LOGIN = /login required|rate-limit reached|log in|not available|checkpoint/i;

export class YtdlpError extends Error {
  readonly needsLogin: boolean;
  constructor(message: string) {
    super(message);
    this.needsLogin = NEEDS_LOGIN.test(message);
  }
}

// A copy of the saved session for one yt-dlp call: yt-dlp writes its jar
// back to the file it was given, and the saved one should stay as it is.
function withCookies<T>(cookies: string | undefined, task: (args: string[]) => Promise<T>): Promise<T> {
  if (!cookies) return task([]);
  const dir = fs.mkdtempSync(path.join(path.dirname(cookies), '.yt-'));
  const copy = path.join(dir, 'cookies.txt');
  fs.copyFileSync(cookies, copy);
  fs.chmodSync(copy, 0o600);
  return task(['--cookies', copy]).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

export async function fetchInfo(code: string, cookies?: string): Promise<{ info: PostInfo; raw: Json }> {
  const r = await withCookies(cookies, (auth) => run(['--skip-download', '--dump-single-json', '--no-warnings', '--write-comments', '--ignore-no-formats-error', ...auth, postUrl(code)], 120_000));
  if (r.code !== 0 || !r.stdout.trim()) throw new YtdlpError(lastError(r.stderr));
  const raw = JSON.parse(r.stdout) as Json;
  return { info: toInfo(raw), raw };
}

export function toInfo(raw: Json): PostInfo {
  const entries = Array.isArray(raw.entries) ? (raw.entries as Json[]) : [raw];
  const comments = (Array.isArray(raw.comments) ? (raw.comments as Json[]) : []).map((c) => ({
    author: str(c.author) ?? '?',
    text: str(c.text) ?? '',
    ...(num(c.like_count) ? { likes: num(c.like_count) } : {}),
    ...(c.parent && c.parent !== 'root' ? { reply: true } : {}),
  }));
  return {
    id: str(raw.id) ?? '',
    ...(str(raw.title) ? { title: str(raw.title) } : {}),
    ...(str(raw.description) ? { description: str(raw.description) } : {}),
    ...(str(raw.channel) ? { channel: str(raw.channel) } : {}),
    ...(str(raw.uploader) ? { uploader: str(raw.uploader) } : {}),
    ...(str(raw.uploader_id) ? { uploaderId: str(raw.uploader_id) } : {}),
    ...(num(raw.timestamp) ? { timestamp: num(raw.timestamp) } : {}),
    ...(num(raw.like_count) !== undefined ? { likes: num(raw.like_count) } : {}),
    ...(num(raw.comment_count) !== undefined ? { commentCount: num(raw.comment_count) } : {}),
    comments,
    videos: entries
      .filter((e) => Array.isArray(e.formats) && (e.formats as Json[]).some((f) => f.vcodec !== 'none'))
      .map((e, i) => {
        const best = (e.formats as Json[]).filter((f) => num(f.height)).sort((a, b) => num(b.height)! - num(a.height)!)[0];
        return {
          id: str(e.id) ?? `${i + 1}`,
          index: num(e.playlist_index) ?? i + 1,
          ...(num(e.duration) ? { duration: num(e.duration) } : {}),
          ...(best ? { width: num(best.width), height: num(best.height) } : {}),
        };
      }),
  };
}

export interface Downloaded {
  // 1-based position among the post's videos.
  index: number;
  id: string;
  file: string;
  bytes: number;
  probe: Probe;
}

// Every video in the post, merged to mp4 (VP9 or H.264 plus AAC) at up to
// maxHeight, with the post's metadata from the same request (one call to
// Instagram, not two). Needs an ffmpeg that runs (FFMPEG) to merge DASH tracks.
export async function downloadPost(code: string, dir: string, opts: { maxHeight: number; maxBytes: number; cookies?: string }): Promise<{ videos: Downloaded[]; info: PostInfo | null }> {
  const tmp = path.join(dir, '.tmp', randomUUID());
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const r = await withCookies(opts.cookies, (auth) =>
      run([
        '--dump-single-json', '--no-simulate', '--write-comments',
        '--no-colors', '--no-progress', '--no-warnings', '--ignore-no-formats-error', '--ignore-errors',
        '--retries', '5', '--fragment-retries', '10', '--retry-sleep', 'exp=1:20',
        '-f', 'bv*+ba/b', '-S', `res:${opts.maxHeight}`, '--merge-output-format', 'mp4/mkv', '--no-mtime',
        '--max-filesize', `${Math.round(opts.maxBytes / 1e6)}M`,
        '-o', path.join(tmp, '%(playlist_index|1)s.%(ext)s'),
        ...(process.env.FFMPEG ? ['--ffmpeg-location', process.env.FFMPEG] : []),
        ...auth,
        postUrl(code),
      ], 20 * 60_000),
    );
    const files = fs.readdirSync(tmp).filter((f) => /^\d+\.(mp4|mkv|webm|mov)$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
    if (!files.length) throw new YtdlpError(lastError(r.stderr));
    const out: Downloaded[] = [];
    for (const f of files) {
      const src = path.join(tmp, f);
      const p = await probe(src).catch((e: Error) => {
        throw new Error(`slide ${parseInt(f)}: not a playable video (${e.message})`);
      });
      const id = await hashFile(src);
      const name = `${id}${path.extname(f).toLowerCase()}`;
      const dest = path.join(dir, name);
      if (fs.existsSync(dest)) fs.rmSync(src);
      else fs.renameSync(src, dest);
      out.push({ index: parseInt(f), id, file: name, bytes: fs.statSync(dest).size, probe: p });
    }
    let info: PostInfo | null = null;
    try {
      info = toInfo(JSON.parse(r.stdout) as Json);
    } catch {
      // The files are what matter; the metadata can be fetched on its own.
    }
    return { videos: out, info };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
