// Who made an Instagram video, and the library fields around it, from what
// the earlier steps gathered. Layers, cheapest first:
//   post     caption, poster, tagged/collab accounts, music, top comments
//   profile  the poster's profile and those of accounts the post names
//   links    the pages the poster's bio links to (portfolio, Behance, ...)
//   search   Claude with web search, only for questions the rest left open
// The first three go to one structured call; search is a second call that
// starts from the first one's answer. URLs in the answer (website, project
// page) must appear in the material or the search results, or they're
// dropped as unverified.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { addUsage, cost, emptyUsage, type Usage } from '../lib/claude.ts';
import { AGGREGATOR, type LinkPage, readLink } from './links.ts';
import type { IgMedia, IgUser } from './pages.ts';
import type { PostInfo } from './post.ts';

export type Layer = 'post' | 'profile' | 'links' | 'search';
export const LAYERS: Layer[] = ['post', 'profile', 'links', 'search'];

// $ per web search (October 2026 list price); result pages bill as input tokens.
const SEARCH_PRICE = 0.01;

export interface PostContext {
  code: string;
  url: string;
  info: PostInfo;
  page?: IgMedia;
  poster?: IgUser;
  // Profiles of accounts the post names: collaborators, tagged, @mentioned.
  related: IgUser[];
  // The poster's bio links, read.
  links: LinkPage[];
}

const Credit = z.object({
  role: z.string().describe("what they did on the work, as the material says or plainly implies: 'Motion design', '3D', 'Direction', 'Editing', 'Music', 'Logo design'. Not 'poster', 'maker' or 'client'"),
  name: z.string(),
  handle: z.string().nullable().describe('Instagram handle without @, when known'),
});

export const PostRecord = z.object({
  maker: z.object({
    name: z.string().nullable().describe('who made the work, as they present themselves: a person or a studio. null when the material does not say'),
    handle: z.string().nullable().describe("the maker's Instagram handle without @"),
    type: z.enum(['person', 'studio', 'collective', 'unknown']),
    attribution: z.enum(['poster', 'someone else', 'unclear']).describe("'poster' when the posting account made the work (or is the studio behind it); 'someone else' when the material credits another maker (reposts, features, curator accounts); 'unclear' when nothing says. With 'unclear', still name the poster as the likely maker"),
    confidence: z.enum(['high', 'medium', 'low']).describe('how sure the material makes you of the maker'),
    real_name: z.string().nullable().describe("the maker's full name as a source states it (profile name, website title, Behance). Never build one from a handle"),
    website: z.string().nullable().describe("the maker's own portfolio, studio or home site, copied exactly from the material. Not a link-in-bio page (Linktree, bio.site), a store (Gumroad, Payhip, Bandcamp), a social profile or one project's page: when a link-in-bio page lists their site, give that site"),
  }),
  title: z.string().nullable().describe("the work's title when the caption gives one; otherwise a short descriptive title in English (3-6 words)"),
  title_from_caption: z.boolean().describe('true when the title is the one the caption gives'),
  description: z.string().nullable().describe('one or two sentences in English about the piece, from the caption'),
  client: z.string().nullable().describe('who the work was made for; null for personal work'),
  studio: z.string().nullable().describe('agency or production company behind the work, when it is not the maker'),
  year: z.string().nullable().describe('year the work was made, only when the material says so (a retrospective post naming its year); not the posting date'),
  credits: z.array(Credit).describe('the people and studios who made the work, the maker included, each with their role; the client goes in client, not here'),
  tools: z.array(z.string()).describe('software or hardware the material names, hashtags included (Blender, Houdini, Cavalry, After Effects, ...)'),
  disciplines: z.array(z.string()).describe('e.g. 3D animation, motion graphics, pixel animation, video editing, brand identity'),
  tags: z.array(z.string()).describe('a few subject and style tags'),
  project_url: z.string().nullable().describe('a page about this specific work (Behance case study, studio project page, Vimeo upload), copied exactly from the material'),
  open_questions: z.array(z.string()).describe('specific facts still unknown that a web search could settle, e.g. "full name and portfolio of the Blender artist @iruki.blend". Empty when the material already settles who made it and where to find them'),
});
export type PostRecord = z.infer<typeof PostRecord>;

