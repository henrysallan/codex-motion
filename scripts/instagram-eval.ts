// Scores the Instagram enrichment against a hand-checked reference set,
// layer by layer, to show what each layer buys and how it fails.
//
//   node scripts/instagram-eval.ts [--gold media/scraped/instagram.com/eval/gold.json]
//                                  [--reps 3] [--configs post,profile,links,search]
//   node scripts/instagram-eval.ts --rescore <run.json>   # score saved answers against an edited gold set
//
// Every post in the gold set must already be gathered (npm run instagram
// caches its pages); the eval reads only the cache, so it sends Instagram
// nothing. Each config adds one layer to the one before:
//   post     caption, tagged/collab accounts, music, comments
//   profile  + profiles of the poster and the accounts the post names
//   links    + the poster's bio-link pages
//   search   + Claude web search when the rest leaves questions open
// Each runs --reps times (the model isn't deterministic). Fields are scored
// by rule where they can be (names against aliases, URLs, years, tools) and
// by a Haiku judge where they can't (a title or client in other words).
// Results land in <eval dir>/run-<time>.json; the summary prints.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { addUsage, BULK_MODEL, cost, dollars, emptyUsage, loadEnv } from './lib/claude.ts';
import { pool } from './lib/ffmpeg.ts';
import { enrichPost, type Layer, LAYERS, normUrl, type PostContext, type PostRecord } from './instagram/enrich.ts';
import { gatherPost } from './instagram/gather.ts';
import { creatorOf } from './instagram/record.ts';

const { values: flags } = parseArgs({
  options: {
    gold: { type: 'string', default: path.join('media', 'scraped', 'instagram.com', 'eval', 'gold.json') },
    cache: { type: 'string', default: path.join('media', 'scraped', 'instagram.com', '.cache') },
    reps: { type: 'string', default: '3' },
    configs: { type: 'string', default: LAYERS.join(',') },
    model: { type: 'string', default: BULK_MODEL },
    'search-model': { type: 'string' },
    rescore: { type: 'string' },
  },
});
loadEnv();

// ---- gold ---------------------------------------------------------------------------

// The gold set writes scalars as { value, aliases } (or null); accept plain strings too.
// A low-confidence gold value is too thin to score against.
type Scalar = { value: string | null; aliases: string[]; low?: boolean };
function scalar(x: unknown): Scalar {
  if (x === null || x === undefined) return { value: null, aliases: [] };
  if (typeof x !== 'object') return { value: String(x), aliases: [] };
  const o = x as { value?: unknown; aliases?: unknown; name?: unknown; confidence?: unknown };
  const v = o.value ?? o.name ?? null;
  return { value: v === null || v === undefined ? null : String(v), aliases: Array.isArray(o.aliases) ? o.aliases.map(String) : [], ...(o.confidence === 'low' ? { low: true } : {}) };
}
const all = (s: Scalar) => (s.value ? [s.value, ...s.aliases] : s.aliases);

interface GoldPost {
  code: string;
  maker: { name: Scalar; handle: string | null; isPoster: boolean | null; realName: Scalar; website: Scalar; type?: string; alternates: string[] };
  title: Scalar;
  client: Scalar;
  studio: Scalar;
  year: Scalar;
  credits: { role: string; names: string[] }[];
  tools: Scalar[];
  projectUrl: Scalar;
  notes?: string;
  difficulty?: string;
}

