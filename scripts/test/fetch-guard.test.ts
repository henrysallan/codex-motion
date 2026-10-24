// Checks for the Fetcher's publicOnly mode, which api/enrich.ts uses for
// links people type: address checks on every hop, manual redirects, a byte
// cap. And enrich's per-person limit. Run with `npm test`.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { withinLimit } from '../../api/enrich.ts';
import { Fetcher, isPublicAddress } from '../scrape/site.ts';

test('only public unicast addresses count as public', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e']) {
    assert.ok(isPublicAddress(ip), ip);
  }
  for (const ip of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '100.127.255.254',
    '127.0.0.1',
    '127.255.0.9',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.0.8',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%en0',
    'ff02::1',
    '2001:db8::1',
    '2001::1',
    '2002:7f00:1::1',
    'not an ip',
    '',
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

// ---- against a local server ---------------------------------------------------------

let server: Server;
let base: string;
let port: string;
const hits: string[] = [];

before(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    hits.push(path);
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>${body}</title>`);
    };
    if (path === '/page') return html('landed');
    if (path === '/hop1') return res.writeHead(302, { location: '/hop2' }).end();
    if (path === '/hop2') return res.writeHead(301, { location: `${base}/page` }).end();
    if (path === '/loop') return res.writeHead(302, { location: '/loop' }).end();
    if (path === '/to-metadata') return res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    if (path === '/to-port') return res.writeHead(307, { location: 'http://127.0.0.1:1/' }).end();
    if (path === '/to-file') return res.writeHead(302, { location: 'file:///etc/passwd' }).end();
    if (path === '/endless') {
      // Chunked, no Content-Length: only the cap stops it.
      res.writeHead(200, { 'content-type': 'text/html' });
      const chunk = 'x'.repeat(8192);
      let sent = 0;
      const write = () => {
        let more = true;
        while (sent < 1 << 20 && more) {
          more = res.write(chunk);
          sent += chunk.length;
        }
        if (sent >= 1 << 20) res.end();
        else res.once('drain', write);
      };
      res.on('error', () => {});
      return write();
    }
    if (path === '/bomb') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      return res.end(gzipSync(Buffer.alloc(4 << 20, 32)));
    }
    if (path === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      return res.end(gzipSync('<!doctype html><title>zipped</title>'));
    }
    if (path === '/declared') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(1 << 20) });
      return res.end(Buffer.alloc(1 << 20, 32));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = String((server.address() as AddressInfo).port);
  base = `http://127.0.0.1:${port}`;
});

after(() => server.close());

// Lets 127.0.0.1 on the test port through, and nothing else.
const local = (maxBytes = 64 << 10) =>
  new Fetcher(1, 0, { publicOnly: true, maxBytes, allowAddress: (ip) => ip === '127.0.0.1', allowPort: (p) => p === port });

test('publicOnly refuses private addresses before connecting', async () => {
  hits.length = 0;
  const strict = new Fetcher(1, 0, { publicOnly: true, allowPort: (p) => p === port });
  const literal = await strict.page(`${base}/page`);
  assert.match(literal.error ?? '', /127\.0\.0\.1 isn’t a public address/);
  // A name is resolved, and refused for what it resolves to.
  const named = await strict.page(`http://localhost:${port}/page`);
  assert.match(named.error ?? '', /localhost points to an address that isn’t public/);
  assert.equal(await strict.text(`${base}/page`), null);
  assert.deepEqual(hits, []);
  for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[::ffff:7f00:1]/', 'http://2130706433/', 'http://0x7f.1/']) {
    assert.ok((await strict.page(url)).error, url);
  }
});

test('publicOnly follows redirects itself and checks every hop', async () => {
  hits.length = 0;
  const ok = await local().page(`${base}/hop1`);
  assert.equal(ok.error, undefined);
  assert.equal(ok.url, `${base}/page`);
  assert.match(ok.html ?? '', /landed/);
  assert.deepEqual(hits, ['/hop1', '/hop2', '/page']);

  assert.match((await local().page(`${base}/to-metadata`)).error ?? '', /169\.254\.169\.254 isn’t a public address/);
  assert.match((await local().page(`${base}/to-port`)).error ?? '', /port 1/);
  assert.match((await local().page(`${base}/to-file`)).error ?? '', /file:/);
  assert.match((await local().page(`${base}/loop`)).error ?? '', /more than 5 redirects/);
});

test('publicOnly caps what it reads, after decompression', async () => {
  assert.match((await local().page(`${base}/endless`)).error ?? '', /over 65536 bytes/);
  assert.equal(await local().text(`${base}/endless`), null);
  assert.match((await local().page(`${base}/bomb`)).error ?? '', /over 65536 bytes/);
  assert.match((await local().page(`${base}/declared`)).error ?? '', /over 65536 bytes/);
  assert.match((await local().page(`${base}/gzip`)).html ?? '', /zipped/);
});

test('without publicOnly the scraper fetches as it always has', async () => {
  const scraper = new Fetcher(1, 0);
  const page = await scraper.page(`${base}/hop1`);
  assert.equal(page.url, `${base}/page`);
  assert.match(page.html ?? '', /landed/);
  assert.equal((await scraper.page(`${base}/endless`)).html?.length, 1 << 20);
});

test('enrich allows 30 calls per person per 10 minutes', () => {
  const t0 = 1_000_000_000_000;
  for (let i = 0; i < 30; i++) assert.ok(withinLimit('limit-a', t0 + i));
  assert.equal(withinLimit('limit-a', t0 + 60_000), false);
  assert.ok(withinLimit('limit-b', t0 + 60_000), 'someone else is counted apart');
  assert.ok(withinLimit('limit-a', t0 + 10 * 60_000 + 30), 'the window moves on');
});