export const SYSTEM = `You identify who made a short video posted on Instagram and fill in metadata for a motion-design reference library.

Use only the material you are given (and, when you have the tools, what you find on the web). Leave a field null or empty rather than guess: a wrong name is worse than none.

- The posting account is often the maker, but may be a curator, magazine or repost account. Signs of a repost: "via", "by @x", "🎥 @x", "credit:", "DM for credit/removal", a feed of many artists' work.
- An @mentioned or tagged account may be the client, a collaborator, the production company, the musician, or just a friend: decide from the caption's wording and that account's profile. A brand the work was made "for" is the client.
- A display name often carries a role ("Kate | Brand & Graphic Designer", "Yuma Garments｜映像作家"); the name is the part before the role. When sources give a name in both native script and Latin letters, write "Latin (native)".
- A real name is a full name (given and family name) that a source states: a profile name, a website title, a Behance page. A single first name, a stage name or a brand is not one. Never derive one from a handle or a URL (behance.net/katyashevchun does not say "Kate Shevchun").
- Other people's comments are reactions, questions and guesses ("Karma XPU?"), not facts about the work; only the poster's own words count.
- Hashtags often name software (#blender3d, #houdini, #cavalry, #eevee) and collectives.
- The year is when the work was made, only when the material says so. Captions written in other languages: read them, but write the description and any descriptive title in English.
- The project page is a page about this one piece: look for it among the maker's site's pages (a path named like the work), their Behance or their Vimeo. A homepage or profile is not one.
- Copy URLs exactly as they appear in the material; never construct one.`;

const fmt = (n?: number) => (n === undefined ? undefined : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : String(n));

function describeUser(u: IgUser, why: string): string {
  return [
    `@${u.username} (${why})`,
    u.fullName && `  name: ${u.fullName}`,
    u.category && `  category: ${u.category}`,
    u.biography && `  bio: ${u.biography.replace(/\n+/g, ' / ')}`,
    u.links.length && `  bio links: ${u.links.map((l) => (l.title ? `${l.title} ${l.url}` : l.url)).join(', ')}`,
    (u.followers !== undefined || u.verified) && `  ${[u.followers !== undefined && `${fmt(u.followers)} followers`, u.posts !== undefined && `${u.posts} posts`, u.verified && 'verified', u.private && 'private'].filter(Boolean).join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function describeLink(l: LinkPage): string {
  if (l.skipped) return `${l.url}: not read (${l.skipped})`;
  return [
    `${l.finalUrl ?? l.url}`,
    l.title && `  title: ${l.title}`,
    l.siteName && l.siteName !== l.title && `  site: ${l.siteName}`,
    l.h1 && l.h1 !== l.title && `  heading: ${l.h1}`,
    l.description && `  description: ${l.description}`,
    l.text && `  text: ${l.text.slice(0, 600)}`,
    l.links?.length && `  links out: ${l.links.slice(0, 25).join(' ')}`,
    l.pages?.length && `  pages on the site: ${l.pages.join(' ')}`,
  ]
    .filter(Boolean)
    .join('\n');
}

// The material for one post, as far as the layers go.
export function describePost(c: PostContext, layers: Set<Layer>): string {
  const p = c.page;
  const handle = p?.user?.username ?? c.info.channel;
  const name = p?.user?.fullName ?? c.info.uploader;
  const caption = p?.caption ?? c.info.description ?? '';
  const date = p?.takenAt ?? (c.info.timestamp ? new Date(c.info.timestamp * 1000).toISOString() : undefined);
  const own = c.info.comments.filter((x) => x.author === handle);
  const others = c.info.comments.filter((x) => x.author !== handle).slice(0, 10);
  const lines = [
    `Instagram post ${c.url}`,
    `Posted by @${handle}${name && name !== handle ? ` (display name: ${name})` : ''}${date ? ` on ${date.slice(0, 10)}` : ''}`,
    `Videos in the post: ${Math.max(1, c.info.videos.length)}${p?.slides?.length ? ` (carousel of ${p.slides.length} slides)` : ''}`,
    p?.coauthors.length && `Collaborators (co-posted): ${p.coauthors.map((u) => `@${u.username}${u.fullName ? ` (${u.fullName})` : ''}`).join(', ')}`,
    p?.tagged.length && `Tagged on the post: ${p.tagged.map((u) => `@${u.username}${u.fullName ? ` (${u.fullName})` : ''}`).join(', ')}`,
    p?.location && `Location: ${p.location}`,
    p?.music && `Audio: ${p.music.original ? 'original audio' : 'track'}${p.music.title ? ` "${p.music.title}"` : ''}${p.music.artist ? ` by ${p.music.artist}` : ''}`,
    p?.aiLabel && `Instagram AI label: ${p.aiLabel}`,
    '',
    'Caption:',
    caption || '(none)',
    own.length ? `\nThe poster's own comments:\n${own.map((x) => `- ${x.text}`).join('\n')}` : '',
    others.length ? `\nTop comments:\n${others.map((x) => `- @${x.author}: ${x.text.slice(0, 200)}`).join('\n')}` : '',
  ];
  if (layers.has('profile')) {
    if (c.poster) lines.push('', 'Profiles:', describeUser(c.poster, 'the poster'));
    for (const u of c.related) lines.push(describeUser(u, relation(c, u.username)));
  }
  if (layers.has('links') && c.links.length) lines.push('', "Pages the poster's bio links to:", ...c.links.map(describeLink));
  return lines.filter((l): l is string => typeof l === 'string').join('\n');
}

