// From an enrichment answer to the library's fields: who made the clip
// (shown as Creator, with their profile and bio links) and the project
// fields (title, client, studio, year, credits, tags). Shared by the
// importer and the eval, so the eval scores what the library shows.

import type { ProjectInfo, ScrapedItem } from '../scrape/types.ts';
import { normUrl, type PostContext, type PostRecord } from './enrich.ts';

// Who made it, as the library shows them: the credited maker when the post
// is someone else's work (their profile and bio links when we read them),
// else the poster. Links are the bio's, minus Instagram itself.
export function creatorOf(ctx: PostContext, r: PostRecord | undefined, poster: string): NonNullable<ScrapedItem['creator']> {
  // The bio's links, minus Instagram, plus a website found elsewhere (search).
  const bio = (links: { title?: string; url: string }[] = []) => {
    const out = links.filter((l) => !/(^|\.)instagram\.com$/i.test(hostOf(l.url)));
    const site = r?.maker.website;
    if (site && !out.some((l) => normUrl(l.url) === normUrl(site))) out.push({ title: 'Website', url: site });
    return out;
  };
  if (r?.maker.attribution === 'someone else') {
    const handle = r.maker.handle?.replace(/^@/, '') || undefined;
    const profile = handle ? ctx.related.find((u) => u.username.toLowerCase() === handle.toLowerCase()) : undefined;
    const name = r.maker.real_name ?? r.maker.name ?? profile?.fullName;
    const links = bio(profile?.links);
    return { ...(name ? { name } : {}), ...(handle ? { handle, url: `https://www.instagram.com/${handle}/` } : {}), ...(links.length ? { links } : {}) };
  }
  const name = r?.maker.real_name ?? r?.maker.name ?? ctx.poster?.fullName;
  const links = bio(ctx.poster?.links);
  return { ...(name ? { name } : {}), handle: poster, url: `https://www.instagram.com/${poster}/`, ...(links.length ? { links } : {}) };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// The library's project fields. The maker is the studio unless an agency
// or production company is named; either way they lead the credits.
export function projectOf(r: PostRecord, posted?: string): ProjectInfo {
  const maker = r.maker.real_name ?? r.maker.name;
  const withHandle = (name: string, handle: string | null) => (handle && !name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(handle.toLowerCase().replace(/[^a-z0-9]/g, '')) ? `${name} (@${handle})` : name);
  const credits = r.credits.map((c) => ({ role: c.role, name: withHandle(c.name, c.handle) }));
  const named = (n: string) => credits.some((c) => c.name.toLowerCase().includes(n.toLowerCase()));
  if (maker && !named(maker) && !(r.maker.name && named(r.maker.name))) credits.unshift({ role: 'Made by', name: withHandle(maker, r.maker.handle) });
  return {
    title: r.title,
    client: r.client,
    agency: r.studio ?? maker,
    year: r.year ?? posted?.slice(0, 4) ?? null,
    description: r.description,
    disciplines: r.disciplines,
    credits,
    tags: [...new Set([...r.tools, ...r.tags])],
    source: 'enrich',
  };
}
