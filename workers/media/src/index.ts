// codex-motion media: serves the content-addressed media library from R2
// and takes uploads from signed-in users.
//
//   GET/HEAD /media/<hash>/<file>      public; immutable, so cached for a year
//   PUT      /media/<hash>/<file>      upload (≤ 95 MB); a no-op if it exists
//   POST     …?uploads                 start a multipart upload (originals)
//   PUT      …?uploadId=…&partNumber=n upload one part
//   POST     …?uploadId=…              complete with { parts }
//   DELETE   …?uploadId=…              abort
//   DELETE   /media/<hash>/             delete all of a deleted upload's files
//
//   GET      /media/search/<hash>.json|.vec   the search index (immutable)
//   GET      /media/search/manifest.json      points at the current index; not
//                                             cached, and the admin token may
//                                             replace it (scripts/search-index.ts)
//
// Writes need `Authorization: Bearer <token>`: a Supabase access token
// (checked against Supabase Auth) or the admin token the library upload
// script uses. Keys are content hashes, so an existing object is never
// overwritten. A user stores no more under media/<hash>/ than the asset's
// row has reserved against their upload quota (supabase/migrations/
// 20261023235500_upload_quota.sql), parts of unfinished multipart uploads
// included; admins have no limit. Only whoever
// deleted an upload can delete its files (20261023235900_delete_uploads.sql).
// CORS is open:
// reads are public and writes are authorised by bearer token, never by
// cookies.
//
// Reads come from the edge cache when they can, ranged ones included: the
// cache cuts a 206 from the whole object, which a range miss copies in.

export interface Env {
  MEDIA: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  ADMIN_TOKEN?: string;
}

const KEY = /^media\/[0-9a-f]{16}\/(l0\.trl0|l1\.mp4|l2\.mp4|original\.[a-z0-9]{1,8})$/;
const PREFIX = /^media\/([0-9a-f]{16})\/$/;
const SEARCH_KEY = /^media\/search\/([0-9a-f]{16}\.(json|vec)|manifest\.json)$/;
const MANIFEST = 'media/search/manifest.json';
const MAX_PUT = 95 * 1024 * 1024;
const IMMUTABLE = 'public, max-age=31536000, immutable';
// The largest object the Workers Cache API stores.
const CACHE_MAX = 512 * 1024 * 1024;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, ETag',
  'Access-Control-Max-Age': '86400',
};

const TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4v: 'video/mp4',
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  trl0: 'application/octet-stream',
  json: 'application/json',
  vec: 'application/octet-stream',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

function contentType(key: string): string {
  return TYPES[key.split('.').pop() ?? ''] ?? 'application/octet-stream';
}

// ---- auth -----------------------------------------------------------------------

// Valid Supabase tokens, so a burst of part uploads checks once.
const verified = new Map<string, { user: string; until: number }>();

async function equal(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = [enc.encode(a), enc.encode(b)];
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

function bearer(req: Request): string | null {
  const header = req.headers.get('Authorization');
  return header?.startsWith('Bearer ') ? header.slice(7) : null;
}

async function authorise(req: Request, env: Env): Promise<string | null> {
  const token = bearer(req);
  if (!token) return null;
  if (env.ADMIN_TOKEN && (await equal(token, env.ADMIN_TOKEN))) return 'admin';
  const hit = verified.get(token);
  if (hit && hit.until > Date.now()) return hit.user;
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!res.ok) return null;
  const user = (await res.json()) as { id?: string };
  if (!user.id) return null;
  verified.set(token, { user: user.id, until: Date.now() + 5 * 60_000 });
  if (verified.size > 1000) verified.clear();
  return user.id;
}

// ---- quota ----------------------------------------------------------------------

// Re-encoding a file can give proxies a few bytes off the ones already
// stored, which an earlier, interrupted upload left. Proportional, so
// reserving a byte on each of many rows buys nothing.
const slack = (allowed: number) => Math.min(1024 * 1024, Math.floor(allowed / 100));

