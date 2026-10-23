// The search engine: text, facets and visual similarity over the Feed's
// pool of clips, all in memory. Runs in a worker (search.worker.ts) and in
// tests; it has no DOM or fetch.
//
// A query is free text plus facet filters, "similar to" seeds and a
// fuzziness from 0 (exact) to 1 (loose):
//
// - Facets are hard constraints: OR within a facet, AND across facets.
// - Text is BM25F over weighted fields (title, studio/client, tags, project
//   type and sector, caption, description). Each query word also matches its
//   prefixes and, as fuzziness rises, its typos. Exact mode needs every word;
//   looser modes need fewer.
// - Visual similarity scores each clip's SigLIP image vector against the
//   query's text vector (embedded elsewhere, same model), and against the
//   centroid of the best text matches ("more like these"). Scores are
//   standardised per query, because raw text-to-image cosines sit in a narrow
//   band; fuzziness lowers the z-score a clip needs to get in on looks alone.
//
// Text matches rank first by default; strong visual matches interleave.

import type { PackedVectors, SearchBundle } from './bundle.ts';
import { aspectOf, colorsOf, durationOf, FACETS, type FacetKey, facetByAlias, fixedOrder, valueLabel } from './taxonomy.ts';

const FACET_KEYS = FACETS.map((f) => f.key);
const NF = FACET_KEYS.length;

export type SortMode = 'relevance' | 'shuffle' | 'newest';

export interface SearchQuery {
  text: string;
  filters: Partial<Record<FacetKey, string[]>>;
  // Asset ids: rank by looking like these.
  similar: string[];
  fuzziness: number;
  sort: SortMode;
}

export const emptyQuery = (): SearchQuery => ({ text: '', filters: {}, similar: [], fuzziness: 0.5, sort: 'relevance' });

// A clip in the Feed, in its shuffled order. Clips missing from the bundle
// (new uploads, a stale index) are searchable by name and format.
export interface PoolItem {
  id: string;
  name: string;
  width: number;
  height: number;
  duration: number;
  added: number;
}

export interface Suggestion {
  facet: FacetKey;
  value: string;
  label: string;
  count: number;
  // What of the typed text the suggestion stands for.
  replace: 'all' | 'last';
}

export type SemanticState = 'off' | 'pending' | 'on';

export interface SearchResult {
  ids: string[];
  // Clips in the pool, after exclusions.
  total: number;
  // Of `ids`, how many matched the text itself (the rest came in on looks).
  textMatches: number;
  facets: Partial<Record<FacetKey, [string, number][]>>;
  suggestions: Suggestion[];
  semantic: SemanticState;
  // Facet values the text resolved to (`client:nike`).
  parsed: { facet: FacetKey; value: string }[];
  ms: number;
}

// ---- text ------------------------------------------------------------------------

const STOP = new Set(
  'a an the and or of to in on with for by at from as is are be its it into over then while that this these those his her their our your very'.split(' '),
);

export function normalize(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

export function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

export function words(s: string): string[] {
  return normalize(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));
}

export const tokens = (s: string) => words(s).map(stem);

// Fields and their weights; b is BM25's length normalisation.
const FIELDS = [
  { w: 3, b: 0.3 }, // title, page title
  { w: 3, b: 0.2 }, // client, studios
  { w: 2.5, b: 0.4 }, // vocabulary and visual tags
  { w: 2, b: 0.4 }, // project type, sector, site tags, site name
  { w: 1.5, b: 0.6 }, // caption
  { w: 0.6, b: 0.75 }, // page description
];
const K1 = 1.2;

// Levenshtein distance, giving up past `max`.
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

interface ParsedText {
  terms: string[];
  phrases: string[][];
  negs: string[];
  facets: { facet: FacetKey; raw: string }[];
  // The free text for embedding: no syntax, no negations.
  plain: string;
}