function readGold(file: string): GoldPost[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { posts: Record<string, unknown>[] };
  return raw.posts.map((p) => {
    const m = (p.maker ?? {}) as Record<string, unknown>;
    const isPoster = scalar(m.isPoster).value;
    return {
      code: String(p.code),
      maker: {
        name: scalar(m.name ?? m.value),
        handle: scalar(m.handle).value?.replace(/^@/, '') ?? null,
        isPoster: isPoster === null ? null : isPoster === 'true',
        realName: scalar(m.realName),
        website: scalar(m.website),
        ...(scalar(m.type).value ? { type: scalar(m.type).value! } : {}),
        alternates: (Array.isArray(m.alternates) ? m.alternates : []).flatMap((a) => all(scalar(a))),
      },
      title: scalar(p.title),
      client: scalar(p.client),
      studio: scalar(p.studio),
      year: scalar(p.year),
      credits: (Array.isArray(p.credits) ? p.credits : []).map((c: Record<string, unknown>) => ({ role: String(c.role ?? ''), names: all(scalar(c.name ?? c)).concat(Array.isArray(c.aliases) ? c.aliases.map(String) : []) })),
      tools: (Array.isArray(p.tools) ? p.tools : []).map(scalar).filter((t) => !!t.value),
      projectUrl: scalar(p.projectUrl),
      ...(typeof p.notes === 'string' ? { notes: p.notes } : {}),
      ...(typeof p.difficulty === 'string' ? { difficulty: p.difficulty } : {}),
    };
  });
}

// ---- scoring ------------------------------------------------------------------------

// correct: matches the gold value; empty: correctly left empty (gold has none);
// partial: right but incomplete or hedged; missing: empty though gold has one;
// wrong: a different value; unsupported: a value where gold has none.
// unscored: gold's own answer is low-confidence; left out of the rates.
export type Outcome = 'correct' | 'empty' | 'partial' | 'missing' | 'wrong' | 'unsupported' | 'unscored';
const GOOD: Outcome[] = ['correct', 'empty'];

const squash = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function sameName(pred: string, gold: string[]): boolean {
  const p = squash(pred);
  if (!p) return false;
  return gold.some((g) => {
    const q = squash(g);
    return !!q && (p === q || (Math.min(p.length, q.length) >= 4 && (p.includes(q) || q.includes(p))));
  });
}

const sameUrl = (pred: string, gold: string[]) => gold.some((g) => normUrl(g) === normUrl(pred));

function byRule(pred: string | null, gold: Scalar, same: (p: string, g: string[]) => boolean): Outcome | null {
  if (gold.low) return pred && gold.value && same(pred, all(gold)) ? 'correct' : 'unscored';
  if (!gold.value) return pred ? 'unsupported' : 'empty';
  if (!pred) return 'missing';
  return same(pred, all(gold)) ? 'correct' : null;
}

const Judged = z.object({
  verdicts: z.array(z.object({ field: z.string(), verdict: z.enum(['correct', 'partial', 'wrong']), why: z.string() })),
});

const judgeUsage = emptyUsage();
async function judge(client: Anthropic, post: GoldPost, asks: { field: string; pred: string; gold: Scalar }[]): Promise<Map<string, { verdict: Outcome; why: string }>> {
  const out = new Map<string, { verdict: Outcome; why: string }>();
  if (!asks.length) return out;
  const res = await client.beta.messages.parse({
    model: BULK_MODEL,
    max_tokens: 2000,
    output_config: { effort: 'low', format: betaZodOutputFormat(Judged) },
    system: 'You grade metadata extracted about an Instagram video against a hand-checked reference. For each field, say whether the prediction names the same thing as the reference (correct), the same thing but incompletely or vaguely (partial), or something else (wrong). Accept translations, transliterations, other wording of the same title, and a name with or without its handle. A descriptive title is correct when it describes the same piece as the reference title.',
    messages: [{
      role: 'user',
      content: `Post ${post.code}${post.notes ? `\nReference notes: ${post.notes}` : ''}\n\n${asks.map((a) => `Field: ${a.field}\nReference: ${a.gold.value}${a.gold.aliases.length ? ` (also: ${a.gold.aliases.join('; ')})` : ''}\nPrediction: ${a.pred}`).join('\n\n')}`,
    }],
  });
  addUsage(judgeUsage, res.usage);
  for (const v of res.parsed_output?.verdicts ?? []) out.set(v.field, { verdict: v.verdict, why: v.why });
  return out;
}

interface Scored {
  outcome: Outcome;
  pred: unknown;
  gold: unknown;
  why?: string;
}

const yearOf = (s: string | null | undefined) => /\b(19|20)\d{2}\b/.exec(s ?? '')?.[0] ?? null;

