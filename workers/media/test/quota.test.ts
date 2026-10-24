// Checks the media Worker's upload quota against a local R2 bucket, with
// Supabase faked: run with `node --test workers/media/test/*.test.ts`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { transform } from 'esbuild';
import { convertV4MiniflareOptions, Miniflare, Response } from 'miniflare';

const MiB = 1024 * 1024;
const BASE = 'http://media.test';

// upload_allowance: token → hash → bytes reserved (null: an admin).
const reserved: Record<string, Record<string, number | null>> = { alice: {}, bob: {} };

async function supabase(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const token = req.headers.get('Authorization')?.slice('Bearer '.length) ?? '';
  if (!(token in reserved)) return new Response('{}', { status: 401 });
  const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  if (pathname === '/auth/v1/user') return ok({ id: `user-${token}` });
  if (pathname === '/rest/v1/rpc/upload_allowance') {
    const { asset } = (await req.json()) as { asset: string };
    return ok(reserved[token][asset] ?? 0);
  }
  if (pathname === '/rest/v1/rpc/upload_purgeable') return ok(true);
  if (pathname === '/rest/v1/rpc/upload_purged') return new Response('');
  return new Response('not found', { status: 404 });
}

let mf: Miniflare;
let bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;

before(async () => {
  const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' });
  mf = new Miniflare({
    ...convertV4MiniflareOptions({
      modules: true,
      script: code,
      compatibilityDate: '2026-10-01',
      r2Buckets: ['MEDIA'],
      bindings: { SUPABASE_URL: 'http://supabase.test', SUPABASE_ANON_KEY: 'anon' },
      outboundService: supabase as never,
    }),
    logRequests: false,
  });
  bucket = await mf.getR2Bucket('MEDIA');
});
after(() => mf.dispose());

let hashes = 0;
// A fresh asset, with `bytes` reserved on it by alice.
function asset(bytes: number): string {
  const hash = (0xa000 + hashes++).toString(16).padStart(16, '0');
  reserved.alice[hash] = bytes;
  return hash;
}

function send(path: string, init: { method: string; token?: string; body?: Uint8Array | string }) {
  const headers: Record<string, string> = {};
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  return mf.dispatchFetch(`${BASE}/${path}`, { method: init.method, headers, body: init.body });
}

const put = (path: string, bytes: number, token = 'alice') => send(path, { method: 'PUT', token, body: new Uint8Array(bytes) });

async function keys(prefix: string): Promise<{ key: string; size: number }[]> {
  return (await bucket.list({ prefix })).objects.map((o) => ({ key: o.key, size: o.size }));
}

async function startUpload(path: string): Promise<string> {
  const res = await send(`${path}?uploads`, { method: 'POST', token: 'alice' });
  assert.equal(res.status, 200);
  return ((await res.json()) as { uploadId: string }).uploadId;
}

const part = (path: string, id: string, n: number, bytes: number, token = 'alice') =>
  put(`${path}?uploadId=${encodeURIComponent(id)}&partNumber=${n}`, bytes, token);

test('slack is proportional to the reservation', async () => {
  const one = asset(1);
  assert.equal((await put(`media/${one}/original.bin`, 2)).status, 413);
  const small = asset(1000);
  assert.equal((await put(`media/${small}/original.bin`, 1011)).status, 413);
  assert.equal((await put(`media/${small}/original.bin`, 1010)).status, 201);
  // A big reservation keeps the full 1 MiB.
  const big = asset(200 * MiB);
  assert.equal((await put(`media/${big}/l1.mp4`, 80 * MiB)).status, 201);
  assert.equal((await put(`media/${big}/l2.mp4`, 80 * MiB)).status, 201);
  assert.equal((await put(`media/${big}/original.mp4`, 40 * MiB + MiB + 1)).status, 413);
  assert.equal((await put(`media/${big}/original.mp4`, 40 * MiB + MiB)).status, 201);
});

