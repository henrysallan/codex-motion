// Animated GIFs as clips: reading GIF structure, deciding what to keep, and
// finding GIFs on a page. Run with `npm test`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gifFilter, gifFps, gifRejection, readGif } from '../lib/gif.ts';
import { extractPage, srcsetUrls } from '../scrape/extract.ts';
import { groupItems } from '../scrape/items.ts';
import { classifyMedia, qualityScore } from '../scrape/urls.ts';

// A GIF of `frames` 1×1 frames with the given delays (hundredths) and size.
function gif(delays: number[], { width = 1, height = 1, transparent = false } = {}): Uint8Array {
  const le = (n: number) => [n & 0xff, n >> 8];
  const bytes = [...Buffer.from('GIF89a'), ...le(width), ...le(height), 0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff];
  for (const d of delays) {
    bytes.push(0x21, 0xf9, 4, transparent ? 1 : 0, ...le(d), 0, 0);
    bytes.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0);
  }
  // A comment extension between frames, as some encoders write.
  bytes.splice(bytes.length, 0, 0x21, 0xfe, 3, 0x61, 0x62, 0x63, 0, 0x3b);
  return Uint8Array.from(bytes);
}

test('reads frames, browser-timed delays, size and transparency', () => {
  const g = readGif(gif([0, 50, 4], { width: 480, height: 270, transparent: true }))!;
  assert.equal(g.frames, 3);
  assert.deepEqual(g.delays, [0.1, 0.5, 0.04]);
  assert.equal(Number(g.duration.toFixed(2)), 0.64);
  assert.deepEqual([g.width, g.height, g.transparent], [480, 270, true]);
  assert.equal(gifFps(g), '100/4');
  assert.equal(gifFps(readGif(gif([8, 8]))!), '100/8');
  assert.equal(gifFps(readGif(gif([1, 1]))!), '100/10');
  assert.match(gifFilter(g), /lutrgb=.*overlay.*fps=100\/4,/);
  assert.equal(readGif(Buffer.from('not a gif at all')), null);
});

test('keeps animation; drops stills, icons and blips', () => {
  assert.equal(gifRejection(readGif(gif([10, 10], { width: 640, height: 360 }))!), null);
  assert.equal(gifRejection(readGif(gif([10], { width: 640, height: 360 }))!), 'a still GIF');
  assert.match(gifRejection(readGif(gif([10, 10], { width: 64, height: 64 }))!) ?? '', /small GIF/);
  assert.match(gifRejection(readGif(gif([5, 5], { width: 640, height: 360 }))!) ?? '', /too short/);
});

test('GIF URLs are files; spacers, loaders and optimizer stills are not', () => {
  assert.equal(classifyMedia('https://cdn.studio.example/work/loop.gif?w=1200')?.kind, 'file');
  assert.equal(classifyMedia('https://studio.example/img/spacer.gif'), null);
  assert.equal(classifyMedia('https://studio.example/assets/ajax-loader.gif'), null);
  assert.equal(classifyMedia('https://studio.example/_next/image?url=%2Fwork%2Floop.gif&w=1920&q=75')?.url, 'https://studio.example/work/loop.gif');
  assert.equal(classifyMedia('https://studio.example/_next/image?url=%2Fwork%2Fstill.jpg&w=1920&q=75'), null);
  assert.ok(qualityScore('https://studio.example/up/loop.gif') > qualityScore('https://studio.example/up/loop-720x405.gif'));
  assert.equal(classifyMedia('https://studio.example/up/loop-640x640.gif')?.key, classifyMedia('https://studio.example/up/loop.gif')?.key);
});

test('srcset entries come largest first', () => {
  assert.deepEqual(srcsetUrls('a.gif 300w, b.gif 1200w, c.gif 768w'), ['b.gif', 'c.gif', 'a.gif']);
  assert.deepEqual(srcsetUrls('a.gif, b.gif 2x'), ['b.gif', 'a.gif']);
});

test('finds GIFs in img, srcset, lazy attributes and CSS backgrounds; one per element', () => {
  const page = 'https://studio.example/work/loops';
  const html = `<html><body><h1>Loops</h1>
    <img src="/up/loop-720x405.gif" srcset="/up/loop-300x169.gif 300w, /up/loop.gif 1200w, /up/loop-720x405.gif 720w" alt="Loop">
    <img data-src="https://cdn.studio.example/bounce.gif" src="data:image/gif;base64,R0lGOD">
    <div class="hero" style="background-image: url('/media/wave.gif')"></div>
    <img src="/media/photo.jpg">
  </body></html>`;
  const { candidates } = extractPage(html, page, 'static');
  assert.deepEqual(candidates.map((c) => [c.via, c.url]), [
    ['img-gif', 'https://studio.example/up/loop.gif'],
    ['img-gif', 'https://cdn.studio.example/bounce.gif'],
    ['img-gif', 'https://studio.example/media/wave.gif'],
  ]);
  // The original downloads first; the resized stills are only fallbacks.
  const [loop] = groupItems(candidates);
  assert.equal(loop.urls[0].url, 'https://studio.example/up/loop.gif');
  assert.equal(loop.urls.length, 3);
});

test("a WordPress GIF and its resized copy in separate elements are one item, original first", () => {
  const html = `<html><body><figure><img src="/up/spin-640x640.gif"></figure><a href="/up/spin.gif">Full size</a></body></html>`;
  const { candidates } = extractPage(html, 'https://studio.example/work/spin', 'static');
  const groups = groupItems(candidates);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].urls.map((u) => u.url), ['https://studio.example/up/spin.gif', 'https://studio.example/up/spin-640x640.gif']);
});

test('a GIF file name in alt text is a label, not a link', () => {
  const html = `<html><body><noscript><img src="https://images.squarespace-cdn.example/v1/abc/Logo-animation.gif" alt="Logo-animation.gif" /></noscript>
    <img class="thumb-image" data-src="https://images.squarespace-cdn.example/v1/abc/Logo-animation.gif" alt="Logo-animation.gif" data-image-title="Logo-animation.gif"></body></html>`;
  const { candidates } = extractPage(html, 'https://studio.example/motion', 'static');
  assert.deepEqual(candidates.map((c) => c.url), ['https://images.squarespace-cdn.example/v1/abc/Logo-animation.gif']);
});
