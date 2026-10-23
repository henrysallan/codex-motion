// --enrich: one structured-output call per page with videos, turning the
// page's text into project fields (title, client, agency, year, credits,
// disciplines, tags) and a name for each video on it. The raw page
// metadata is kept regardless; this adds a clean layer on top.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { addUsage, cost, emptyUsage, takesFallback } from '../lib/claude.ts';
import { looksLikeFilename } from './urls.ts';
import { pool } from '../lib/ffmpeg.ts';
import type { PageMeta, ProjectInfo, ScrapedItem } from './types.ts';

const Enrichment = z.object({
  is_project_page: z.boolean().describe('true when the page presents one piece of work (a project or case study), not a listing or about page'),
  project: z.object({
    title: z.string().nullable(),
    client: z.string().nullable(),
    agency: z.string().nullable().describe('agency or production company, when not the site itself'),
    year: z.string().nullable(),
    description: z.string().nullable().describe("one or two sentences in the site's own words"),
    disciplines: z.array(z.string()).describe('e.g. 3D, cel animation, motion graphics, live action, title design'),
    credits: z.array(z.object({ role: z.string(), name: z.string() })),
    tags: z.array(z.string()),
  }),
  videos: z.array(z.object({ index: z.number().int(), title: z.string().nullable(), description: z.string().nullable() })),
});

const SYSTEM = `You extract structured facts about creative work from a studio or agency web page, for a motion-design reference library. Use only what the page states; leave a field null or empty rather than guess. Keep names and titles as the page writes them. A player title is often just the uploaded file's name ("Amazon_CS_04_System"); never use one of those as a title — give the video a short readable title from the page instead, or null.`;

export interface PageVideos {
  url: string;
  meta: PageMeta;
  items: ScrapedItem[];
}

export async function enrichPages(pages: PageVideos[], model: string, log: (s: string) => void): Promise<{ done: number; spent: number | null }> {
  const client = new Anthropic({ maxRetries: 4 });
  const usage = emptyUsage();
  let done = 0;
  await pool(pages, 6, async (p) => {
    try {
      const response = await client.beta.messages.parse({
        model,
        max_tokens: 4000,
        // Pulling fields out of a page needs little reasoning.
        output_config: { effort: 'low', format: betaZodOutputFormat(Enrichment) },
        ...(model.startsWith('claude-haiku') ? { thinking: { type: 'disabled' as const } } : {}),
        system: SYSTEM,
        messages: [{ role: 'user', content: describePage(p) }],
        // On a safety decline the API retries on a fallback model; Haiku has none.
        ...(takesFallback(model) ? { fallbacks: 'default' as const, betas: ['server-side-fallback-2026-07-01'] } : {}),
      });
      addUsage(usage, response.usage);
      const out = response.parsed_output;
      if (response.stop_reason === 'refusal' || !out) throw new Error(response.stop_reason === 'refusal' ? 'declined' : 'no structured output');
      apply(p, out);
      done++;
    } catch (e) {
      log(`  enrich ${p.url}: ${e instanceof Anthropic.APIError ? `API error ${e.status}` : (e as Error).message}`);
    }
  });
  return { done, spent: cost(model, usage) };
}

function describePage(p: PageVideos): string {
  const m = p.meta;
  const videos = p.items.map((item, i) => {
    const a = item.appearances.find((x) => x.pageUrl === p.url) ?? item.appearances[0];
    const bits = [a.context?.heading && `heading "${a.context.heading}"`, a.context?.caption && `caption "${a.context.caption}"`, a.context?.text && `nearby text "${a.context.text}"`, item.embed?.title && `player title "${String(item.embed.title)}"`];
    return `${i}. ${bits.filter(Boolean).join('; ') || 'no surrounding text'}`;
  });
  return [
    `URL: ${p.url}`,
    m.title && `Title: ${m.title}`,
    m.og.site_name && `Site: ${m.og.site_name}`,
    m.description && `Description: ${m.description}`,
    m.h1 && `H1: ${m.h1}`,
    '',
    'Videos on the page:',
    ...videos,
    '',
    'Page text:',
    m.text.slice(0, 10_000),
  ]
    .filter((l): l is string => typeof l === 'string')
    .join('\n');
}

function apply(p: PageVideos, out: z.infer<typeof Enrichment>): void {
  const pr = out.project;
  const has = pr.title || pr.client || pr.description || pr.credits.length;
  const project: ProjectInfo = { ...pr, source: 'enrich' };
  p.items.forEach((item, i) => {
    // The primary page decides; a homepage reel doesn't inherit a project.
    if (has && out.is_project_page && item.page.url === p.url && item.project?.source !== 'agent') item.project = project;
    const v = out.videos.find((x) => x.index === i);
    // The video's own title from the page wins; the project's title only
    // replaces a weak one (a page-level guess or an upload's file name).
    const own = v?.title && !looksLikeFilename(v.title) ? v.title : null;
    const weak = item.titleSource === 'page' || item.titleSource === 'url' || looksLikeFilename(item.title);
    const title = own ?? (out.is_project_page && weak ? pr.title : null);
    if (title && item.page.url === p.url) {
      item.title = title.slice(0, 160);
      item.titleSource = 'project';
    }
    if (v?.description && item.page.url === p.url) item.project = { ...(item.project ?? { source: 'enrich' }), description: item.project?.description ?? v.description };
  });
}