test('parallel PUTs to one asset store no more than it reserved', async () => {
  const hash = asset(100_000);
  const res = await Promise.all('abcdefgh'.split('').map((c) => put(`media/${hash}/original.${c}`, 60_000)));
  const stored = (await keys(`media/${hash}/`)).reduce((sum, o) => sum + o.size, 0);
  assert.ok(stored <= 101_000, `stored ${stored} bytes`);
  assert.equal(stored, 60_000 * res.filter((r) => r.status === 201).length);
  assert.ok(res.some((r) => r.status === 413));
});

test('multipart parts count against the reservation', async () => {
  const hash = asset(12 * MiB);
  const path = `media/${hash}/original.mov`;
  const id = await startUpload(path);
  assert.equal((await part(path, id, 1, 5 * MiB)).status, 200);
  assert.equal((await part(path, id, 2, 5 * MiB)).status, 200);
  assert.equal((await part(path, id, 3, 5 * MiB)).status, 413);
  // Parts of another file of the asset count too.
  const other = `media/${hash}/original.mp4`;
  const otherId = await startUpload(other);
  assert.equal((await part(other, otherId, 1, 5 * MiB)).status, 413);
  assert.equal((await part(other, otherId, 1, 2 * MiB)).status, 200);
  await send(`${other}?uploadId=${encodeURIComponent(otherId)}`, { method: 'DELETE', token: 'alice' });
  assert.equal((await keys(`media/${hash}/parts/original.mp4/`)).length, 0);
  // Someone without a reservation here can't claim space in it.
  assert.equal((await part(path, id, 3, 1, 'bob')).status, 403);
  assert.equal((await keys(`media/${hash}/parts/`)).length, 2);
});

test('a new upload of a file replaces the earlier one', async () => {
  const hash = asset(12 * MiB);
  const path = `media/${hash}/original.mov`;
  const first = await startUpload(path);
  assert.equal((await part(path, first, 1, 5 * MiB)).status, 200);
  assert.equal((await part(path, first, 2, 5 * MiB)).status, 200);
  const second = await startUpload(path);
  assert.equal((await keys(`media/${hash}/parts/`)).length, 0);
  const parts = [];
  for (const n of [1, 2]) {
    const res = await part(path, second, n, 5 * MiB);
    assert.equal(res.status, 200);
    parts.push(await res.json());
  }
  // The first upload is gone, so completing it fails.
  await assert.rejects(async () => {
    const res = await send(`${path}?uploadId=${encodeURIComponent(first)}`, { method: 'POST', token: 'alice', body: JSON.stringify({ parts }) });
    if (!res.ok) throw new Error(String(res.status));
  });
  const done = await send(`${path}?uploadId=${encodeURIComponent(second)}`, { method: 'POST', token: 'alice', body: JSON.stringify({ parts }) });
  assert.equal(done.status, 201);
  assert.deepEqual(await keys(`media/${hash}/`), [{ key: path, size: 10 * MiB }]);
  assert.equal((await put(`media/${hash}/l2.mp4`, 3 * MiB)).status, 413);
  assert.equal((await put(`media/${hash}/l2.mp4`, 2 * MiB)).status, 201);
});

test('deleting an upload takes its unfinished parts too', async () => {
  const hash = asset(12 * MiB);
  assert.equal((await put(`media/${hash}/l1.mp4`, 1000)).status, 201);
  const path = `media/${hash}/original.mov`;
  const id = await startUpload(path);
  assert.equal((await part(path, id, 1, 5 * MiB)).status, 200);
  assert.equal((await send(`media/${hash}/`, { method: 'DELETE', token: 'alice' })).status, 204);
  assert.deepEqual(await keys(`media/${hash}/`), []);
});

test('a malformed path is a 400, and nothing is sniffed', async () => {
  const bad = await send('media/%E0%A4%A', { method: 'GET' });
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get('X-Content-Type-Options'), 'nosniff');
  const hash = asset(100);
  const stored = await put(`media/${hash}/original.html`, 10);
  assert.equal(stored.headers.get('X-Content-Type-Options'), 'nosniff');
  for (let i = 0; i < 2; i++) {
    // The second read comes from the cache.
    const read = await send(`media/${hash}/original.html`, { method: 'GET' });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('Content-Type'), 'application/octet-stream');
    assert.equal(read.headers.get('X-Content-Type-Options'), 'nosniff');
    await read.arrayBuffer();
  }
});