// "kinetic type" -studio:koto client:nike chrome
export function parseText(text: string): ParsedText {
  const out: ParsedText = { terms: [], phrases: [], negs: [], facets: [], plain: '' };
  const plain: string[] = [];
  const re = /(-?)(?:([a-z]+):)?(?:"([^"]*)"?|(\S+))/gi;
  for (const m of text.matchAll(re)) {
    const [, neg, field, quoted, bare] = m;
    const value = quoted ?? bare ?? '';
    const def = field ? facetByAlias(field) : undefined;
    if (def && value) {
      out.facets.push({ facet: def.key, raw: value });
      continue;
    }
    const raw = field && !def ? `${field} ${value}` : value;
    const ts = tokens(raw);
    if (!ts.length) continue;
    if (neg) out.negs.push(...ts);
    else if (quoted !== undefined && ts.length > 1) {
      out.phrases.push(ts);
      out.terms.push(...ts);
      plain.push(raw);
    } else {
      out.terms.push(...ts);
      plain.push(raw);
    }
  }
  out.plain = plain.join(' ').trim();
  return out;
}

// Free text as the embedder should see it: lowercased, syntax removed.
export const embeddingText = (text: string) => normalize(parseText(text).plain).replace(/\s+/g, ' ').trim();

// ---- index -------------------------------------------------------------------------

// "technique:3d-render" -> "3D render"; "visual:liquid-metal" -> "liquid metal".
const tagTextCache = new Map<string, string>();
function tagText(tag: string): string {
  let t = tagTextCache.get(tag);
  if (t === undefined) {
    const [group, value = ''] = tag.split(':', 2);
    t = group === 'visual' ? value.replace(/-/g, ' ') : valueLabel(group as FacetKey, value);
    tagTextCache.set(tag, t);
  }
  return t;
}

const colorCache = new Map<string, string[]>();
const colorsOfTag = (tag: string) => {
  let c = colorCache.get(tag);
  if (!c) colorCache.set(tag, (c = colorsOf([tag])));
  return c;
};

interface Doc {
  id: string;
  // Row in the packed vectors, or -1.
  vrow: number;
  added: number;
  year: number;
  // Normalised words of every field, for phrase checks.
  hay: string;
}

interface Posting {
  docs: Int32Array;
  // Saturated, field-weighted term frequency per doc.
  sat: Float32Array;
  idf: number;
}

// One facet's values, interned, and each doc's value ids (CSR).
interface FacetColumn {
  values: string[];
  ids: Map<string, number>;
  // Lowercased, for filters set from elsewhere ("studio dumbar").
  folded: Map<string, number>;
  start: Int32Array;
  vals: Int32Array;
  // Docs per value across the whole pool, for suggestions.
  pool: Int32Array;
}

export class SearchIndex {
  private readonly bundle: SearchBundle;
  private readonly vectors: PackedVectors | null;
  private readonly bundleRow = new Map<string, number>();
  private docs: Doc[] = [];
  private docIndex = new Map<string, number>();
  // Display (shuffle) position of each doc.
  private pos = new Int32Array(0);
  private postings = new Map<string, Posting>();
  // Sorted, for prefix lookups and typo scans.
  private terms: string[] = [];
  private columns: FacetColumn[] = [];
  private pageCache = new Map<number, { who: string[]; meta: string[]; description: string[] }>();
  private semCache: { key: string; z: Float32Array } | null = null;
  private prfCache: { key: string; z: Float32Array } | null = null;
  private simCache: { key: string; z: Float32Array } | null = null;
  private excludeCache: { ids: ReadonlySet<string> | undefined; mask: Uint8Array } | null = null;

  constructor(bundle: SearchBundle, vectors: PackedVectors | null) {
    this.bundle = bundle;
    this.vectors = vectors;
    bundle.docs.forEach((d, i) => this.bundleRow.set(d.id, i));
  }

  get size(): number {
    return this.docs.length;
  }

  get hasVectors(): boolean {
    return !!this.vectors;
  }

  private pageTokens(i: number) {
    let t = this.pageCache.get(i);
    if (!t) {
      const p = this.bundle.pages[i];
      t = {
        who: tokens([p.client ?? '', ...p.studios].join(' . ')),
        meta: tokens([...p.projectTypes, ...p.sectors, ...p.tags, this.bundle.sites[p.site] ?? '', p.site].join(' . ')),
        description: tokens(p.description ?? ''),
      };
      this.pageCache.set(i, t);
    }
    return t;
  }

  // The Feed's clips in display (shuffled) order. The same clips in a new
  // order (a reshuffle) only reorder; a changed set rebuilds the index.
  setPool(pool: PoolItem[]): void {
    const same = pool.length === this.docs.length && pool.every((p) => this.docIndex.has(p.id));
    if (!same) this.build(pool);
    this.pos = new Int32Array(this.docs.length);
    pool.forEach((p, i) => (this.pos[this.docIndex.get(p.id)!] = i));
  }