// Calls a Supabase function as the user.
async function rpc<T>(env: Env, token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${body}`);
  // A void function answers with no body.
  return (body ? JSON.parse(body) : null) as T;
}

// Bytes the user may store under media/<hash>/, slack included: null for no
// limit, 0 when they reserved nothing there.
async function limit(env: Env, token: string, hash: string): Promise<number | null> {
  const allowed = await rpc<number | null>(env, token, 'upload_allowance', { asset: hash });
  return allowed ? allowed + slack(allowed) : allowed;
}

async function objects(env: Env, prefix: string): Promise<R2Object[]> {
  const all: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.MEDIA.list({ prefix, cursor, include: ['customMetadata'] });
    all.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return all;
}

// A listing doesn't show the parts of an unfinished multipart upload, so a
// user's part is claimed before it's stored: an empty object under
// media/<hash>/parts/<file>/<upload>/ that counts as the part's size. A claim
// outlives a failed part, as the part sent before it may still be there.
// Completing or aborting the upload drops its claims, and so does starting
// another upload of the same file, which aborts the earlier one.
async function claimsOf(key: string, uploadId?: string): Promise<string> {
  const [, hash, file] = key.split('/');
  const dir = `media/${hash}/parts/${file}/`;
  if (uploadId === undefined) return dir;
  const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(uploadId)));
  return dir + [...sha.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('') + '/';
}

// Aborts the uploads that left these claims and drops the claims. A claim
// goes even if its abort fails, which it does once R2 has dropped an
// abandoned upload itself (after 7 days, by the bucket's lifecycle rule).
async function dropClaims(env: Env, claims: R2Object[]): Promise<void> {
  const uploads = new Map<string, string>();
  for (const c of claims) {
    const [, hash, , file] = c.key.split('/');
    if (c.customMetadata?.uploadId) uploads.set(c.customMetadata.uploadId, `media/${hash}/${file}`);
  }
  await Promise.allSettled([...uploads].map(([id, key]) => env.MEDIA.resumeMultipartUpload(key, id).abort()));
  await remove(env, claims.map((c) => c.key));
}

async function remove(env: Env, keys: string[]): Promise<void> {
  // R2 deletes up to 1000 keys at once.
  for (let i = 0; i < keys.length; i += 1000) await env.MEDIA.delete(keys.slice(i, i + 1000));
}

const stored = async (env: Env, hash: string) =>
  (await objects(env, `media/${hash}/`)).reduce((sum, o) => sum + Number(o.customMetadata?.claim ?? o.size), 0);

// Null when `incoming` more bytes fit under `max`; otherwise the refusal.
// Every write checks again once what it stored shows in a listing, and
// undoes itself if that no longer fits: writes racing each other can all
// pass the first check, but whichever lists last sees the others.
async function overQuota(env: Env, hash: string, max: number | null, incoming: number): Promise<Response | null> {
  if (max === null) return null;
  if (max === 0) return error(403, 'no upload space reserved for this file');
  if ((await stored(env, hash)) + incoming > max) return error(413, 'upload limit: bigger than the space reserved for this file');
  return null;
}

// ---- reads ----------------------------------------------------------------------

// For a range that starts past the end. The cache's own 416 lacks CORS headers.
function unsatisfiable(size: number): Response {
  return new Response(null, { status: 416, headers: { ...CORS, 'Content-Range': `bytes */${size}` } });
}

function headersFor(obj: R2Object, key: string): Headers {
  const headers = new Headers(CORS);
  obj.writeHttpMetadata(headers);
  headers.set('Content-Type', contentType(key));
  // The search manifest changes when the index is rebuilt; everything else is immutable.
  headers.set('Cache-Control', key === MANIFEST ? 'no-cache' : IMMUTABLE);
  headers.set('ETag', obj.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  return headers;
}

// Objects this isolate is copying into the edge cache, so a burst of range
// misses on one file reads it whole from R2 once.
const filling = new Set<string>();

async function fill(env: Env, cacheKey: Request, key: string): Promise<void> {
  if (filling.has(key)) return;
  filling.add(key);
  try {
    const obj = await env.MEDIA.get(key);
    if (!obj) return;
    const headers = headersFor(obj, key);
    headers.set('Content-Length', String(obj.size));
    await caches.default.put(cacheKey, new Response(obj.body, { headers }));
  } finally {
    filling.delete(key);
  }
}

async function serve(req: Request, env: Env, ctx: ExecutionContext, key: string): Promise<Response> {
  const cache = caches.default;
  const url = new URL(req.url).origin + '/' + key;
  const cacheKey = new Request(url);
  const range = req.headers.get('Range');
  const mutable = key === MANIFEST;
  // Given a Range, match answers with a 206 cut from the cached whole object.
  // The manifest never comes from (or goes into) the cache.
  const hit = mutable ? undefined : await cache.match(range ? new Request(url, { headers: { Range: range } }) : cacheKey);
  if (hit?.status === 416) return unsatisfiable(Number(hit.headers.get('Content-Range')?.split('/')[1]));
  if (hit) return req.method === 'HEAD' ? new Response(null, hit) : hit;
  let obj: R2Object | R2ObjectBody | null;
  try {
    obj = await env.MEDIA.get(key, { range: req.headers, onlyIf: req.headers });
  } catch (e) {
    // R2 throws on a range that starts past the end.
    const first = Number(/^bytes=(\d+)-/.exec(range ?? '')?.[1]);
    const size = Number.isFinite(first) ? (await env.MEDIA.head(key))?.size : undefined;
    if (size === undefined || first < size) throw e;
    return unsatisfiable(size);
  }
  if (!obj) return error(404, 'not found');
  if (range && req.method === 'GET' && !mutable && obj.size <= CACHE_MAX) ctx.waitUntil(fill(env, cacheKey, key));
  const headers = headersFor(obj, key);
  if (!('body' in obj)) return new Response(null, { status: 304, headers });
  let status = 200;
  if (range && obj.range) {
    // R2 sets every field of obj.range, leaving the unused ones undefined.
    // Clamp to the object, as R2 does to the body it sends.
    const r = obj.range as { offset?: number; length?: number; suffix?: number };
    const suffix = typeof r.suffix === 'number';
    const start = suffix ? Math.max(0, obj.size - r.suffix!) : (r.offset ?? 0);
    if (start >= obj.size) return unsatisfiable(obj.size);
    const end = !suffix && typeof r.length === 'number' ? Math.min(obj.size, start + r.length) : obj.size;
    headers.set('Content-Range', `bytes ${start}-${end - 1}/${obj.size}`);
    headers.set('Content-Length', String(end - start));
    status = 206;
  } else {
    headers.set('Content-Length', String(obj.size));
  }
  const res = new Response(req.method === 'HEAD' ? null : obj.body, { status, headers });
  if (status === 200 && req.method === 'GET' && !mutable) ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// ---- writes ---------------------------------------------------------------------

// `token` is the user's Supabase token; null for the admin token.
async function write(req: Request, env: Env, key: string, user: string, token: string | null, url: URL): Promise<Response> {
  const uploadId = url.searchParams.get('uploadId');
  const hash = key.split('/')[1];
  const meta = { httpMetadata: { contentType: contentType(key), cacheControl: key === MANIFEST ? 'no-cache' : IMMUTABLE }, customMetadata: { uploadedBy: user } };
  const room = () => (token ? limit(env, token, hash) : Promise.resolve(null));

  if (req.method === 'POST' && url.searchParams.has('uploads')) {
    if (await env.MEDIA.head(key)) return json({ exists: true });
    const max = await room();
    // This upload replaces any earlier one of the file, which an
    // interrupted upload left.
    if (max) await dropClaims(env, await objects(env, await claimsOf(key)));
    // Turn it away if no room is left; completing it checks the real size.
    const refused = await overQuota(env, hash, max, 1);
    if (refused) return refused;
    const mpu = await env.MEDIA.createMultipartUpload(key, meta);
    return json({ uploadId: mpu.uploadId });
  }
  if (uploadId) {
    const mpu = env.MEDIA.resumeMultipartUpload(key, uploadId);
    if (req.method === 'PUT') {
      const n = Number(url.searchParams.get('partNumber'));
      if (!Number.isInteger(n) || n < 1 || n > 10000 || !req.body) return error(400, 'bad part');
      const max = await room();
      if (max === null) return json(await mpu.uploadPart(n, req.body));
      const length = Number(req.headers.get('Content-Length') ?? NaN);
      if (!(length > 0)) return error(411, 'length required');
      const refused = await overQuota(env, hash, max, length);
      if (refused) return refused;
      const claim = `${await claimsOf(key, uploadId)}${n}-${crypto.randomUUID()}`;
      await env.MEDIA.put(claim, null, { customMetadata: { claim: String(length), uploadId } });
      const late = await overQuota(env, hash, max, 0);
      if (late) {
        await env.MEDIA.delete(claim);
        return late;
      }
      return json(await mpu.uploadPart(n, req.body));
    }
    if (req.method === 'POST') {
      const { parts } = (await req.json()) as { parts: R2UploadedPart[] };
      await mpu.complete(parts);
      // The object holds the parts now.
      await remove(env, (await objects(env, await claimsOf(key, uploadId))).map((o) => o.key));
      // Parts don't say how big the whole is, so check what landed.
      const refused = await overQuota(env, hash, await room(), 0);
      if (refused) {
        await env.MEDIA.delete(key);
        return refused;
      }
      return json({ ok: true }, 201);
    }
    if (req.method === 'DELETE') {
      await mpu.abort();
      await remove(env, (await objects(env, await claimsOf(key, uploadId))).map((o) => o.key));
      return new Response(null, { status: 204, headers: CORS });
    }
  }
  if (req.method === 'PUT') {
    // Content-addressed: the same key always holds the same bytes. The
    // search manifest is the one key that gets replaced.
    if (key !== MANIFEST && (await env.MEDIA.head(key))) return json({ exists: true });
    const length = Number(req.headers.get('Content-Length') ?? NaN);
    if (!req.body || !(length > 0)) return error(411, 'length required');
    if (length > MAX_PUT) return error(413, 'too large for one request; use a multipart upload');
    const max = await room();
    const refused = await overQuota(env, hash, max, length);
    if (refused) return refused;
    await env.MEDIA.put(key, req.body, meta);
    const late = await overQuota(env, hash, max, 0);
    if (late) {
      await env.MEDIA.delete(key);
      return late;
    }
    return json({ ok: true }, 201);
  }
  return error(405, 'method not allowed');
}

// Deletes every file of an upload its uploader deleted, and this
// location's cached copies; other locations' copies age out on their own.
async function purge(req: Request, env: Env, hash: string, token: string | null): Promise<Response> {
  if (token && !(await rpc<boolean>(env, token, 'upload_purgeable', { asset: hash }))) return error(403, 'not an upload you deleted');
  const all = await objects(env, `media/${hash}/`);
  // Unfinished uploads go too, though a listing doesn't show their parts.
  await dropClaims(env, all.filter((o) => o.customMetadata?.claim));
  const keys = all.filter((o) => !o.customMetadata?.claim).map((o) => o.key);
  await remove(env, keys);
  const origin = new URL(req.url).origin;
  await Promise.all(keys.map((k) => caches.default.delete(new Request(`${origin}/${k}`))));
  if (token) await rpc(env, token, 'upload_purged', { asset: hash });
  return new Response(null, { status: 204, headers: CORS });
}

async function route(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  if (url.pathname === '/') return new Response('codex-motion media\n', { headers: CORS });
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return error(400, 'bad path');
  }
  const folder = PREFIX.exec(key)?.[1];
  if (folder && req.method === 'DELETE') {
    const user = await authorise(req, env);
    if (!user) return error(401, 'sign in to delete');
    return purge(req, env, folder, user === 'admin' ? null : bearer(req));
  }
  const search = SEARCH_KEY.test(key);
  if (!KEY.test(key) && !search) return error(404, 'not found');
  if (req.method === 'GET' || req.method === 'HEAD') return serve(req, env, ctx, key);
  const user = await authorise(req, env);
  if (!user) return error(401, 'sign in to upload');
  // Only the index builder writes the search index.
  if (search && user !== 'admin') return error(403, 'admin only');
  return write(req, env, key, user, user === 'admin' ? null : bearer(req), url);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Set here rather than with CORS, so cached responses get it too.
    const routed = await route(req, env, ctx);
    const res = new Response(routed.body, routed);
    res.headers.set('X-Content-Type-Options', 'nosniff');
    return res;
  },
} satisfies ExportedHandler<Env>;