export function relation(c: PostContext, username: string): string {
  if (c.page?.coauthors.some((u) => u.username === username)) return 'collaborator on the post';
  if (c.page?.tagged.some((u) => u.username === username)) return 'tagged on the post';
  return 'mentioned in the caption';
}

// Every URL the material shows, for checking the answer's URLs against.
export function urlsIn(text: string): Set<string> {
  return new Set([...text.matchAll(/https?:\/\/[^\s"'<>),]+/g)].map((m) => normUrl(m[0])));
}

export const normUrl = (u: string) => u.toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[/#?]+$/, '');

export interface Enriched {
  record: PostRecord;
  layers: Layer[];
  // Set when the search pass ran: what it searched and read.
  search?: { queries: string[]; sources: string[]; requests: number };
  // URLs the model gave that the material doesn't contain.
  dropped: string[];
  usage: Usage;
  cost: number | null;
  model: string;
}

export interface EnrichOptions {
  model: string;
  searchModel?: string;
  // Searches allowed per post.
  maxSearches?: number;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

// A URL the material doesn't show, fetched: it counts when the page names
// the maker (or their handle) or the work.
async function vouches(url: string, r: PostRecord): Promise<boolean> {
  if (!/^https?:\/\//i.test(url)) return false;
  const page = await readLink(url);
  if (page.skipped) return false;
  const text = [page.title, page.siteName, page.h1, page.description, page.text].filter(Boolean).join(' ').toLowerCase();
  const names = [r.maker.name, r.maker.real_name, r.maker.handle, r.title].filter((n): n is string => !!n && n.length >= 4);
  return names.some((n) => text.includes(n.toLowerCase()));
}

// Whether a first-pass answer leaves enough open to pay for a search.
export function wantsSearch(r: PostRecord): boolean {
  return r.open_questions.length > 0 || r.maker.attribution !== 'poster' || !r.maker.website || (r.maker.type === 'person' && !r.maker.real_name);
}

export async function enrichPost(client: Anthropic, c: PostContext, layers: Set<Layer>, opts: EnrichOptions): Promise<Enriched> {
  const material = describePost(c, layers);
  const usage = emptyUsage();
  const first = await client.beta.messages.parse({
    model: opts.model,
    max_tokens: 4000,
    output_config: { effort: 'low', format: betaZodOutputFormat(PostRecord) },
    system: SYSTEM,
    messages: [{ role: 'user', content: material }],
  });
  addUsage(usage, first.usage);
  if (first.stop_reason === 'refusal' || !first.parsed_output) throw new Error(first.stop_reason === 'refusal' ? 'declined' : `no structured output (${first.stop_reason})`);
  let record = first.parsed_output;
  let spent = cost(opts.model, usage);
  const known = urlsIn(material);
  let search: Enriched['search'];

  if (layers.has('search') && wantsSearch(record)) {
    const model = opts.searchModel ?? opts.model;
    const susage = emptyUsage();
    const queries: string[] = [];
    const sources = new Set<string>();
    const ask = [
      material,
      '',
      'A first pass over this material answered:',
      JSON.stringify(record, null, 1),
      '',
      `Search the web to settle what is still open${record.open_questions.length ? `:\n${record.open_questions.map((q) => `- ${q}`).join('\n')}` : ': who made this, their full name and their portfolio site'}${record.project_url ? '' : "\nAlso look for this work's own page (on the maker's site, Behance or Vimeo)."}`,
      'Before you use a person, studio or site you find, make sure it is the same as this Instagram account: the same handle, a link to it, or the same work. Open a website or project page with web_fetch before you give it: URLs you only glimpsed inside a result are dropped. Then return the full record, updated; keep what the first pass got right.',
    ].join('\n');
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: ask }];
    let answer: PostRecord | null = null;
    // A long search turn can pause; send it back to continue.
    for (let turn = 0; turn < 3; turn++) {
      const res = await client.beta.messages.parse({
        model,
        max_tokens: 6000,
        output_config: { effort: 'low', format: betaZodOutputFormat(PostRecord) },
        system: SYSTEM,
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: opts.maxSearches ?? 3 },
          { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 3, max_content_tokens: 6000 },
        ],
        messages,
      });
      addUsage(susage, res.usage);
      const requests = res.usage.server_tool_use?.web_search_requests ?? 0;
      for (const b of res.content) {
        if (b.type === 'server_tool_use' && b.name === 'web_search') queries.push(String((b.input as { query?: string }).query ?? ''));
        if (b.type === 'server_tool_use' && b.name === 'web_fetch') sources.add(String((b.input as { url?: string }).url ?? ''));
        if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const r of b.content) sources.add(r.url);
        if (b.type === 'web_fetch_tool_result' && b.content.type === 'web_fetch_result') sources.add(b.content.url);
      }
      search = { queries, sources: [...sources].filter(Boolean), requests: (search?.requests ?? 0) + requests };
      if (res.stop_reason !== 'refusal' && res.parsed_output) answer = res.parsed_output;
      if (res.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: res.content as Anthropic.Beta.BetaContentBlockParam[] });
    }
    const s = (cost(model, susage) ?? 0) + (search?.requests ?? 0) * SEARCH_PRICE;
    spent = spent === null ? null : spent + s;
    addUsage(usage, { input_tokens: susage.input, output_tokens: susage.output, cache_read_input_tokens: susage.cacheRead, cache_creation_input_tokens: susage.cacheWrite });
    if (answer) record = answer;
    for (const u of search?.sources ?? []) known.add(normUrl(u));
  }

  // The post's licensed track is a fact on the page, not the model's call.
  const music = c.page?.music;
  if (music?.artist && !music.original && !record.credits.some((x) => x.name.toLowerCase().includes(music.artist!.toLowerCase()))) {
    record = { ...record, credits: [...record.credits, { role: 'Music', name: music.title ? `${music.artist} — ${music.title}` : music.artist, handle: null }] };
  }

  // URLs must come from somewhere we saw, or check out when fetched: a
  // search can surface a URL only inside a result's (encrypted) content.
  const dropped: string[] = [];
  const check = async (u: string | null) => {
    if (!u) return null;
    if (known.has(normUrl(u)) || (await vouches(u, record))) return u;
    dropped.push(u);
    return null;
  };
  // A link-in-bio page stays among the bio links; it isn't their website.
  const site = record.maker.website && AGGREGATOR.test(hostOf(record.maker.website)) ? null : record.maker.website;
  record = { ...record, maker: { ...record.maker, website: await check(site) }, project_url: await check(record.project_url) };
  return { record, layers: [...layers], ...(search ? { search } : {}), dropped, usage, cost: spent, model: opts.model };
}