  private build(pool: PoolItem[]): void {
    const fieldTokens: string[][][] = [];
    const facetValues: string[][][] = FACET_KEYS.map(() => []);
    this.docs = pool.map((item) => {
      const row = this.bundleRow.get(item.id);
      const d = row === undefined ? null : this.bundle.docs[row];
      const page = d && d.page >= 0 ? this.bundle.pages[d.page] : null;
      const tags = d?.tags ?? [];
      const f: Partial<Record<FacetKey, string[]>> = {
        aspect: [aspectOf(d?.width ?? item.width, d?.height ?? item.height)],
        duration: [durationOf(d?.duration ?? item.duration)],
      };
      if (page) {
        f.studio = page.studios;
        if (page.client) f.client = [page.client];
        f.site = [this.bundle.sites[page.site] ?? page.site];
        f.projectType = page.projectTypes;
        f.sector = page.sectors;
        if (page.year) f.year = [String(page.year)];
      }
      const colors = new Set<string>();
      for (const t of tags) {
        const c = t.indexOf(':');
        const group = t.slice(0, c);
        if (group === 'visual') for (const x of colorsOfTag(t)) colors.add(x);
        else (f[group as FacetKey] ??= []).push(t.slice(c + 1));
      }
      if (colors.size) f.color = [...colors];
      FACET_KEYS.forEach((k, fi) => facetValues[fi].push(f[k] ?? []));

      // Page fields repeat for every clip on the page: tokenise them once.
      const pageToks = page ? this.pageTokens(d!.page) : null;
      const toks = [
        tokens(`${d?.title ?? item.name} . ${page?.title ?? ''}`),
        pageToks?.who ?? [],
        tokens(tags.map(tagText).join(' . ')),
        pageToks?.meta ?? [],
        tokens(d?.caption ?? ''),
        pageToks?.description ?? [],
      ];
      fieldTokens.push(toks);
      return {
        id: item.id,
        vrow: row ?? -1,
        added: d?.added || item.added,
        year: page?.year ?? 0,
        hay: ` ${toks.map((t) => t.join(' ')).join(' | ')} `,
      };
    });
    const n = this.docs.length;
    this.docIndex = new Map(this.docs.map((d, i) => [d.id, i]));

    // BM25F: per doc and term, sum each field's length-normalised count.
    const avg = FIELDS.map((_, f) => fieldTokens.reduce((s, ft) => s + ft[f].length, 0) / Math.max(1, n) || 1);
    const lists = new Map<string, { docs: number[]; sat: number[] }>();
    const tf = new Map<string, number>();
    fieldTokens.forEach((ft, doc) => {
      tf.clear();
      ft.forEach((toks, f) => {
        const { w, b } = FIELDS[f];
        const norm = 1 - b + (b * toks.length) / avg[f];
        for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + w / norm);
      });
      for (const [t, x] of tf) {
        let p = lists.get(t);
        if (!p) lists.set(t, (p = { docs: [], sat: [] }));
        p.docs.push(doc);
        p.sat.push((x * (K1 + 1)) / (x + K1));
      }
    });
    this.postings = new Map();
    for (const [t, p] of lists)
      this.postings.set(t, { docs: Int32Array.from(p.docs), sat: Float32Array.from(p.sat), idf: Math.log(1 + (n - p.docs.length + 0.5) / (p.docs.length + 0.5)) });
    this.terms = [...this.postings.keys()].sort();

