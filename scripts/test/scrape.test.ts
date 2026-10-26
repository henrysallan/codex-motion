// Checks for the site scraper's parsing: run with `npm test`. The fixture
// markup mirrors how the common studio-site builders embed video.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slug, tagLabel } from '../../src/media/vocabulary.ts';
import { HELD_BACK, pacer, Refused } from '../scrape/download.ts';
import { agentReasons, extractPage, mediaUrlsIn, wantsRender } from '../scrape/extract.ts';
import { groupItems, stripSiteName, toItem } from '../scrape/items.ts';
import { parseRobots } from '../scrape/site.ts';
import type { PageSignals } from '../scrape/types.ts';
import { classifyMedia, looksLikeFilename, normalizePage, qualityScore } from '../scrape/urls.ts';

const PAGE = 'https://studio.example/work/nike-air';

const html = (body: string, head = '') => `<!doctype html><html lang="en"><head><title>Nike Air — Studio</title>${head}</head><body>${body}</body></html>`;

test('classifies files, streams and players', () => {
  assert.deepEqual(classifyMedia('/media/reel.mp4?v=2', PAGE), { kind: 'file', provider: undefined, key: 'studio.example/media/reel.mp4', url: 'https://studio.example/media/reel.mp4?v=2' });
  assert.equal(classifyMedia('https://player.vimeo.com/video/123456789?h=abc&background=1')?.key, 'vimeo:123456789');
  assert.equal(classifyMedia('https://vimeo.com/123456789')?.key, 'vimeo:123456789');
  // Page and unlisted links become the player form, which resolves without a login.
  assert.equal(classifyMedia('https://vimeo.com/989860823/80931b01ff')?.url, 'https://player.vimeo.com/video/989860823?h=80931b01ff');
  assert.equal(classifyMedia('https://player.vimeo.com/video/222222222?h=ab12&background=1')?.url, 'https://player.vimeo.com/video/222222222?h=ab12');
  assert.equal(classifyMedia('https://player.vimeo.com/progressive_redirect/playback/123456789/rendition/1080p/file.mp4?loc=external&signature=x')?.key, 'vimeo:123456789');
  assert.equal(classifyMedia('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0')?.key, 'youtube:dQw4w9WgXcQ');
  assert.equal(classifyMedia('https://youtu.be/dQw4w9WgXcQ')?.kind, 'embed');
  assert.deepEqual(classifyMedia('https://player.mux.com/a1B2c3D4e5F6g7H8i9J0k1L2'), { kind: 'stream', provider: 'mux', key: 'mux:a1B2c3D4e5F6g7H8i9J0k1L2', url: 'https://stream.mux.com/a1B2c3D4e5F6g7H8i9J0k1L2.m3u8' });
  assert.equal(classifyMedia('https://cdn.prod.website-files.com/abc/def_reel-transcode.webm')?.provider, 'webflow');
  assert.equal(classifyMedia('https://video.squarespace-cdn.com/content/v1/x/y/playlist.m3u8')?.kind, 'stream');
  // Not videos: pages, images, segments, Vimeo's MSE ranges, profile links.
  assert.equal(classifyMedia('https://vimeo.com/studioname'), null);
  assert.equal(classifyMedia('https://i.vimeocdn.com/video/123456789-abc_640.jpg'), null);
  assert.equal(classifyMedia('https://cdn.example/hls/seg-12-v1-a1.ts'), null);
  assert.equal(classifyMedia('https://manifest-oci-us-ashburn-1-vop1.fastly.mux.com/lznd6vfCC9nyGJ29/rendition.m3u8?cdn=fastly'), null);
  assert.equal(classifyMedia('https://example.com/video/default.mp4'), null);
  assert.equal(classifyMedia('https://vod-adaptive-ak.vimeocdn.com/exp=1/range/prot/abc/avf/def.mp4?pathsig=x'), null);
});

test('normalizes page links', () => {
  assert.equal(normalizePage('/work/?utm_source=x#top', PAGE), 'https://studio.example/work');
  assert.equal(normalizePage('https://studio.example/', PAGE), 'https://studio.example/');
  assert.equal(normalizePage('/brochure.pdf', PAGE), null);
});

