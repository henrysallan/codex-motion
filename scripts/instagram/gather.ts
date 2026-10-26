// Everything we read about one post before Claude sees it, cached under
// <out>/.cache so a re-run (or the eval's ablations) costs Instagram no
// requests:
//   posts/<code>.ytdlp.json   yt-dlp's metadata, trimmed (PostInfo)
//   posts/<code>.page.json    the post page's data (IgMedia)
//   users/<name>.json         profiles (IgUser), refreshed after 30 days
//   links/<sha1>.json         bio-link pages (LinkPage)

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PostContext } from './enrich.ts';
import { readLink, type LinkPage } from './links.ts';
import { COOKIES, type IgMedia, type IgUser, type InstagramPages, type PageResult } from './pages.ts';
import { fetchInfo, postUrl, type PostInfo, YtdlpError } from './post.ts';

const USER_TTL = 30 * 86_400_000;

export interface GatherOptions {
  cacheDir: string;
  pages: InstagramPages | null;
  // Profiles of other accounts the post names, at most.
  related: number;
  links: boolean;
  refresh: boolean;
  log: (s: string) => void;
}

function cached<T>(file: string, refresh: boolean, ttl = Infinity): T | null {
  if (refresh || !fs.existsSync(file)) return null;
  const got = JSON.parse(fs.readFileSync(file, 'utf8')) as T & { fetchedAt?: string };
  if (got.fetchedAt && Date.now() - Date.parse(got.fetchedAt) > ttl) return null;
  return got;
}

function save(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: new Date().toISOString(), ...(value as object) }, null, 2));
}

// @handles in a caption, in order, without the trailing dot of a sentence.
export function mentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:^|[^\w.@])@([A-Za-z0-9._]{1,30})/g)) out.add(m[1].replace(/\.+$/, '').toLowerCase());
  return [...out].filter(Boolean);
}

// What a download already learned, so gathering doesn't ask again.
export function saveInfo(cacheDir: string, code: string, info: PostInfo): void {
  save(path.join(cacheDir, 'posts', `${code}.ytdlp.json`), info);
}

export async function postInfo(code: string, opts: Pick<GatherOptions, 'cacheDir' | 'refresh' | 'log'>): Promise<PostInfo> {
  const file = path.join(opts.cacheDir, 'posts', `${code}.ytdlp.json`);
  const hit = cached<PostInfo>(file, opts.refresh);
  if (hit) return hit;
  let info: PostInfo;
  try {
    info = (await fetchInfo(code)).info;
  } catch (e) {
    // Logged out, Instagram sometimes wants a login; the saved session can stand in.
    if (!(e instanceof YtdlpError && e.needsLogin && fs.existsSync(COOKIES))) throw e;
    opts.log(`  ${code}: yt-dlp needs a login (${e.message}); retrying with the saved session`);
    info = (await fetchInfo(code, COOKIES)).info;
  }
  save(file, info);
  return info;
}

async function viaPages<T>(file: string, ttl: number, opts: GatherOptions, load: (p: InstagramPages) => Promise<PageResult<T>>): Promise<T | undefined> {
  const hit = cached<PageResult<T>>(file, opts.refresh, ttl);
  if (hit && 'data' in hit) return hit.data;
  if (!opts.pages) return undefined;
  const r = await load(opts.pages);
  // Errors are kept too (not a login wall: that may pass), so a deleted
  // account isn't asked for again.
  if ('data' in r || !r.wall) save(file, r);
  if ('error' in r) opts.log(`  ${path.basename(file, '.json')}: ${r.error}`);
  return 'data' in r ? r.data : undefined;
}

export async function gatherPost(code: string, opts: GatherOptions): Promise<PostContext> {
  const info = await postInfo(code, opts);
  const page = await viaPages<IgMedia>(path.join(opts.cacheDir, 'posts', `${code}.page.json`), Infinity, opts, (p) => p.post(code));
  const handle = page?.user?.username ?? info.channel;
  const user = (name: string) => viaPages<IgUser>(path.join(opts.cacheDir, 'users', `${name.toLowerCase()}.json`), USER_TTL, opts, (p) => p.profile(name));
  const poster = handle ? await user(handle) : undefined;
  // Collaborators first, then tagged accounts, then caption mentions.
  const names = [...new Set([...(page?.coauthors ?? []).map((u) => u.username), ...(page?.tagged ?? []).map((u) => u.username), ...mentions(page?.caption ?? info.description ?? '')].map((n) => n.toLowerCase()))].filter((n) => n !== handle?.toLowerCase());
  const related: IgUser[] = [];
  for (const n of names.slice(0, opts.related)) {
    const u = await user(n);
    if (u) related.push(u);
  }
  const links: LinkPage[] = [];
  if (opts.links) {
    for (const l of (poster?.links ?? []).slice(0, 4)) {
      const file = path.join(opts.cacheDir, 'links', `${createHash('sha1').update(l.url).digest('hex').slice(0, 16)}.json`);
      const hit = cached<LinkPage>(file, opts.refresh, USER_TTL);
      if (hit) links.push(hit);
      else {
        const got = await readLink(l.url);
        save(file, got);
        links.push(got);
      }
    }
  }
  return { code, url: postUrl(code), info, ...(page ? { page } : {}), ...(poster ? { poster } : {}), related, links };
}