    this.columns = facetValues.map((perDoc) => {
      const ids = new Map<string, number>();
      const values: string[] = [];
      const start = new Int32Array(n + 1);
      const vals: number[] = [];
      perDoc.forEach((vs, i) => {
        start[i] = vals.length;
        for (const v of vs) {
          let id = ids.get(v);
          if (id === undefined) {
            ids.set(v, (id = values.length));
            values.push(v);
          }
          vals.push(id);
        }
      });
      start[n] = vals.length;
      const pool = new Int32Array(values.length);
      for (const v of vals) pool[v]++;
      const folded = new Map<string, number>();
      values.forEach((v, id) => {
        const k = v.toLowerCase();
        if (!folded.has(k) || pool[id] > pool[folded.get(k)!]) folded.set(k, id);
      });
      return { values, ids, folded, start, vals: Int32Array.from(vals), pool };
    });
    this.semCache = this.prfCache = this.simCache = this.excludeCache = null;
  }

  // ---- query terms ------------------------------------------------------------------

  private prefixed(prefix: string, limit: number): string[] {
    let lo = 0;
    let hi = this.terms.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.terms[mid] < prefix) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = lo; i < this.terms.length && this.terms[i].startsWith(prefix); i++) if (this.terms[i] !== prefix) out.push(this.terms[i]);
    // The most common completions: "an" -> animation before anaglyph.
    return out.sort((a, b) => this.postings.get(b)!.docs.length - this.postings.get(a)!.docs.length).slice(0, limit);
  }

  // The index terms a query word matches, each with a weight.
  private expand(term: string, fuzz: number, isLast: boolean): Map<string, number> {
    const out = new Map<string, number>();
    if (this.postings.has(term)) out.set(term, 1);
    if (isLast || (fuzz >= 0.25 && term.length >= 3)) for (const t of this.prefixed(term, isLast && term.length < 3 ? 12 : 40)) out.set(t, isLast ? 0.85 : 0.7);
    // Typos only for words the library doesn't know: "nike" is not a typo of "bike".
    if (fuzz >= 0.25 && term.length >= 4 && !this.postings.has(term)) {
      const max = fuzz >= 0.6 && term.length >= 7 ? 2 : 1;
      for (const t of this.terms) {
        if (out.has(t) || t.length < 3 || Math.abs(t.length - term.length) > max) continue;
        const d = editDistance(term, t, max);
        if (d <= max) out.set(t, d === 1 ? 0.55 : 0.4);
      }
    }
    return out;
  }

  private resolveFacet(fi: number, raw: string): number | null {
    const col = this.columns[fi];
    if (!col) return null;
    const key = FACET_KEYS[fi];
    const q = normalize(raw).replace(/[-_]+/g, ' ');
    let best: [number, number] | null = null;
    col.values.forEach((v, id) => {
      const l = normalize(valueLabel(key, v));
      const s = l === q || normalize(v) === q ? 3 : l.startsWith(q) ? 2 : l.includes(q) ? 1 : 0;
      if (s && (!best || s > best[1] || (s === best[1] && col.pool[id] > col.pool[best[0]]))) best = [id, s];
    });
    return best ? best[0] : null;
  }

  // ---- search -------------------------------------------------------------------------

  // queryVector: the embedded text; undefined while it's on its way, null
  // when there is none to be had.
  search(q: SearchQuery, opts: { queryVector?: Float32Array | null; exclude?: ReadonlySet<string> } = {}): SearchResult {
    const t0 = performance.now();
    const docs = this.docs;
    const n = docs.length;
    const fuzz = Math.min(1, Math.max(0, q.fuzziness));
    const parsed = parseText(q.text);

    // Facets from the chips and from `field:value` text, as value-id masks.
    const want: (Uint8Array | null)[] = this.columns.map(() => null);
    const select = (fi: number, id: number) => ((want[fi] ??= new Uint8Array(this.columns[fi].values.length))[id] = 1);
    const lookup = (fi: number, v: string) => this.columns[fi]?.ids.get(v) ?? this.columns[fi]?.folded.get(v.toLowerCase());
    FACET_KEYS.forEach((k, fi) => {
      for (const v of q.filters[k] ?? []) {
        const id = lookup(fi, v);
        if (id !== undefined) select(fi, id);
      }
    });
    const resolved: SearchResult['parsed'] = [];
    for (const { facet, raw } of parsed.facets) {
      const fi = FACET_KEYS.indexOf(facet);
      const id = this.resolveFacet(fi, raw);
      if (id === null) continue;
      select(fi, id);
      resolved.push({ facet, value: this.columns[fi].values[id] });
    }
    const active: number[] = [];
    want.forEach((w, fi) => w && active.push(fi));
    // Selected values that no doc carries (a stale filter) match nothing.
    const missing = FACET_KEYS.some((k, fi) => (q.filters[k] ?? []).some((v) => lookup(fi, v) === undefined));

    // Per doc: how many facets it fails, and which (when one), so each
    // facet's counts can ignore its own selection.
    const live = this.liveMask(opts.exclude);
    const fails = new Uint8Array(n);
    const failed = new Int8Array(n).fill(-1);
    for (const fi of active) {
      const { start, vals } = this.columns[fi];
      const w = want[fi]!;
      for (let i = 0; i < n; i++) {
        let hit = false;
        for (let j = start[i]; j < start[i + 1]; j++)
          if (w[vals[j]]) {
            hit = true;
            break;
          }
        if (!hit) {
          fails[i]++;
          failed[i] = fi;
        }
      }
    }
    if (missing) fails.fill(NF);

    // ---- text
    const textOn = parsed.terms.length > 0;
    const lex = new Float32Array(n);
    const cover = new Float32Array(n);
    const ok = new Uint8Array(n);
    if (textOn) {
      const last = parsed.terms.length - 1;
      // Is the last word still being typed (no space after it)?
      const typing = !/\s$/.test(q.text);
      let idfTotal = 0;
      const best = new Float32Array(n);
      parsed.terms.forEach((term, ti) => {
        const exp = this.expand(term, fuzz, typing && ti === last);
        // The word's weight: its own idf, else that of its likeliest reading.
        let idf = this.postings.get(term)?.idf ?? 0;
        if (!idf) {
          let df = 0;
          for (const [t, w] of exp) {
            const p = this.postings.get(t)!;
            if (p.docs.length * w > df) [df, idf] = [p.docs.length * w, p.idf];
          }
        }
        idf = Math.max(0.5, idf || 3);
        idfTotal += idf;
        best.fill(0);
        for (const [t, weight] of exp) {
          const p = this.postings.get(t)!;
          const k = weight * p.idf;
          for (let j = 0; j < p.docs.length; j++) {
            const s = k * p.sat[j];
            if (s > best[p.docs[j]]) best[p.docs[j]] = s;
          }
        }
        for (let i = 0; i < n; i++)
          if (best[i] > 0) {
            lex[i] += best[i];
            cover[i] += idf;
          }
      });
      const needCover = fuzz <= 0.15 ? 0.999 : 1 - ((fuzz - 0.15) / 0.85) * 0.66;
      const banned = new Uint8Array(n);
      for (const neg of parsed.negs) for (const d of this.postings.get(neg)?.docs ?? []) banned[d] = 1;
      // Phrases must appear in order; the whole query in order earns a bonus.
      const whole = parsed.terms.length > 1 ? ` ${parsed.terms.join(' ')} ` : null;
      for (let i = 0; i < n; i++) {
        if (banned[i]) live[i] = 0;
        if (!lex[i]) continue;
        cover[i] /= idfTotal;
        for (const ph of parsed.phrases) if (!docs[i].hay.includes(` ${ph.join(' ')} `)) cover[i] = 0;
        if (whole && docs[i].hay.includes(whole)) lex[i] *= 1.5;
        ok[i] = cover[i] >= needCover ? 1 : 0;
      }
    }
    let lexMax = 0;
    for (let i = 0; i < n; i++) if (ok[i] && live[i] && lex[i] > lexMax) lexMax = lex[i];

    // ---- looks
    let semantic: SemanticState = 'off';
    let sem: Float32Array | null = null;
    let prf: Float32Array | null = null;
    let sim: Float32Array | null = null;
    if (this.vectors && textOn && parsed.plain) {
      if (opts.queryVector) {
        semantic = 'on';
        const key = parsed.plain;
        // A text always embeds to the same vector, so the text is the key.
        if (this.semCache?.key === key) sem = this.semCache.z;
        else {
          sem = this.zScores(opts.queryVector);
          this.semCache = { key, z: sem };
        }
      } else if (opts.queryVector === undefined) semantic = 'pending';
    }
    if (this.vectors && textOn && fuzz >= 0.4) {
      // The best text matches, as one "more like these" vector.
      const top: number[] = [];
      for (let i = 0; i < n; i++) if (ok[i] && live[i] && docs[i].vrow >= 0) top.push(i);
      top.sort((a, b) => lex[b] - lex[a] || a - b);
      const seeds = top.slice(0, 12);
      if (seeds.length >= 3) {
        const key = seeds.join(',');
        if (this.prfCache?.key !== key) this.prfCache = { key, z: this.zScores(this.centroid(seeds.map((i) => docs[i].vrow), seeds.map((i) => lex[i]))) };
        prf = this.prfCache.z;
      }
    }
    const similarRows = q.similar.map((id) => this.bundleRow.get(id)).filter((r): r is number => r !== undefined);
    const similarSet = new Set(q.similar);
    if (this.vectors && similarRows.length) {
      const key = similarRows.join(',');
      if (this.simCache?.key !== key) this.simCache = { key, z: this.zScores(this.centroid(similarRows)) };
      sim = this.simCache.z;
    }

    // Fuzziness sets how far above the crowd a clip must look to get in on
    // looks alone: nothing at Exact, the top ~0.1% at 0.35, ~10% at 1.
    const tau = fuzz < 0.35 ? Infinity : 3.2 - ((fuzz - 0.35) / 0.65) * 1.95;
    const tauSim = 3.5 - fuzz * 2.5;

    const score = new Float32Array(n);
    const match = new Uint8Array(n); // 1 text, 2 looks
    for (let i = 0; i < n; i++) {
      if (!live[i]) continue;
      const v = docs[i].vrow >= 0;
      let s = 0;
      if (textOn) {
        const looks = v ? Math.max(sem ? sem[i] : -9, prf ? prf[i] : -9) : -9;
        if (ok[i]) match[i] = 1;
        else if (looks >= tau) match[i] = 2;
        else continue;
        if (ok[i]) s += 3 * (lex[i] / lexMax) * cover[i] + 1;
        if (sem && v) s += 0.6 * Math.max(-2, Math.min(6, sem[i]));
        if (prf && v) s += 0.35 * Math.max(-2, Math.min(6, prf[i]));
      } else match[i] = 1;
      if (similarRows.length) {
        if (similarSet.has(docs[i].id)) s += 100;
        else if (!sim || !v || sim[i] < tauSim) {
          match[i] = 0;
          continue;
        } else s += 0.8 * sim[i];
        if (!textOn) match[i] = 2;
      }
      score[i] = s;
    }

    // ---- facet counts, over what the text lets through
    const facets: SearchResult['facets'] = {};
    this.columns.forEach((col, fi) => {
      const counts = new Int32Array(col.values.length);
      const { start, vals } = col;
      for (let i = 0; i < n; i++) {
        if (!match[i] || fails[i] > 1 || (fails[i] === 1 && failed[i] !== fi)) continue;
        for (let j = start[i]; j < start[i + 1]; j++) counts[vals[j]]++;
      }
      const out: [string, number][] = [];
      counts.forEach((c, id) => (c || want[fi]?.[id]) && out.push([col.values[id], c]));
      for (const v of q.filters[FACET_KEYS[fi]] ?? []) if (lookup(fi, v) === undefined) out.push([v, 0]);
      facets[FACET_KEYS[fi]] = sortValues(FACET_KEYS[fi], out);
    });

    // ---- order
    const hits: number[] = [];
    let textMatches = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      total += live[i];
      if (match[i] && !fails[i]) {
        hits.push(i);
        if (match[i] === 1 && textOn) textMatches++;
      }
    }
    const pos = this.pos;
    if (q.sort === 'newest') hits.sort((a, b) => docs[b].year - docs[a].year || docs[b].added - docs[a].added || pos[a] - pos[b]);
    else if (q.sort === 'relevance' && (textOn || similarRows.length)) hits.sort((a, b) => score[b] - score[a] || pos[a] - pos[b]);
    else hits.sort((a, b) => pos[a] - pos[b]);

    return {
      ids: hits.map((i) => docs[i].id),
      total,
      textMatches,
      facets,
      suggestions: q.text.trim() ? this.suggest(q.text, want, this.filteredCounts(live, fails)) : [],
      semantic,
      parsed: resolved,
      ms: performance.now() - t0,
    };
  }

  // Per facet value, the docs that pass every filter: what picking that
  // value as well would leave (before text).
  private filteredCounts(live: Uint8Array, fails: Uint8Array): Int32Array[] {
    return this.columns.map(({ values, start, vals }) => {
      const counts = new Int32Array(values.length);
      for (let i = 0; i < live.length; i++) if (live[i] && !fails[i]) for (let j = start[i]; j < start[i + 1]; j++) counts[vals[j]]++;
      return counts;
    });
  }

  // 1 for docs in the pool and not excluded. Cached per exclude set.
  private liveMask(exclude: ReadonlySet<string> | undefined): Uint8Array {
    if (!this.excludeCache || this.excludeCache.ids !== exclude || this.excludeCache.mask.length !== this.docs.length) {
      const mask = new Uint8Array(this.docs.length).fill(1);
      if (exclude) for (const id of exclude) {
        const i = this.docIndex.get(id);
        if (i !== undefined) mask[i] = 0;
      }
      this.excludeCache = { ids: exclude, mask };
    }
    return this.excludeCache.mask.slice();
  }

  // Cosine of every doc's vector with `v`, as z-scores over the pool.
  private zScores(v: Float32Array): Float32Array {
    const { dims, scales, data } = this.vectors!;
    const docs = this.docs;
    const out = new Float32Array(docs.length);
    let sum = 0;
    let sq = 0;
    let m = 0;
    for (let i = 0; i < docs.length; i++) {
      const r = docs[i].vrow;
      if (r < 0 || !scales[r]) continue;
      let s = 0;
      const o = r * dims;
      for (let k = 0; k < dims; k++) s += v[k] * data[o + k];
      s *= scales[r];
      out[i] = s;
      sum += s;
      sq += s * s;
      m++;
    }
    const mean = sum / Math.max(1, m);
    const sd = Math.sqrt(Math.max(1e-12, sq / Math.max(1, m) - mean * mean));
    for (let i = 0; i < docs.length; i++) out[i] = docs[i].vrow >= 0 ? (out[i] - mean) / sd : -9;
    return out;
  }

  // Weighted mean of bundle rows' vectors, normalised.
  private centroid(rows: number[], weights?: number[]): Float32Array {
    const { dims, scales, data } = this.vectors!;
    const c = new Float32Array(dims);
    rows.forEach((r, j) => {
      const w = (weights?.[j] ?? 1) * scales[r];
      for (let k = 0; k < dims; k++) c[k] += w * data[r * dims + k];
    });
    let norm = 0;
    for (const x of c) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < dims; k++) c[k] /= norm;
    return c;
  }

  // ---- suggestions -----------------------------------------------------------------------

  // Facet values for what's being typed: the whole text, else its last word.
  // `counts` (per facet value) defaults to the whole pool; values with none
  // aren't offered.
  suggest(text: string, selected: (Uint8Array | null)[] = [], counts: Int32Array[] = this.columns.map((c) => c.pool), limit = 8): Suggestion[] {
    const raw = normalize(text).trim();
    if (!raw || /^-|:/.test(raw.split(/\s+/).pop() ?? '')) return [];
    const parts = raw.split(/\s+/);
    const tries: [string, Suggestion['replace']][] = [[raw, 'all']];
    if (parts.length > 1) tries.push([parts[parts.length - 1], 'last']);
    const out: (Suggestion & { rank: number })[] = [];
    const seen = new Set<string>();
    for (const [q, replace] of tries) {
      if (q.length < 2 && replace === 'last') continue;
      this.columns.forEach((col, fi) => {
        const facet = FACET_KEYS[fi];
        col.values.forEach((value, id) => {
          const count = counts[fi][id];
          if (!count || selected[fi]?.[id] || seen.has(`${fi}:${id}`)) return;
          const label = valueLabel(facet, value);
          const l = normalize(label);
          const quality = l === q ? 4 : l.startsWith(q) ? 3 : l.split(/[^a-z0-9]+/).some((w) => w.startsWith(q)) ? 2 : q.length >= 3 && l.includes(q) ? 1 : 0;
          if (!quality) return;
          seen.add(`${fi}:${id}`);
          out.push({ facet, value, label, count, replace, rank: quality * 10 + Math.log2(1 + count) + (replace === 'all' ? 5 : 0) });
        });
      });
    }
    return out
      .sort((a, b) => b.rank - a.rank)
      .slice(0, limit)
      .map(({ rank: _rank, ...s }) => s);
  }
}

function sortValues(key: FacetKey, entries: [string, number][]): [string, number][] {
  const fixed = fixedOrder(key);
  if (fixed) return entries.sort((a, b) => fixed.indexOf(a[0]) - fixed.indexOf(b[0]));
  if (key === 'year') return entries.sort((a, b) => Number(b[0]) - Number(a[0]));
  return entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