test('ranks renditions', () => {
  assert.ok(qualityScore('https://x/reel_1080p.mp4') > qualityScore('https://x/reel_720p.mp4'));
  assert.ok(qualityScore('https://x/reel-hd.mp4') > qualityScore('https://x/reel-mobile.mp4'));
  assert.ok(qualityScore('https://x/reel.mp4') > qualityScore('https://x/reel.mp4', '(max-width: 768px)'));
});

test('splits Webflow url lists but keeps Cloudinary commas', () => {
  assert.deepEqual(mediaUrlsIn('https://a.example/x.mp4,https://a.example/x.webm', true), ['https://a.example/x.mp4', 'https://a.example/x.webm']);
  assert.deepEqual(mediaUrlsIn('https://res.cloudinary.com/demo/video/upload/w_500,h_300/clip.mp4', true), ['https://res.cloudinary.com/demo/video/upload/w_500,h_300/clip.mp4']);
});

test('reads a project card: video, title, client and link', () => {
  const { candidates } = extractPage(
    html(`<main><a class="project-card" href="/work/nike-air"><div class="media">
      <video autoplay loop muted playsinline poster="/p/nike.jpg">
        <source src="/v/nike-mobile.mp4" media="(max-width: 600px)" type="video/mp4">
        <source src="/v/nike-1080p.mp4" type="video/mp4">
      </video></div><div class="info"><h3>Nike Air</h3><p>Nike · 2025</p></div></a></main>`),
    PAGE,
    'static',
  );
  assert.equal(candidates.length, 1);
  const [c] = candidates;
  assert.equal(c.url, 'https://studio.example/v/nike-1080p.mp4');
  assert.deepEqual(c.variants, ['https://studio.example/v/nike-mobile.mp4']);
  assert.equal(c.via, 'video-tag');
  assert.equal(c.poster, 'https://studio.example/p/nike.jpg');
  assert.equal(c.context?.heading, 'Nike Air');
  assert.match(c.context?.text ?? '', /Nike · 2025/);
  assert.equal(c.context?.link?.href, 'https://studio.example/work/nike-air');
  assert.equal(c.element?.attrs.loop, 'true');
  assert.equal(c.element?.sources?.length, 2);
});

test('Webflow background video is one video, not three', () => {
  const { candidates } = extractPage(
    html(`<div data-poster-url="https://cdn.prod.website-files.com/s/p.jpg" data-video-urls="https://cdn.prod.website-files.com/s/reel-transcode.mp4,https://cdn.prod.website-files.com/s/reel-transcode.webm" data-autoplay="true" data-loop="true" class="w-background-video">
      <video autoplay loop muted playsinline data-wf-ignore="true"><source src="https://cdn.prod.website-files.com/s/reel-transcode.mp4"><source src="https://cdn.prod.website-files.com/s/reel-transcode.webm"></video></div>`),
    PAGE,
    'static',
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].provider, 'webflow');
  assert.equal(candidates[0].url, 'https://cdn.prod.website-files.com/s/reel-transcode.mp4');
});

