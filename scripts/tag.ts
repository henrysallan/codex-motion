// Visual tags for the library. Each clip becomes one contact sheet (16
// frames from its L1 proxy, in time order) and goes to a small vision model
// with the spec's motion vocabulary. Back comes a one-line caption, tags
// from the vocabulary only, and a few free visual tags (subjects,
// materials, colour, style). Clips already tagged are skipped.
//
//   node scripts/tag.ts [--estimate] [--limit n] [--only <site|id>] [--force] [--model claude-haiku-5-5]
//
// --estimate counts tokens on a sample of sheets (free) and projects what
// tagging everything left would cost, without tagging anything.
//
// Writes <id>/tags.json (the full answer and its usage), `analysis` in
// <id>/asset.json, and library.json.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Asset, AssetAnalysis, Library } from '../src/media/library.ts';
import { labels, slug, TAG_GROUPS, type TagGroup, VOCABULARY } from '../src/media/vocabulary.ts';
import { addUsage, BULK_MODEL, cost, dollars, emptyUsage, hasCredentials, loadEnv, price } from './lib/claude.ts';
import { arg, assertFfmpeg, pool } from './lib/ffmpeg.ts';
import { contactSheet } from './lib/frames.ts';

loadEnv();
if (!hasCredentials()) {
  console.error('tagging needs ANTHROPIC_API_KEY (in the environment or .env.local)');
  process.exit(1);
}
assertFfmpeg();

const model = arg('model', BULK_MODEL);
const outRoot = path.resolve(arg('out', 'public/media'));
const publicRoot = path.resolve('public');
const only = arg('only', '');
const limit = Number(arg('limit', '0')) || Infinity;
const force = process.argv.includes('--force');
const estimate = process.argv.includes('--estimate');
// Expected answer length, for estimates: caption, tags, JSON.
const OUTPUT_GUESS = 250;

const libraryPath = path.join(outRoot, 'library.json');
const readLibrary = () => JSON.parse(fs.readFileSync(libraryPath, 'utf8')) as Library;
const library = readLibrary();

// Plain strings, checked against the vocabulary in code: schema enums held
// for ~98% of clips, and the rest failed whole over one stray value.
const group = (g: TagGroup) => z.array(z.string()).describe(`values from: ${labels(g).map(slug).join(', ')}`);
const Tags = z.object({
  caption: z.string().describe('one plain sentence: what is shown and how it moves'),
  technique: group('technique'),
  camera: group('camera'),
  easing: group('easing'),
  pacing: group('pacing'),
  use: group('use'),
  visual: z.array(z.string()).describe('up to 8 short lowercase tags for subjects, materials, colours and style'),
});
type TagsOut = z.infer<typeof Tags>;

const SYSTEM = `You tag short clips for a motion-design reference library. Each clip arrives as one image: a contact sheet of 16 frames sampled evenly through the clip, in time order, left to right and top to bottom. Read motion from how the frames change: what moves, what the camera does, how often the picture cuts.

Use only the values below, and only where the definition clearly fits what the frames show. An empty list is better than a guess.
- technique: every technique that is clearly present.
- camera: what the virtual or real camera does; most motion graphics are static.
- easing and pacing: hard to judge from stills, so only when the frames make them evident.
- use: the clip's purpose. Usually none or one, at most two. A clip that happens to show a logo or some type is not a logo reveal or a title sequence.

${TAG_GROUPS.map((g) => `${g}:\n${labels(g).map((l) => `  ${slug(l)}: ${(VOCABULARY[g] as Record<string, string>)[l]}`).join('\n')}`).join('\n')}

The caption is one plain sentence about what is shown and how it moves, without praise. Visual tags are up to 8 short lowercase words or phrases for subjects, materials, colours and style, such as "chrome", "typography", "isometric", "pastel".`;

// What the site said about the clip, as a hint; the frames decide.
function describe(a: Asset): string {
  const s = a.source;
  const lines = [`Title: ${a.name}`, `Duration: ${a.duration.toFixed(1)} s, ${a.width}x${a.height}`];
  if (s) {
    lines.push(`From: ${s.siteName ?? s.site}${s.client ? `, for ${s.client}` : ''}${s.year ? `, ${s.year}` : ''}`);
    if (s.description) lines.push(`Project: ${s.description.slice(0, 400)}`);
    if (s.tags?.length) lines.push(`Site tags: ${s.tags.join(', ')}`);
  }
  return lines.join('\n');
}

const client = new Anthropic({ maxRetries: 4 });
const thinking = model.startsWith('claude-haiku') ? ({ type: 'disabled' } as const) : undefined;
const sheetDir = path.resolve('media/.sheets');
fs.mkdirSync(sheetDir, { recursive: true });

