// Checks for upload enrichment: the endpoint's link guard and page mapping,
// and searching uploads shared to the Feed. Run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicUrl, toSource } from '../../api/enrich.ts';
import type { PageMeta } from '../scrape/types.ts';
import type { Asset } from '../../src/media/library.ts';
import type { SearchBundle } from '../../src/search/bundle.ts';
import { hostLabel, isPlatform, searchPage, siteNameOf, uploadDoc } from '../../src/search/docs.ts';
import { emptyQuery, type PoolItem, SearchIndex } from '../../src/search/engine.ts';

test('only public web links get through', () => {
  for (const ok of ['https://koto.com/projects/x', 'http://vimeo.com/123', 'https://www.studiodumbar.com/work/a?b=1']) assert.ok(publicUrl(ok), ok);
  for (const bad of ['ftp://koto.com/x', 'http://localhost:5180/', 'http://127.0.0.1/', 'http://10.0.0.2/x', 'http://[::1]/', 'http://printer.local/', 'http://intranet/', 'https://koto.com:8443/', 'https://user:pw@koto.com/', 'not a url']) {
    assert.equal(publicUrl(bad), null, bad);
  }
});

const meta = (patch: Partial<PageMeta>): PageMeta => ({ url: '', status: 200, og: {}, twitter: {}, meta: {}, jsonLd: [], text: '', ...patch });
const answer = (patch: Partial<{ is_project_page: boolean; title: string | null; client: string | null; agency: string | null }> = {}) => ({
  is_project_page: patch.is_project_page ?? true,
  project: { title: patch.title ?? null, client: patch.client ?? null, agency: patch.agency ?? null, year: '2024', description: null, disciplines: ['3D'], credits: [{ role: 'Director', name: 'A. Person' }], tags: ['Brand', '3D'] },
  videos: [],
});

test('maps a studio page onto the library source shape', () => {
  const s = toSource('https://www.koto.com/projects/nike', meta({ title: 'Nike — Koto', description: 'A brand for Nike.', og: { site_name: 'Koto' } }), answer({ title: 'Nike Air', client: 'Nike' }), 'final_v3');
  assert.equal(s.site, 'koto.com');
  assert.equal(s.siteName, 'Koto');
  assert.equal(s.pageTitle, 'Nike — Koto');
  assert.equal(s.title, 'Nike Air');
  assert.equal(s.client, 'Nike');
  assert.equal(s.description, 'A brand for Nike.');
  assert.deepEqual(s.tags, ['3D', 'Brand']);
  assert.equal(s.mediaUrl, undefined);
});

test('a platform page credits the maker, not the platform, and links the player', () => {
  const s = toSource('https://vimeo.com/123456', meta({ title: 'Reel on Vimeo', og: { site_name: 'Vimeo', title: 'Buck — Reel 2024' } }), answer({ is_project_page: false, agency: 'Buck' }), 'reel');
  assert.equal(s.siteName, undefined);
  assert.equal(s.title, 'Buck — Reel 2024');
  assert.equal(s.provider, 'vimeo');
  assert.equal(s.mediaUrl, 'https://vimeo.com/123456');
  assert.ok(isPlatform(s.site) && hostLabel(s.site) === 'Vimeo');
  assert.deepEqual(searchPage(s, hostLabel(s.site)).studios, ['Buck']);
});

test('a site without a name takes the credited studio that spells its host', () => {
  const src = { site: 'studiodumbar.com', pageUrl: 'https://studiodumbar.com/work/x', title: 'X', agency: 'Studio Dumbar/DEPT®', scrapedAt: '' };
  assert.equal(siteNameOf(src), 'Studio Dumbar');
  assert.deepEqual(searchPage(src, siteNameOf(src)).studios, ['Studio Dumbar', 'DEPT®']);
  assert.equal(siteNameOf({ ...src, agency: undefined }), 'Studiodumbar');
  assert.equal(siteNameOf({ ...src, siteName: 'Dumbar' }), 'Dumbar');
});

test('shared uploads are searchable by their own docs, and rebuild when enriched', () => {
  const bundle: SearchBundle = { version: 1, built: '', sites: { 'koto.com': 'Koto' }, pages: [], docs: [{ id: 'lib1', title: 'Swoosh', page: -1, tags: [], duration: 4, width: 1920, height: 1080, added: 0 }] };
  const index = new SearchIndex(bundle, null);
  const clip: Asset = { id: 'up1', name: 'final_v3', duration: 6, width: 1080, height: 1080, fps: 30, l0: null, l1: { url: '', width: 480, height: 480, bytes: 0 }, l2: null };
  const item = (a: Asset): PoolItem => ({ id: a.id, name: a.name, width: a.width, height: a.height, duration: a.duration, added: 100, extra: uploadDoc(a, 100, a.name) });
  const lib: PoolItem = { id: 'lib1', name: 'Swoosh', width: 1920, height: 1080, duration: 4, added: 0 };

  index.setPool([lib, item(clip)]);
  assert.deepEqual(index.search({ ...emptyQuery(), text: 'nike' }).ids, []);

  const enriched: Asset = {
    ...clip,
    source: { site: 'koto.com', siteName: 'Koto', pageUrl: 'https://koto.com/projects/nike', title: 'Nike Air', client: 'Nike', tags: ['Brand identity'], scrapedAt: '2026-10-23T00:00:00Z' },
    analysis: { caption: 'A chrome swoosh spins', tags: ['technique:3d-render', 'visual:chrome'], model: 'claude-haiku-5-5', at: '2026-10-23T00:00:01Z' },
  };
  // Same ids, new doc: the rev makes it rebuild.
  index.setPool([lib, item(enriched)]);
  assert.deepEqual(index.search({ ...emptyQuery(), text: 'nike' }).ids, ['up1']);
  assert.deepEqual(index.search({ ...emptyQuery(), text: 'chrome' }).ids, ['up1']);
  const r = index.search({ ...emptyQuery(), filters: { studio: ['Koto'] } });
  assert.deepEqual(r.ids, ['up1']);
  assert.deepEqual(index.search({ ...emptyQuery(), filters: { technique: ['3d-render'] } }).ids, ['up1']);
});