test('finds players: iframes, ids, og, JSON-LD and inline JSON', () => {
  const head = `<meta property="og:video" content="https://player.vimeo.com/video/111111111">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoObject","name":"Brand film","contentUrl":"https://cdn.studio.example/brand.mp4","uploadDate":"2025-03-01"}</script>`;
  const body = `<section><h2>Adidas — Run</h2>
      <iframe src="https://player.vimeo.com/video/222222222?h=ab12&background=1&loop=1" title="Adidas Run"></iframe></section>
    <lite-youtube videoid="dQw4w9WgXcQ"></lite-youtube>
    <div class="plyr" data-plyr-provider="vimeo" data-plyr-embed-id="333333333"></div>
    <a href="https://vimeo.com/444444444">Watch the full film</a>
    <script id="__NEXT_DATA__" type="application/json">{"props":{"projects":[{"title":"Puma Speed","client":"Puma","video":"https:\\/\\/cdn.sanity.io\\/files\\/abc\\/prod\\/puma.mp4"}]}}</script>
    <script>window.reel = "https://stream.mux.com/a1B2c3D4e5F6g7H8i9J0k1L2.m3u8";</script>`;
  const { candidates } = extractPage(html(body, head), PAGE, 'static');
  const byKey = Object.fromEntries(candidates.map((c) => [c.key, c]));
  assert.equal(byKey['vimeo:222222222']?.via, 'iframe');
  assert.equal(byKey['vimeo:222222222']?.context?.heading, 'Adidas — Run');
  assert.deepEqual((byKey['vimeo:222222222']?.meta as { params: object }).params, { h: 'ab12', background: '1', loop: '1' });
  assert.equal(byKey['youtube:dQw4w9WgXcQ']?.via, 'player-id');
  assert.equal(byKey['vimeo:333333333']?.via, 'player-id');
  assert.equal(byKey['vimeo:444444444']?.via, 'link');
  assert.equal(byKey['vimeo:111111111']?.via, 'og:video');
  assert.equal(byKey['cdn.studio.example/brand.mp4']?.via, 'json-ld');
  assert.equal(byKey['cdn.studio.example/brand.mp4']?.context?.heading, 'Brand film');
  const puma = byKey['cdn.sanity.io/files/abc/prod/puma.mp4'];
  assert.equal(puma?.provider, 'sanity');
  assert.deepEqual((puma?.meta as { json: object }).json, { title: 'Puma Speed', client: 'Puma', video: 'https://cdn.sanity.io/files/abc/prod/puma.mp4' });
  assert.equal(byKey['mux:a1B2c3D4e5F6g7H8i9J0k1L2']?.kind, 'stream');
  assert.equal(candidates.length, 8);
});

test('page metadata and render signals', () => {
  const head = `<meta name="description" content="A film for Nike."><meta property="og:site_name" content="Studio"><meta name="generator" content="Webflow"><link rel="canonical" href="/work/nike-air">`;
  const { meta, signals, links } = extractPage(html(`<h1>Nike Air</h1><p>Credits: Director — A. Person</p><a href="/about">About</a><a href="mailto:hi@studio.example">Mail</a>`, head), PAGE, 'static');
  assert.equal(meta.title, 'Nike Air — Studio');
  assert.equal(meta.description, 'A film for Nike.');
  assert.equal(meta.og.site_name, 'Studio');
  assert.equal(meta.generator, 'Webflow');
  assert.equal(meta.canonical, 'https://studio.example/work/nike-air');
  assert.equal(meta.h1, 'Nike Air');
  assert.match(meta.text, /Nike Air Credits: Director — A\. Person About/);
  assert.deepEqual(links, ['https://studio.example/about']);
  assert.equal(wantsRender(signals, 0), false);

  const shell = extractPage(html('<div id="root"></div><script src="/a.js"></script><script src="/b.js"></script><script>boot()</script>'), PAGE, 'static');
  assert.equal(wantsRender(shell.signals, 0), true);
  const lazy = extractPage(html('<div class="player"><video muted loop></video></div><p>Some words about the project here.</p>'), PAGE, 'static');
  assert.equal(lazy.signals.unresolvedVideos, 1);
  assert.equal(wantsRender(lazy.signals, 0), true);
});

test('robots.txt: a crawl-delay above every group applies to all', () => {
  assert.equal(parseRobots('Crawl-delay: 10\nUser-agent: *\nDisallow:\n').crawlDelay, 10);
});

test('robots.txt: longest match wins, Allow breaks ties', () => {
  const r = parseRobots(`User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/press\nDisallow: /*.json$\nCrawl-delay: 2\nSitemap: https://studio.example/sitemap.xml`);
  assert.equal(r.allowed('https://studio.example/work'), true);
  assert.equal(r.allowed('https://studio.example/private/notes'), false);
  assert.equal(r.allowed('https://studio.example/private/press/kit'), true);
  assert.equal(r.allowed('https://studio.example/data.json'), false);
  assert.equal(r.allowed('https://studio.example/data.json?x=1'), true);
  assert.equal(r.crawlDelay, 2);
  assert.deepEqual(r.sitemaps, ['https://studio.example/sitemap.xml']);
});