async function request(a: Asset): Promise<{ system: string; content: Anthropic.ContentBlockParam[] }> {
  const sheet = path.join(sheetDir, `${a.id}.jpg`);
  await contactSheet(path.join(publicRoot, a.l1.url), sheet, a);
  const data = fs.readFileSync(sheet).toString('base64');
  fs.rmSync(sheet, { force: true });
  return {
    system: SYSTEM,
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
      { type: 'text', text: describe(a) },
    ],
  };
}

const groupOf = new Map(TAG_GROUPS.flatMap((g) => labels(g).map((l) => [slug(l), g] as const)));

// Vocabulary values land in their own group whichever list the model put
// them in; anything else is set aside (kept in tags.json as offVocabulary,
// a hint for growing the vocabulary).
function flatten(t: TagsOut): { tags: string[]; offVocabulary: string[] } {
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

const matches = (a: Asset) => !only || a.id.startsWith(only) || a.source?.site === only;
const todo = library.assets.filter((a) => matches(a) && (force || !a.analysis)).slice(0, limit);
const [inPrice, outPrice] = price(model) ?? [0, 0, 0];

// ---- estimate -----------------------------------------------------------------------

if (estimate) {
  if (!todo.length) {
    console.log('nothing left to tag');
    process.exit(0);
  }
  const step = Math.max(1, Math.floor(todo.length / 20));
  const sample = todo.filter((_, i) => i % step === 0).slice(0, 20);
  let total = 0;
  await pool(sample, 4, async (a) => {
    const r = await request(a);
    const n = await client.messages.countTokens({ model, system: r.system, messages: [{ role: 'user', content: r.content }], output_config: { format: zodOutputFormat(Tags) }, ...(thinking ? { thinking } : {}) });
    total += n.input_tokens;
  });
  const avgIn = total / sample.length;
  const each = (avgIn * inPrice + OUTPUT_GUESS * outPrice) / 1e6;
  console.log(`${model}: ~${Math.round(avgIn)} input tokens per clip (sample of ${sample.length}), ~${OUTPUT_GUESS} output`);
  console.log(`${todo.length} clips to tag: ~${dollars(each * todo.length)} (${dollars(each)} each; about half that through the Batch API)`);
  process.exit(0);
}

// ---- tag ----------------------------------------------------------------------------

console.log(`tagging ${todo.length} clips with ${model}`);
const usage = emptyUsage();
const results = new Map<string, AssetAnalysis>();
let done = 0;
let failed = 0;
const t0 = performance.now();

// Re-read before writing so a library rebuilt meanwhile isn't clobbered.
function saveLibrary(): void {
  const lib = readLibrary();
  for (const a of lib.assets) {
    const r = results.get(a.id);
    if (r) a.analysis = r;
  }
  fs.writeFileSync(libraryPath, JSON.stringify(lib));
}

await pool(todo, 6, async (a) => {
  try {
    const r = await request(a);
    const response = await client.messages.parse({
      model,
      max_tokens: 1024,
      system: r.system,
      messages: [{ role: 'user', content: r.content }],
      output_config: { effort: 'low', format: zodOutputFormat(Tags) },
      ...(thinking ? { thinking } : {}),
    });
    addUsage(usage, response.usage);
    if (response.stop_reason === 'refusal') throw new Error('declined');
    const out = response.parsed_output;
    if (!out) throw new Error(`no structured output (${response.stop_reason})`);
    const { tags, offVocabulary } = flatten(out);
    const analysis: AssetAnalysis = { caption: out.caption.trim(), tags, model, at: new Date().toISOString() };
    const dir = path.join(outRoot, a.id);
    fs.writeFileSync(path.join(dir, 'tags.json'), JSON.stringify({ ...out, offVocabulary, model, at: analysis.at, usage: response.usage }, null, 2));
    const assetPath = path.join(dir, 'asset.json');
    const stored = JSON.parse(fs.readFileSync(assetPath, 'utf8')) as Asset;
    fs.writeFileSync(assetPath, JSON.stringify({ ...stored, analysis }, null, 2));
    results.set(a.id, analysis);
  } catch (e) {
    failed++;
    const why = e instanceof Anthropic.APIError ? `API error ${e.status}: ${e.message}` : (e as Error).message;
    console.error(`\n${a.id} ${a.name}: ${why}`);
  }
  done++;
  if (done % 25 === 0) saveLibrary();
  if (process.stdout.isTTY) process.stdout.write(`\r  ${done}/${todo.length}  ${dollars(cost(model, usage))}`);
});
saveLibrary();
const spent = cost(model, usage);
console.log(
  `\n${results.size} tagged in ${((performance.now() - t0) / 1000).toFixed(0)}s${failed ? `, ${failed} failed` : ''}; ` +
    `${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out tokens, ${dollars(spent)}` +
    (results.size ? ` (${dollars((spent ?? 0) / results.size)} per clip)` : ''),
);
process.exitCode = failed ? 1 : 0;
