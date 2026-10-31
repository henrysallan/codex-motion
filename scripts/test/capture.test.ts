// Checks for the capture the Chrome extension writes into a saved video
// (src/media/capture.ts): what readCapture keeps of a comment tag, the
// source a dropped clip shows before it's enriched, the prompt
// api/enrich.ts builds from it, and the trip through a real file (the
// helper's ffmpeg write, mediabunny's read). Run with `npm test`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';
import { describeCapture } from '../../api/enrich.ts';
import { CAPTURE_KEY, type Capture, captureSource, publishedOf, readCapture, toCapture } from '../../src/media/capture.ts';
import type { PageMeta } from '../scrape/types.ts';

const record = (patch: Record<string, unknown> = {}) => ({
  [CAPTURE_KEY]: 1,
  url: 'https://www.instagram.com/p/Cabc123/',
  page: { url: 'https://www.instagram.com/p/Cabc123/', title: 'Studio on Instagram', og: { site_name: 'Instagram', title: 'Studio on Instagram: "Wabi for Acme"' }, twitter: {}, meta: {}, jsonLd: [], text: '' },
  context: { text: 'studio · Follow', post: 'studio Wabi, a brand film for @acme. Direction: Ana Lima. Sound: Bo.' },
  embed: { id: 'Cabc123', title: 'Video by studio', description: 'Wabi, a brand film for @acme.', uploader: 'Studio', uploader_id: 'studio', channel: 'studio', timestamp: 1767225600, tags: ['motion'], view_count: 99 },
  slide: { index: 2, count: 3 },
  ...patch,
});

test('a comment tag is a capture only with the marker and a web link', () => {
  assert.ok(readCapture(JSON.stringify(record())));
  assert.equal(readCapture(JSON.stringify({ ...record(), [CAPTURE_KEY]: 2 })), null);
  assert.equal(readCapture(JSON.stringify({ url: 'https://x.example/' })), null);
  assert.equal(readCapture(JSON.stringify(record({ url: 'javascript:alert(1)' }))), null);
  assert.equal(readCapture('Encoded by Handbrake'), null);
  assert.equal(readCapture('{not json'), null);
  assert.equal(readCapture(undefined), null);
});

test('only known fields survive, as the right types and sizes', () => {
  const c = toCapture(record({
    extra: 'dropped',
    page: { url: 'ftp://nope', title: 7, og: { title: 'x'.repeat(5000), n: 3 }, text: 'y'.repeat(50_000), jsonLd: [{ big: 'z'.repeat(30_000) }] },
    context: { heading: ' Wabi ', link: { href: 'javascript:void(0)' }, bogus: true },
    media: { url: 'blob:https://x/1' },
    slide: { index: 5, count: 3 },
  }))!;
  assert.equal('extra' in c, false);
  assert.equal(c.page!.url, c.url, 'a bad page link falls back to the capture link');
  assert.equal(c.page!.title, undefined);
  assert.equal(c.page!.og.title.length, 2000);
  assert.equal('n' in c.page!.og, false);
  assert.equal(c.page!.text.length, 12_000);
  assert.deepEqual(c.page!.jsonLd, []);
  assert.deepEqual(c.context, { heading: 'Wabi' });
  assert.equal(c.media, undefined);
  assert.equal(c.slide, undefined);
  assert.equal('view_count' in c.embed!, false);
});

test('a dropped clip shows what its capture says', () => {
  const s = captureSource(toCapture(record())!, 'Studio - Cabc123 - 2 of 3');
  assert.equal(s.site, 'instagram.com');
  assert.equal(s.siteName, undefined, "a platform isn't the maker");
  assert.equal(s.title, 'Studio on Instagram: "Wabi for Acme"', "'Video by …' isn't a title");
  assert.equal(s.description, 'Wabi, a brand film for @acme.');
  assert.deepEqual(s.creator, { name: 'Studio', handle: 'studio' });
  assert.equal(s.published, '2026-01-01');
  assert.deepEqual(s.tags, ['motion']);

  const studio = captureSource(toCapture({ [CAPTURE_KEY]: 1, url: 'https://www.koto.com/work/wabi', page: { url: 'https://www.koto.com/work/wabi', title: 'Wabi — Koto', og: { site_name: 'Koto' }, meta: { 'article:published_time': '2025-05-04T10:00:00Z' } }, context: { heading: 'Wabi_final_v3' } })!, 'clip');
  assert.equal(studio.site, 'koto.com');
  assert.equal(studio.siteName, 'Koto');
  assert.equal(studio.title, 'Wabi — Koto', 'a file name in the card is skipped');
  assert.equal(studio.published, '2025-05-04');
  assert.equal(publishedOf({ url: 'https://x.example/', embed: { upload_date: '20240229' } }), '2024-02-29');

  // Instagram's uploader_id is a number; YouTube's is the @handle.
  assert.deepEqual(captureSource({ url: 'https://www.instagram.com/p/C1/', embed: { uploader: 'Ana Lima', uploader_id: '1234567', channel: 'ana.lima' } }, 'x').creator, { name: 'Ana Lima', handle: 'ana.lima' });
  assert.deepEqual(captureSource({ url: 'https://www.youtube.com/watch?v=1', embed: { uploader: 'Buck', uploader_id: '@buck', channel: 'Buck Design', channel_url: 'https://www.youtube.com/@buck' } }, 'x').creator, { name: 'Buck', handle: 'buck', url: 'https://www.youtube.com/@buck' });
});

