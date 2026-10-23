// Checks for the search engine and taxonomy: run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packVectors, type SearchBundle, type SearchDoc, unpackVectors } from '../../src/search/bundle.ts';
import { emptyQuery, parseText, type PoolItem, type SearchQuery, SearchIndex } from '../../src/search/engine.ts';
import { classify, colorsOf, PROJECT_TYPES, SECTORS, splitStudios, yearOf } from '../../src/search/taxonomy.ts';

const DIMS = 8;
// A unit vector along `axis`, nudged toward `toward`.
const vec = (axis: number, toward = axis, mix = 0) => {
  const v = new Float32Array(DIMS);
  v[axis] = 1 - mix;
  v[toward] += mix;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

const doc = (id: string, title: string, page: number, caption: string, tags: string[]): SearchDoc => ({ id, title, page, caption, tags, duration: 8, width: 1920, height: 1080, added: 0 });

function library() {
  const bundle: SearchBundle = {
    version: 1,
    built: '',
    sites: { 'koto.com': 'Koto', 'pentagram.com': 'Pentagram' },
    pages: [
      { url: 'a', title: 'Nike Air', client: 'Nike', studios: ['Koto'], year: 2024, tags: ['Brand identity', 'Sport'], projectTypes: ['Brand identity'], sectors: ['Sport'], site: 'koto.com' },
      { url: 'b', title: 'Bike Share', client: 'Citi', studios: ['Pentagram'], year: 2021, tags: ['Signage & Environmental Graphics'], projectTypes: ['Environmental & signage'], sectors: [], site: 'pentagram.com' },
    ],
    docs: [
      doc('a1', 'Swoosh reveal', 0, 'A chrome swoosh logo spins over black', ['technique:3d-render', 'use:logo-reveal', 'visual:chrome', 'visual:black']),
      doc('a2', 'Kinetic type', 0, 'Bold kinetic type slams in with hard cuts', ['technique:kinetic-type', 'pacing:hard-cuts', 'visual:red']),
      doc('b1', 'Wayfinding', 1, 'Bike lane signs and pictograms animate on a blue field', ['technique:shape-layer', 'visual:blue']),
      doc('b2', 'Map loop', 1, 'A city map loops with moving dots', ['technique:shape-layer', 'use:loop', 'visual:blue-to-pink-gradient']),
      doc('c1', 'Liquid metal', -1, 'Liquid metal blobs merge and split', ['technique:fluid-sim', 'visual:silver']),
    ],
  };
  // a1 and c1 look alike (axis 0); a2 on its own; b1 and b2 alike (axis 2).
  const vectors = [vec(0), vec(1), vec(2), vec(2, 3, 0.2), vec(0, 4, 0.15)];
  // Filler, so visual scores have a crowd to stand out from.
  for (let i = 0; i < 40; i++) {
    bundle.docs.push(doc(`f${i}`, `Filler ${i}`, -1, 'Grey noise', []));
    vectors.push(vec(5 + (i % 3), 5 + ((i + 1) % 3), 0.3));
  }
  const packed = packVectors(vectors, DIMS);
  const index = new SearchIndex(bundle, unpackVectors(packed.buffer, bundle.docs.length, DIMS));
  const pool: PoolItem[] = bundle.docs.map((d) => ({ id: d.id, name: d.title, width: d.width, height: d.height, duration: d.duration, added: 0 }));
  index.setPool(pool);
  return { bundle, index, pool, vectors };
}

const q = (patch: Partial<SearchQuery>): SearchQuery => ({ ...emptyQuery(), ...patch });

test('parses facets, phrases and negations out of the text', () => {
  const p = parseText('client:nike "kinetic type" -loop studio:"Studio Dumbar" chrome');
  assert.deepEqual(p.facets, [
    { facet: 'client', raw: 'nike' },
    { facet: 'studio', raw: 'Studio Dumbar' },
  ]);
  assert.deepEqual(p.phrases, [['kinetic', 'type']]);
  assert.deepEqual(p.negs, ['loop']);
  assert.equal(p.plain, 'kinetic type chrome');
});

test('an empty query returns the pool in shuffle order, and a reshuffle reorders', () => {
  const { index, pool } = library();
  assert.deepEqual(index.search(q({ sort: 'shuffle' })).ids, pool.map((p) => p.id));
  index.setPool([...pool].reverse());
  assert.deepEqual(index.search(q({ sort: 'shuffle' })).ids, pool.map((p) => p.id).reverse());
});

test('exact needs every word; looser modes need fewer', () => {
  const { index } = library();
  const exact = index.search(q({ text: 'chrome blobs ', fuzziness: 0 }), { queryVector: null });
  assert.deepEqual(exact.ids, []);
  const loose = index.search(q({ text: 'chrome blobs ', fuzziness: 0.8 }), { queryVector: null });
  assert.deepEqual(new Set(loose.ids), new Set(['a1', 'c1']));
});

test('typos match only words the library does not know', () => {
  const { index } = library();
  // "nike" is a real word here: it must not pull in "bike".
  assert.deepEqual(index.search(q({ text: 'nike ', fuzziness: 0.5 }), { queryVector: null }).ids.sort(), ['a1', 'a2']);
  assert.deepEqual(index.search(q({ text: 'chrme ', fuzziness: 0 }), { queryVector: null }).ids, []);
  assert.deepEqual(index.search(q({ text: 'chrme ', fuzziness: 0.5 }), { queryVector: null }).ids, ['a1']);
});

test('the word being typed matches as a prefix', () => {
  const { index } = library();
  assert.deepEqual(index.search(q({ text: 'pictog', fuzziness: 0 }), { queryVector: null }).ids, ['b1']);
});

test('facets are OR within, AND across, and counts ignore their own selection', () => {
  const { index } = library();
  const r = index.search(q({ filters: { technique: ['shape-layer', 'fluid-sim'], studio: ['Pentagram'] } }));
  assert.deepEqual(r.ids.sort(), ['b1', 'b2']);
  const technique = Object.fromEntries(r.facets.technique ?? []);
  // Within Pentagram: two shape-layer clips; fluid-sim is selected but has none there.
  assert.equal(technique['shape-layer'], 2);
  assert.equal(technique['fluid-sim'], 0);
  const studio = Object.fromEntries(r.facets.studio ?? []);
  // Studio counts follow the technique filter, not the studio one.
  assert.equal(studio.Pentagram, 2);
  assert.equal(studio.Koto, undefined);
});

test('filter values match regardless of case', () => {
  const { index } = library();
  assert.deepEqual(index.search(q({ filters: { studio: ['pentagram'] } })).ids.sort(), ['b1', 'b2']);
});

test('field syntax in the text filters', () => {
  const { index } = library();
  const r = index.search(q({ text: 'client:nike' }));
  assert.deepEqual(r.ids.sort(), ['a1', 'a2']);
  assert.deepEqual(r.parsed, [{ facet: 'client', value: 'Nike' }]);
});

test('colour and format facets come from tags and size', () => {
  const { index } = library();
  assert.deepEqual(index.search(q({ filters: { color: ['pink'] } })).ids, ['b2']);
  assert.equal(index.search(q({ filters: { aspect: ['landscape'] } })).ids.length, 45);
});

test('looks bring in clips with no matching words only when fuzzy enough', () => {
  const { index, vectors } = library();
  // A text vector that sits right on c1 (liquid metal), which shares no words with "swoosh".
  const qv = vectors[4];
  const strict = index.search(q({ text: 'swoosh ', fuzziness: 0.2 }), { queryVector: qv });
  assert.deepEqual(strict.ids, ['a1']);
  const fuzzy = index.search(q({ text: 'swoosh ', fuzziness: 1 }), { queryVector: qv });
  assert.ok(fuzzy.ids.includes('c1'), `got ${fuzzy.ids}`);
  assert.equal(fuzzy.ids[0], 'a1', 'the text match still ranks first');
  assert.equal(fuzzy.textMatches, 1);
  assert.equal(fuzzy.semantic, 'on');
  assert.equal(index.search(q({ text: 'swoosh ' }), { queryVector: undefined }).semantic, 'pending');
});

test('similar ranks by look and keeps the seed first', () => {
  const { index } = library();
  const r = index.search(q({ similar: ['b1'], fuzziness: 1 }));
  assert.equal(r.ids[0], 'b1');
  assert.equal(r.ids[1], 'b2');
  assert.ok(!r.ids.includes('a2'));
});

test('exclusions and negations drop clips', () => {
  const { index } = library();
  assert.ok(!index.search(q({}), { exclude: new Set(['a1']) }).ids.includes('a1'));
  assert.deepEqual(index.search(q({ text: 'shape -loop ', fuzziness: 0 }), { queryVector: null }).ids, ['b1']);
});

test('suggestions offer facet values for what is typed, counted within the filters', () => {
  const { index } = library();
  const s = index.search(q({ text: 'pent' })).suggestions;
  assert.equal(s[0]?.facet, 'studio');
  assert.equal(s[0]?.value, 'Pentagram');
  assert.equal(s[0]?.count, 2);
  // Within Koto's work there is no Pentagram to offer.
  assert.equal(index.search(q({ text: 'pent', filters: { studio: ['Koto'] } })).suggestions.length, 0);
});

test('taxonomy maps scraped tags and fields onto fixed lists', () => {
  assert.deepEqual(classify(['Brand Identity', 'Motion Graphics & Film', 'New York', 'Challenge'], PROJECT_TYPES), ['Brand identity', 'Motion & film']);
  assert.deepEqual(classify(['Fintech', 'NBA'], SECTORS), ['Finance', 'Sport']);
  assert.deepEqual(colorsOf(['visual:neon-green', 'visual:blue-to-pink-gradient', 'visual:typography']).sort(), ['blue', 'gradient', 'green', 'neon', 'pink']);
  assert.equal(yearOf('2023–Present'), 2023);
  assert.equal(yearOf('25-26'), 2025);
  assert.equal(yearOf('soon'), null);
  assert.deepEqual(splitStudios('Studio Dumbar/DEPT®'), ['Studio Dumbar', 'DEPT®']);
  assert.deepEqual(splitStudios('FutureDeluxe, Patswerk'), ['FutureDeluxe', 'Patswerk']);
});

test('int8 vectors keep their ranking', () => {
  const vs = Array.from({ length: 50 }, (_, i) => Float32Array.from({ length: 32 }, (_, k) => Math.sin(i * 7 + k * 3)).map((x, _k, a) => x / Math.hypot(...a)));
  const packed = unpackVectors(packVectors(vs, 32).buffer, 50, 32);
  const target = vs[3];
  const exact = vs.map((v, i) => [i, v.reduce((s, x, k) => s + x * target[k], 0)]).sort((a, b) => b[1] - a[1]);
  const approx = vs.map((_, i) => [i, packed.scales[i] * Array.from(packed.data.subarray(i * 32, i * 32 + 32)).reduce((s, x, k) => s + x * target[k], 0)]).sort((a, b) => b[1] - a[1]);
  assert.deepEqual(approx.slice(0, 10).map((x) => x[0]), exact.slice(0, 10).map((x) => x[0]));
});