async function score(client: Anthropic, post: GoldPost, r: PostRecord, ctx: PostContext): Promise<Record<string, Scored>> {
  const g = post.maker;
  const s: Record<string, Scored> = {};
  const goldNames = [...all(g.name), ...all(g.realName), ...(g.handle ? [g.handle] : [])];
  const predNames = [r.maker.name, r.maker.real_name, r.maker.handle].filter((x): x is string => !!x);
  // Who made it: any of the answer's names for the maker against any of gold's.
  s.maker = {
    outcome: !goldNames.length ? (predNames.length ? 'unsupported' : 'empty') : !predNames.length ? 'missing' : predNames.some((n) => sameName(n, goldNames)) ? (r.maker.attribution === 'unclear' ? 'partial' : 'correct') : predNames.some((n) => sameName(n, g.alternates)) ? 'partial' : 'wrong',
    pred: `${r.maker.name ?? '—'}${r.maker.handle ? ` @${r.maker.handle}` : ''} [${r.maker.attribution}, ${r.maker.confidence}]`,
    gold: `${g.name.value ?? '—'}${g.handle ? ` @${g.handle}` : ''}${g.isPoster === false ? ' [not the poster]' : ''}`,
  };
  // The Instagram profile the library links as the creator.
  const shown = creatorOf(ctx, r, ctx.page?.user?.username ?? ctx.info.channel ?? '').handle ?? null;
  s.profile = { outcome: byRule(shown, { value: g.handle, aliases: [] }, (p, gs) => gs.some((h) => h.toLowerCase() === p.toLowerCase())) ?? 'wrong', pred: shown && `@${shown}`, gold: g.handle && `@${g.handle}` };
  s.attribution = {
    outcome: g.isPoster === null ? 'empty' : r.maker.attribution === 'unclear' ? 'partial' : (r.maker.attribution === 'poster') === g.isPoster ? 'correct' : 'wrong',
    pred: r.maker.attribution,
    gold: g.isPoster === null ? 'unknown' : g.isPoster ? 'poster' : 'someone else',
  };
  // The person's other written forms ("Bruce Chen" for 陳柏尹) count; handles don't.
  const realName = g.realName.value ? { ...g.realName, aliases: [...g.realName.aliases, ...all(g.name).filter((n) => /\s|[^\x00-\x7f]/.test(n))] } : g.realName;
  s.realName = { outcome: byRule(r.maker.real_name, realName, sameName) ?? 'wrong', pred: r.maker.real_name, gold: g.realName.value };
  s.website = { outcome: byRule(r.maker.website, g.website, sameUrl) ?? 'wrong', pred: r.maker.website, gold: g.website.value };
  s.projectUrl = { outcome: byRule(r.project_url, post.projectUrl, sameUrl) ?? 'wrong', pred: r.project_url, gold: post.projectUrl.value };
  // The library's year: the stated one, else the post's.
  const posted = ctx.page?.takenAt ?? (ctx.info.timestamp ? new Date(ctx.info.timestamp * 1000).toISOString() : undefined);
  const year = yearOf(r.year) ?? yearOf(posted);
  s.year = { outcome: byRule(year, { value: yearOf(post.year.value), aliases: [] }, (p, gs) => gs.includes(p)) ?? 'wrong', pred: `${year}${r.year ? '' : ' (post date)'}`, gold: post.year.value };

  // Free-text fields: rule first, the judge when the rule can't tell.
  const asks: { field: string; pred: string; gold: Scalar }[] = [];
  for (const [field, pred, gold] of [['title', r.title, post.title], ['client', r.client, post.client], ['studio', r.studio, post.studio]] as const) {
    // A post without a title gets a descriptive one by design; the answer says which it gave.
    if (field === 'title' && !gold.value && !gold.low && !r.title_from_caption) {
      s.title = { outcome: 'empty', pred: `${pred} (descriptive)`, gold: null };
      continue;
    }
    const rule = byRule(pred, gold, sameName);
    if (rule) s[field] = { outcome: rule, pred, gold: gold.value };
    else asks.push({ field, pred: pred!, gold });
  }
  const judged = await judge(client, post, asks);
  for (const a of asks) {
    const j = judged.get(a.field);
    s[a.field] = { outcome: j?.verdict ?? 'wrong', pred: a.pred, gold: a.gold.value, ...(j ? { why: j.why } : {}) };
  }

  // Credits other than the maker: share of gold's found, share of the answer's that check out.
  // The post's attached library track is neutral: one gold set credits it,
  // the other doesn't, and the pipeline adds it from the page.
  const track = ctx.page?.music && !ctx.page.music.original ? ctx.page.music.artist : undefined;
  const isTrack = (names: string[]) => !!track && names.some((n) => sameName(n, [track]));
  const others = post.credits.filter((c) => !c.names.some((n) => sameName(n, goldNames)) && !isTrack(c.names));
  const predOthers = r.credits.filter((c) => ![c.name, c.handle ?? ''].some((n) => n && sameName(n, goldNames)) && !isTrack([c.name]));
  const found = others.filter((c) => predOthers.some((p) => sameName(p.name, c.names) || (p.handle && sameName(p.handle, c.names))));
  const backed = predOthers.filter((p) => others.some((c) => sameName(p.name, c.names) || (p.handle && sameName(p.handle, c.names))));
  s.credits = {
    outcome: !others.length ? (predOthers.length ? 'unsupported' : 'empty') : found.length === others.length && backed.length === predOthers.length ? 'correct' : found.length ? 'partial' : predOthers.length ? 'wrong' : 'missing',
    pred: predOthers.map((c) => `${c.role}: ${c.name}`),
    gold: others.map((c) => `${c.role}: ${c.names[0]}`),
  };
  // Low-confidence gold tools are neither required nor held against an answer.
  const tool = (t: string) => squash(t).replace(/3d$/, '');
  const same = (t: string, u: Scalar) => all(u).some((n) => tool(n).includes(tool(t)) || tool(t).includes(tool(n)));
  const need = post.tools.filter((u) => !u.low);
  const tp = r.tools.filter((t) => post.tools.some((u) => same(t, u)));
  const tr = need.filter((u) => r.tools.some((t) => same(t, u)));
  s.tools = {
    outcome: !need.length ? (r.tools.length > tp.length ? 'unsupported' : 'empty') : tr.length === need.length && tp.length === r.tools.length ? 'correct' : tr.length ? 'partial' : r.tools.length ? 'wrong' : 'missing',
    pred: r.tools,
    gold: post.tools.map((t) => `${t.value}${t.low ? ' (low)' : ''}`),
  };
  return s;
}