test('the enrich prompt has the post, the player and the slide', () => {
  const c = toCapture(record())!;
  const meta: PageMeta = { ...c.page!, status: 200 };
  const prompt = describeCapture(c, meta);
  assert.match(prompt, /^URL: https:\/\/www\.instagram\.com\/p\/Cabc123\//);
  assert.match(prompt, /nearby text "studio · Follow"/);
  assert.match(prompt, /player title "Video by studio"/);
  assert.match(prompt, /Post text: studio Wabi, a brand film for @acme\. Direction: Ana Lima\./);
  assert.match(prompt, /Player description: Wabi, a brand film/);
  assert.match(prompt, /Posted by: Studio \(@studio\)\n/);
  assert.match(prompt, /slide 2 of 3/);
});

// The helper (Python) writes the tag with ffmpeg; the app reads it with
// mediabunny. Skipped where either tool is missing.
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const has = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const tools = !has(ffmpeg, ['-version']) || !has('python3', ['--version']);
const HOST = path.join(import.meta.dirname, '../../extension/host/motion_host.py');

// Runs Python with the helper loaded as `host`, and the test clip's path,
// the capture and an empty list of what the helper sent in scope.
function withHost(file: string, capture: unknown, code: string): string {
  // -B: no __pycache__ beside the helper.
  return execFileSync('python3', ['-I', '-B', '-c', [
    'import importlib.util, json, os, sys',
    'spec = importlib.util.spec_from_file_location("host", sys.argv[1]); host = importlib.util.module_from_spec(spec); spec.loader.exec_module(host)',
    'file, capture, sent = sys.argv[2], json.loads(sys.argv[3]), []',
    'host.send = sent.append',
    code,
  ].join('\n'), HOST, file, JSON.stringify(capture)], { env: { ...process.env, PATH: `${path.dirname(ffmpeg)}:${process.env.PATH}` } }).toString().trim();
}

async function captureIn(file: string): Promise<Capture | null> {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(file) });
  try {
    return readCapture((await input.getMetadataTags()).comment);
  } finally {
    input.dispose();
  }
}

function clip(dir: string): string {
  const file = path.join(dir, 'clip.mp4');
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
  return file;
}

test('a capture survives the trip through a file', { skip: tools }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-'));
  try {
    const file = clip(dir);
    const sent: Capture & Record<string, unknown> = { ...record(), page: { ...record().page, text: 'Wabi — “quoted” and ünïcödé' } } as never;
    assert.equal(withHost(file, sent, 'print(host.write_capture(file, capture) or "")'), '');
    const c = await captureIn(file);
    assert.ok(c, 'the file carries a capture');
    assert.deepEqual(c, toCapture(sent));
    assert.equal(c.page!.text, 'Wabi — “quoted” and ünïcödé');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// On macOS the helper may not replace a file Chrome saved (it's its own
// process as far as privacy goes): "tag" leaves the copy pending, Chrome
// removes its file, and "commit" moves the copy into its place.
test("a file the helper may not replace is swapped in once Chrome's copy is gone", { skip: tools }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-'));
  try {
    const file = clip(dir);
    const out = JSON.parse(withHost(file, record(), [
      'real = os.replace',
      'def blocked(src, dst):',
      '    if dst == file: raise PermissionError(1, "Operation not permitted")',
      '    real(src, dst)',
      'host.os.replace = blocked',
      'host.cmd_tag({"file": file, "capture": capture})',
      'tagged = sent[-1]',
      'host.cmd_commit({"file": file, "tmp": tagged["pending"]})',
      'early = sent[-1]',
      'os.remove(file)  # what chrome.downloads.removeFile does',
      'host.cmd_commit({"file": file, "tmp": "/etc/hosts"})',
      'wrong = sent[-1]',
      'host.cmd_commit({"file": file, "tmp": tagged["pending"]})',
      'print(json.dumps({"tagged": tagged, "early": early, "wrong": wrong, "done": sent[-1], "left": sorted(os.listdir(os.path.dirname(file)))}))',
    ].join('\n')));
    assert.equal(out.tagged.ok, true);
    assert.equal(out.tagged.pending, path.join(dir, 'clip.tag-tmp.mp4'));
    assert.equal(out.early.ok, false, "nothing moves while Chrome's file is there");
    assert.equal(out.wrong.ok, false, 'only the copy tag left can be committed');
    assert.equal(out.done.ok, true);
    assert.deepEqual(out.left, ['clip.mp4']);
    assert.deepEqual(await captureIn(file), toCapture(record()));

    // Abort drops the copy and leaves the file alone.
    const kept = clip(dir);
    const aborted = JSON.parse(withHost(kept, record(), [
      'tmp, _ = host.tag_copy(file, capture)',
      'host.cmd_abort({"file": file, "tmp": tmp})',
      'print(json.dumps(sorted(os.listdir(os.path.dirname(file)))))',
    ].join('\n')));
    assert.deepEqual(aborted, ['clip.mp4']);
    assert.equal(await captureIn(kept), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