test('one item per video across pages; the project page is primary', () => {
  const home = extractPage(html('<video src="/v/a.mp4" autoplay></video><video src="/v/b.mp4"></video><video src="/v/c.mp4"></video>'), 'https://studio.example/', 'static');
  const project = extractPage(html('<h1>Project A</h1><video src="/v/a.mp4" controls></video>'), 'https://studio.example/work/a', 'static');
  const items = groupItems([...home.candidates, ...project.candidates]);
  assert.equal(items.length, 3);
  const a = items.find((i) => i.key === 'studio.example/v/a.mp4')!;
  assert.equal(a.appearances.length, 2);
  assert.equal(a.primary.pageUrl, 'https://studio.example/work/a');
});

test('JSON data-sources: one video, full signed URL with its spaces', () => {
  const sources = JSON.stringify([
    { size: 1024, source: [{ url: 'https://player.vimeo.com/progressive_redirect/playback/1197612378/rendition/1080p/file.mp4%20%281080p%29.mp4?loc=external&signature=abc', type: 'video/mp4' }] },
    { size: 640, source: [{ url: 'https://player.vimeo.com/progressive_redirect/playback/1197612378/rendition/540p/file.mp4%20%28540p%29.mp4?loc=external&signature=def', type: 'video/mp4' }] },
  ]).replace(/\//g, '\\/');
  const { candidates } = extractPage(html(`<figure class="figure-video"><video playsinline autoplay loop muted data-sources='${sources.replace(/'/g, '&#39;')}'></video></figure>`), PAGE, 'static');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].key, 'vimeo:1197612378');
  assert.equal(candidates[0].url, 'https://player.vimeo.com/progressive_redirect/playback/1197612378/rendition/1080p/file.mp4%20%281080p%29.mp4?loc=external&signature=abc');
});