// ---- run ----------------------------------------------------------------------------

const gold = readGold(flags.gold);
const configs = flags.configs.split(',').map((c) => c.trim()) as Layer[];
const reps = Math.max(1, Number(flags.reps) || 1);
const client = new Anthropic({ maxRetries: 4 });
const contexts = new Map<string, PostContext>();
for (const p of gold) {
  // Cache only: no page views, no yt-dlp beyond what's cached.
  contexts.set(p.code, await gatherPost(p.code, { cacheDir: path.resolve(flags.cache), pages: null, related: 4, links: true, refresh: false, log: (s) => console.log(s) }));
}

interface Row {
  config: Layer;
  rep: number;
  code: string;
  cost: number | null;
  searches: number;
  dropped: string[];
  record?: PostRecord;
  error?: string;
  scores?: Record<string, Scored>;
}
const rows: Row[] = [];
const previous = flags.rescore ? (JSON.parse(fs.readFileSync(flags.rescore, 'utf8')) as { rows: Row[]; configs: Layer[]; reps: number }) : null;
if (previous) {
  configs.splice(0, configs.length, ...previous.configs);
  for (const r of previous.rows) {
    const post = gold.find((p) => p.code === r.code);
    rows.push(r.record && post ? { ...r, scores: await score(client, post, r.record, contexts.get(r.code)!) } : r);
  }
}
// A config is a layer and every cheaper one before it, whichever configs run.
const jobs = previous ? [] : configs.flatMap((config) => gold.flatMap((p) => Array.from({ length: reps }, (_, rep) => ({ config, layers: new Set(LAYERS.slice(0, LAYERS.indexOf(config) + 1)), post: p, rep }))));
let done = 0;
await pool(jobs, 6, async ({ config, layers, post, rep }) => {
  const ctx = contexts.get(post.code)!;
  try {
    const e = await enrichPost(client, ctx, layers, { model: flags.model, searchModel: flags['search-model'], maxSearches: 3 });
    rows.push({ config, rep, code: post.code, cost: e.cost, searches: e.search?.requests ?? 0, dropped: e.dropped, record: e.record, scores: await score(client, post, e.record, ctx) });
  } catch (err) {
    rows.push({ config, rep, code: post.code, cost: null, searches: 0, dropped: [], error: (err as Error).message });
  }
  if (process.stdout.isTTY) process.stdout.write(`\r  ${++done}/${jobs.length}`);
});
if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');

