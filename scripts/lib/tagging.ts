// The visual tagging request: the prompt with the motion vocabulary, the
// answer's schema, and how an answer becomes `analysis` tags. Shared by the
// library tagger (scripts/tag.ts) and in-app enrichment of uploads
// (api/enrich.ts), so both tag the same way.

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Asset } from '../../src/media/library.ts';
import { labels, slug, TAG_GROUPS, type TagGroup, VOCABULARY } from '../../src/media/vocabulary.ts';

// Plain strings, checked against the vocabulary in code: schema enums held
// for ~98% of clips, and the rest failed whole over one stray value.
const group = (g: TagGroup) => z.array(z.string()).describe(`values from: ${labels(g).map(slug).join(', ')}`);
export const Tags = z.object({
  caption: z.string().describe('one plain sentence: what is shown and how it moves'),
  technique: group('technique'),
  camera: group('camera'),
  easing: group('easing'),
  pacing: group('pacing'),
  use: group('use'),
  visual: z.array(z.string()).describe('up to 8 short lowercase tags for subjects, materials, colours and style'),
});
export type TagsOut = z.infer<typeof Tags>;

export const TAG_SYSTEM = `You tag short clips for a motion-design reference library. Each clip arrives as one image: a contact sheet of 16 frames sampled evenly through the clip, in time order, left to right and top to bottom. Read motion from how the frames change: what moves, what the camera does, how often the picture cuts.

Use only the values below, and only where the definition clearly fits what the frames show. An empty list is better than a guess.
- technique: every technique that is clearly present.
- camera: what the virtual or real camera does; most motion graphics are static.
- easing and pacing: hard to judge from stills, so only when the frames make them evident.
- use: the clip's purpose. Usually none or one, at most two. A clip that happens to show a logo or some type is not a logo reveal or a title sequence.

${TAG_GROUPS.map((g) => `${g}:\n${labels(g).map((l) => `  ${slug(l)}: ${(VOCABULARY[g] as Record<string, string>)[l]}`).join('\n')}`).join('\n')}

The caption is one plain sentence about what is shown and how it moves, without praise. Visual tags are up to 8 short lowercase words or phrases for subjects, materials, colours and style, such as "chrome", "typography", "isometric", "pastel".`;

// What the site said about the clip, as a hint; the frames decide.
export function describeClip(a: Asset): string {
  const s = a.source;
  const lines = [`Title: ${s?.title || a.name}`, `Duration: ${a.duration.toFixed(1)} s, ${a.width}x${a.height}`];
  if (s) {
    lines.push(`From: ${s.siteName ?? s.site}${s.client ? `, for ${s.client}` : ''}${s.year ? `, ${s.year}` : ''}`);
    if (s.description) lines.push(`Project: ${s.description.slice(0, 400)}`);
    if (s.tags?.length) lines.push(`Site tags: ${s.tags.join(', ')}`);
  }
  return lines.join('\n');
}

// The user turn: the sheet (a base64 JPEG), then the hint text. `note` is
// an extra line, such as that the clip is a still.
export function tagContent(sheet: string, a: Asset, note?: string): Anthropic.ContentBlockParam[] {
  return [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sheet } },
    { type: 'text', text: note ? `${describeClip(a)}\n${note}` : describeClip(a) },
  ];
}

const groupOf = new Map(TAG_GROUPS.flatMap((g) => labels(g).map((l) => [slug(l), g] as const)));

// Vocabulary values land in their own group whichever list the model put
// them in; anything else is set aside (kept in tags.json as offVocabulary,
// a hint for growing the vocabulary).
export function flattenTags(t: TagsOut): { tags: string[]; offVocabulary: string[] } {
  const tags = new Set<string>();
  const off: string[] = [];
  for (const g of TAG_GROUPS) {
    for (const raw of t[g]) {
      const v = slug(raw);
      const home = groupOf.get(v);
      if (home) tags.add(`${home}:${v}`);
      else if (v) off.push(`${g}:${v}`);
    }
  }
  const visual = [...new Set(t.visual.map((v) => slug(v)).filter((v) => v && !groupOf.has(v)))].slice(0, 8);
  return { tags: [...[...tags].sort((a, b) => TAG_GROUPS.indexOf(a.split(':')[0] as TagGroup) - TAG_GROUPS.indexOf(b.split(':')[0] as TagGroup)), ...visual.map((v) => `visual:${v}`)], offVocabulary: off };
}