test('a file name in a player title is a label, not a relative URL', () => {
  const setup = JSON.stringify({ autoplay: 'true', title: 'Reel-Hauptfilm-16zu9 -VA4-1080.mp4' }).replace(/"/g, '&quot;');
  const { candidates } = extractPage(html(`<div class="videopack-wrapper" data-videopack="${setup}"><video src><source type="video/mp4" src="/wp-content/uploads/video/Reel-Hauptfilm-16zu9%20-VA4-1080.mp4?_=1"></video></div>`), PAGE, 'static');
  assert.deepEqual(candidates.map((c) => c.url), ['https://studio.example/wp-content/uploads/video/Reel-Hauptfilm-16zu9%20-VA4-1080.mp4?_=1']);
});

test('a card thumbnail belongs to the page it links to, titled by its caption', () => {
  const card = (slug: string, name: string) =>
    `<div class="related-project"><a href="/work/${slug}"><figure class="figure-video"><video autoplay loop muted src="/media/${slug}/thumbnail.mp4"></video><figcaption><span class="figcaption-caption">${name} —</span></figcaption></figure></a></div>`;
  const page = extractPage(html(`<h1>Apple</h1><video src="/media/apple/hero.mp4" autoplay></video><h3>More projects</h3>${card('postnl', 'PostNL')}`), 'https://studio.example/work/apple', 'static');
  const other = extractPage(html(`<h1>Boskalis</h1><h3>More projects</h3>${card('postnl', 'PostNL')}`), 'https://studio.example/work/boskalis', 'static');
  const metas = new Map([[page.meta.url, page.meta], [other.meta.url, other.meta], ['https://studio.example/work/postnl', { ...page.meta, url: 'https://studio.example/work/postnl', h1: 'PostNL' }]]);
  const items = groupItems([...page.candidates, ...other.candidates]).map((g) => toItem(g, metas, { url: 'https://studio.example/', host: 'studio.example' }, ''));
  const thumb = items.find((i) => i.key.endsWith('postnl/thumbnail.mp4'))!;
  assert.equal(thumb.page.url, 'https://studio.example/work/postnl');
  assert.equal(thumb.title, 'PostNL');
  assert.equal(thumb.appearances[0].context?.section, 'More projects');
  const hero = items.find((i) => i.key.endsWith('apple/hero.mp4'))!;
  assert.equal(hero.page.url, 'https://studio.example/work/apple');
  assert.equal(hero.title, 'Apple');
});

test('a video named only in data goes to the most specific page', () => {
  const data = (urls: string[]) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { videos: urls } })}</script>`;
  const all = ['https://vimeo.com/111111111/aa11bb22cc', 'https://vimeo.com/222222222/dd33ee44ff', 'https://vimeo.com/333333333/0011223344'];
  const listing = extractPage(html(data(all)), 'https://studio.example/work', 'static');
  const project = extractPage(html(data([all[1]])), 'https://studio.example/projects/two', 'static');
  const items = groupItems([...listing.candidates, ...project.candidates]);
  assert.equal(items.find((g) => g.key === 'vimeo:222222222')?.primary.pageUrl, 'https://studio.example/projects/two');
});

test('page titles lose the site name', () => {
  assert.equal(stripSiteName('Aurora — Fixture Studio', 'Fixture Studio'), 'Aurora');
  assert.equal(stripSiteName('Koto | Spotify', 'Koto'), 'Spotify');
  assert.equal(stripSiteName('Tempo', 'Studio Dumbar'), 'Tempo');
});

test('agent trigger: placeholders beside found videos are not a gap', () => {
  const signals = (s: Partial<PageSignals>): PageSignals => ({ videoTags: 0, unresolvedVideos: 0, playerHints: 0, moreButton: false, textLength: 500, scripts: 2, shell: false, ...s });
  // Koto: a few empty <video src=""> placeholders next to 120 Vimeo embeds.
  assert.deepEqual(agentReasons(signals({ unresolvedVideos: 4, playerHints: 3 }), 120), []);
  assert.equal(agentReasons(signals({ unresolvedVideos: 3 }), 1).length, 1);
  assert.equal(agentReasons(signals({ playerHints: 2 }), 0).length, 1);
  assert.match(agentReasons(signals({ moreButton: true }), 30)[0], /Load more/);
});

test('vocabulary tags read back as labels', () => {
  assert.equal(slug('3D render'), '3d-render');
  assert.equal(slug('Rhythmic to beat'), 'rhythmic-to-beat');
  assert.equal(tagLabel('technique:3d-render'), '3D render');
  assert.equal(tagLabel('use:ui-motion'), 'UI motion');
  assert.equal(tagLabel('visual:chrome'), 'chrome');
});

test('upload file names are not titles', () => {
  for (const t of ['_Copilot_HumanistAI_CS_01_Hero', 'NIKE_AIR_final_v3', 'reel_1080p', 'Aithyra_Brand-Video_1920x1080', '14', 'clip.mp4']) assert.equal(looksLikeFilename(t), true, t);
  for (const t of ['OpenAI DevDay25 - The global event for developers', 'Utah Jazz', 'a.s.r. insurances']) assert.equal(looksLikeFilename(t), false, t);
});

test('image renders of a video are not videos', () => {
  assert.equal(classifyMedia('https://pentagram-production.imgix.net/77c6b208/Xsolla_02.mp4?auto=compress%2Cformat&fm=jpg&w=2000&s=abc'), null);
  assert.equal(classifyMedia('https://pentagram-production.imgix.net/77c6b208/Xsolla_02.mp4?auto=compress')?.kind, 'file');
});

test('a "Load more" on every page is site chrome, except on the listing', () => {
  const s: PageSignals = { videoTags: 0, unresolvedVideos: 0, playerHints: 0, moreButton: true, textLength: 500, scripts: 2, shell: false };
  assert.deepEqual(agentReasons(s, 3, { moreIsChrome: true }), []);
  assert.equal(agentReasons(s, 3).length, 1);
});

test('template-wide player markup is chrome too', () => {
  const s: PageSignals = { videoTags: 0, unresolvedVideos: 0, playerHints: 3, moreButton: false, textLength: 500, scripts: 2, shell: false };
  assert.deepEqual(agentReasons(s, 0, { hintsAreChrome: true }), []);
  assert.equal(agentReasons(s, 0).length, 1);
});

test('the Vimeo pacer runs one request at a time and stops after refusals in a row', async () => {
  let trips = 0;
  const p = pacer({ gapMs: 0, jitterMs: 0, tripAfter: 3, onTrip: () => trips++ });
  let running = 0;
  let most = 0;
  const ran: string[] = [];
  const task = (name: string, outcome: 'ok' | 'refused' | 'error') => () =>
    p.run(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      ran.push(name);
      if (outcome === 'refused') throw new Refused('HTTP 403');
      if (outcome === 'error') throw new Error('HTTP 401');
      return name;
    });
  // A video's own failure (a 401) breaks a run of refusals; three in a row trip it.
  const outcomes = ['refused', 'refused', 'error', 'refused', 'ok', 'refused', 'refused', 'refused', 'ok', 'ok'] as const;
  const settled = await Promise.allSettled(outcomes.map((o, i) => task(`t${i}`, o)()));
  assert.equal(most, 1);
  assert.equal(trips, 1);
  assert.ok(p.tripped);
  assert.deepEqual(ran, ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7']);
  assert.deepEqual(
    settled.slice(8).map((s) => s.status === 'rejected' && (s.reason as Error).message),
    [HELD_BACK, HELD_BACK],
  );
  assert.equal(settled[4].status === 'fulfilled' && settled[4].value, 't4');
});

test('FrameRate links are embeds keyed by video, found in iframes and links', () => {
  for (const u of ['https://framerate.tv/embed/WYPO85Rx', 'https://www.framerate.tv/watch/WYPO85Rx?t=3', 'https://framerate.tv/player/WYPO85Rx']) {
    assert.deepEqual(classifyMedia(u), { kind: 'embed', provider: 'framerate', key: 'framerate:WYPO85Rx', url: 'https://framerate.tv/embed/WYPO85Rx' });
  }
  assert.equal(classifyMedia('https://framerate.tv/profile/someone'), null);
  const { candidates } = extractPage(html(`<iframe src="https://framerate.tv/embed/AbC123xy" allowfullscreen></iframe><a href="https://framerate.tv/watch/ZzZ987qq">Watch</a>`), PAGE, 'static');
  assert.deepEqual(candidates.map((c) => c.key), ['framerate:AbC123xy', 'framerate:ZzZ987qq']);
  // Mux's per-rendition playlists aren't videos of their own.
  assert.equal(classifyMedia('https://manifest-oci-us-phoenix-1-vop1.fastly.mux.com/abc/rendition.m3u8?cdn=fastly'), null);
});

test('Vimeo external playlists are streams; signed /play/ manifests key by video id', () => {
  assert.deepEqual(classifyMedia('https://player.vimeo.com/external/1195935700.m3u8?s=8527&logging=false'), { kind: 'stream', provider: 'vimeo', key: 'vimeo:1195935700', url: 'https://player.vimeo.com/external/1195935700.m3u8?s=8527&logging=false' });
  assert.equal(classifyMedia('https://player.vimeo.com/external/1195935700.hd.mp4?s=8527')?.kind, 'file');
  const play = classifyMedia('https://player.vimeo.com/play/60601361-f1d0-4053-9f21-4772459263a8/hls.m3u8?s=1146371509_1765987623_5253148c');
  assert.deepEqual([play?.kind, play?.key], ['stream', 'vimeo:1146371509']);
  assert.equal(classifyMedia('https://player.vimeo.com/play/60601361-f1d0-4053-9f21-4772459263a8/dash.mpd?s=1146371509_1765987623_5253148c')?.key, 'vimeo:1146371509');
});

test('a bare file name beside its URL in page data is a label', () => {
  const data = JSON.stringify([{ src: 1 }, 'https://cdn.studio.example/website-assets/landing_page_1.mp4', 'Landing_Page_1.mp4', 'video/mp4']);
  const { candidates } = extractPage(html(`<script type="application/json">${data}</script>`), PAGE, 'static');
  assert.deepEqual(candidates.map((c) => c.url), ['https://cdn.studio.example/website-assets/landing_page_1.mp4']);
});