const evalDir = path.dirname(path.resolve(flags.gold));
const out = path.join(evalDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const judgeCost = cost(BULK_MODEL, judgeUsage) ?? 0;
fs.writeFileSync(out, JSON.stringify({ createdAt: new Date().toISOString(), model: flags.model, searchModel: flags['search-model'] ?? flags.model, reps: previous?.reps ?? reps, configs, judgeCost, ...(flags.rescore ? { rescoredFrom: path.basename(flags.rescore) } : {}), rows }, null, 2));

// ---- summary ------------------------------------------------------------------------

const FIELDS = ['maker', 'profile', 'attribution', 'realName', 'website', 'title', 'client', 'studio', 'year', 'credits', 'tools', 'projectUrl'];
const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));

console.log(`\nShare of answers that are right (correct, or rightly left empty); ${gold.length} posts × ${previous?.reps ?? reps} runs per config\n`);
console.log(pad('field', 12) + configs.map((c) => pad(c, 10)).join(''));
for (const f of FIELDS) {
  console.log(pad(f, 12) + configs.map((c) => {
    const rs = rows.filter((r) => r.config === c && r.scores && r.scores[f].outcome !== 'unscored');
    return pad(pct(rs.filter((r) => GOOD.includes(r.scores![f].outcome)).length, rs.length), 10);
  }).join(''));
}
console.log(pad('$/post', 12) + configs.map((c) => {
  const rs = rows.filter((r) => r.config === c);
  return pad(dollars(rs.reduce((s, r) => s + (r.cost ?? 0), 0) / Math.max(1, rs.length)), 10);
}).join(''));
console.log(pad('searches', 12) + configs.map((c) => {
  const rs = rows.filter((r) => r.config === c);
  return pad((rs.reduce((s, r) => s + r.searches, 0) / Math.max(1, rs.length)).toFixed(1), 10);
}).join(''));
const errors = rows.filter((r) => r.error);
if (errors.length) console.log(`\n${errors.length} runs failed: ${[...new Set(errors.map((e) => e.error))].join('; ')}`);

const last = configs[configs.length - 1];
console.log(`\nWhat goes wrong with every layer on (${last}), per run:`);
const SYMBOL: Record<Outcome, string> = { correct: '✓', empty: '·', partial: '~', missing: '∅', wrong: '✗', unsupported: '!', unscored: '-' };
console.log(pad('post', 13) + FIELDS.map((f) => pad(f.slice(0, 7), 8)).join(''));
for (const p of gold) {
  const rs = rows.filter((r) => r.config === last && r.code === p.code && r.scores);
  console.log(pad(p.code, 13) + FIELDS.map((f) => pad(rs.map((r) => SYMBOL[r.scores![f].outcome]).join(''), 8)).join(''));
}
console.log('  ✓ correct  · rightly empty  ~ partial/hedged  ∅ missed  ✗ wrong  ! unsupported (gold has none)  - unscored (gold unsure)');
console.log(`\njudge ${dollars(judgeCost)} · ${path.relative(process.cwd(), out)}`);
