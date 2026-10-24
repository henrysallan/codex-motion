// Checks for link previews in clip notes: how a note's text is cut into
// links (src/app/detail/links.ts), and what api/unfurl.ts reads from a page,
// against a local server. Run with `npm test`.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { unfurl } from '../../api/unfurl.ts';
import { linkify, linksIn } from '../../src/app/detail/links.ts';
import { Fetcher } from '../scrape/site.ts';

const links = (line: string) => linkify(line).flatMap((s) => ('href' in s ? [s.text] : []));

test('links end before trailing punctuation and unopened brackets', () => {
  assert.deepEqual(links('see https://vimeo.com/123.'), ['https://vimeo.com/123']);
  assert.deepEqual(links('(https://github.com/vercel/next.js)'), ['https://github.com/vercel/next.js']);
  assert.deepEqual(links('https://en.wikipedia.org/wiki/Fold_(album) is good'), ['https://en.wikipedia.org/wiki/Fold_(album)']);
  assert.deepEqual(links('“https://a.example/x”, and https://b.example/?q=1&r=2!'), ['https://a.example/x', 'https://b.example/?q=1&r=2']);
  assert.deepEqual(links('www.youtube.com/watch?v=abc; ok'), ['www.youtube.com/watch?v=abc']);
  assert.deepEqual(links('no links: example.com, file.mp4, ftp://x.example, javascript:alert(1)'), []);
});

test('a line keeps its text around the links', () => {
  assert.deepEqual(linkify('a https://x.example b'), [{ text: 'a ' }, { href: 'https://x.example/', text: 'https://x.example' }, { text: ' b' }]);
  assert.deepEqual(linkify('www.x.example'), [{ href: 'https://www.x.example/', text: 'www.x.example' }]);
});

test('a note lists each link once, in order', () => {
  assert.deepEqual(linksIn('https://b.example\nhttps://a.example and https://b.example/\nwww.c.example'), [
    'https://b.example/',
    'https://a.example/',
    'https://www.c.example/',
  ]);
});

// ---- against a local server ---------------------------------------------------------

let server: Server;
let base: string;
let port: string;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    const html = (body: string) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html>${body}`);
    if (path === '/robots.txt') return res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /private\n');
    if (path === '/project')
      return html(`<head>
        <title>Fallback title</title>
        <meta property="og:title" content="  Brand   film ">
        <meta property="og:description" content="A short film.">
        <meta property="og:site_name" content="Studio">
        <meta property="og:image" content="/img/cover.png">
        <link rel="icon" href="/favicon.ico"><link rel="icon" type="image/png" href="icons/32.png">
      </head><body>hi</body>`);
    if (path === '/plain') return html('<title>Just a title</title><meta name="description" content="Just a title">');
    if (path === '/big-image') return html('<meta property="og:image" content="/img/huge.png">');
    if (path === '/private') return html('<title>secret</title>');
    if (path === '/img/cover.png' || path === '/icons/32.png' || path === '/photo.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
    if (path === '/img/huge.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.alloc(2 << 20));
    if (path === '/favicon.ico') return res.writeHead(200, { 'content-type': 'text/html' }).end('<p>not an icon</p>');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = String((server.address() as AddressInfo).port);
  base = `http://127.0.0.1:${port}`;
});

after(() => server.close());

const local = () => new Fetcher(3, 0, { publicOnly: true, maxBytes: 1 << 20, allowAddress: (ip) => ip === '127.0.0.1', allowPort: (p) => p === port });

test('a page previews as its Open Graph tags, with images inlined', async () => {
  const p = await unfurl(new URL(`${base}/project`), local());
  assert.equal(p.title, 'Brand film');
  assert.equal(p.description, 'A short film.');
  assert.equal(p.site, 'Studio');
  assert.equal(p.image, `data:image/png;base64,${PNG.toString('base64')}`);
  // The declared PNG icon wins over /favicon.ico.
  assert.equal(p.icon, `data:image/png;base64,${PNG.toString('base64')}`);
});

test('a bare page falls back to its title and host, with no repeated description', async () => {
  const p = await unfurl(new URL(`${base}/plain`), local());
  assert.equal(p.title, 'Just a title');
  assert.equal(p.description, undefined);
  assert.equal(p.site, '127.0.0.1');
  // /favicon.ico answers HTML, which isn't an icon.
  assert.equal(p.icon, undefined);
});

test('images over the cap are left out', async () => {
  const p = await unfurl(new URL(`${base}/big-image`), local());
  assert.equal(p.image, undefined);
});

test('a link to an image previews as the image', async () => {
  const p = await unfurl(new URL(`${base}/photo.png`), local());
  assert.equal(p.title, 'photo.png');
  assert.ok(p.image?.startsWith('data:image/png;base64,'));
});

test('robots.txt and missing pages are refused', async () => {
  await assert.rejects(unfurl(new URL(`${base}/private`), local()), /robots\.txt/);
  await assert.rejects(unfurl(new URL(`${base}/gone`), local()), /answered 404/);
});

test('without the test allowances, a local address is never fetched', async () => {
  await assert.rejects(unfurl(new URL(`${base}/project`), new Fetcher(3, 0, { publicOnly: true, allowPort: (p) => p === port })), /isn’t a public address/);
});
