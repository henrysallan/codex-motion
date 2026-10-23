// codex-motion media: serves the content-addressed media library from R2
// and takes uploads from signed-in users.
//
//   GET/HEAD /media/<hash>/<file>      public; immutable, so cached for a year
//   PUT      /media/<hash>/<file>      upload (≤ 95 MB); a no-op if it exists
//   POST     …?uploads                 start a multipart upload (originals)
//   PUT      …?uploadId=…&partNumber=n upload one part
//   POST     …?uploadId=…              complete with { parts }
//   DELETE   …?uploadId=…              abort
//
// Writes need `Authorization: Bearer <token>`: a Supabase access token
// (checked against Supabase Auth) or the admin token the library upload
// script uses. Keys are content hashes, so an existing object is never
// overwritten. CORS is open: reads are public and writes are authorised by
// bearer token, never by cookies.
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

async function authorise(req: Request, env: Env): Promise<string | null> {
  const header = req.headers.get('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
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

// ---- reads ----------------------------------------------------------------------

// For a range that starts past the end. The cache's own 416 lacks CORS headers.
function unsatisfiable(size: number): Response {
  return new Response(null, { status: 416, headers: { ...CORS, 'Content-Range': `bytes */${size}` } });
}

function headersFor(obj: R2Object, key: string): Headers {
  const headers = new Headers(CORS);
  obj.writeHttpMetadata(headers);
  headers.set('Content-Type', contentType(key));
  headers.set('Cache-Control', IMMUTABLE);
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
  // Given a Range, match answers with a 206 cut from the cached whole object.
  const hit = await cache.match(range ? new Request(url, { headers: { Range: range } }) : cacheKey);
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
  if (range && req.method === 'GET' && obj.size <= CACHE_MAX) ctx.waitUntil(fill(env, cacheKey, key));
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
  if (status === 200 && req.method === 'GET') ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// ---- writes ---------------------------------------------------------------------

async function write(req: Request, env: Env, key: string, user: string, url: URL): Promise<Response> {
  const uploadId = url.searchParams.get('uploadId');
  const meta = { httpMetadata: { contentType: contentType(key), cacheControl: IMMUTABLE }, customMetadata: { uploadedBy: user } };

  if (req.method === 'POST' && url.searchParams.has('uploads')) {
    if (await env.MEDIA.head(key)) return json({ exists: true });
    const mpu = await env.MEDIA.createMultipartUpload(key, meta);
    return json({ uploadId: mpu.uploadId });
  }
  if (uploadId) {
    const mpu = env.MEDIA.resumeMultipartUpload(key, uploadId);
    if (req.method === 'PUT') {
      const n = Number(url.searchParams.get('partNumber'));
      if (!Number.isInteger(n) || n < 1 || n > 10000 || !req.body) return error(400, 'bad part');
      return json(await mpu.uploadPart(n, req.body));
    }
    if (req.method === 'POST') {
      const { parts } = (await req.json()) as { parts: R2UploadedPart[] };
      await mpu.complete(parts);
      return json({ ok: true }, 201);
    }
    if (req.method === 'DELETE') {
      await mpu.abort();
      return new Response(null, { status: 204, headers: CORS });
    }
  }
  if (req.method === 'PUT') {
    // Content-addressed: the same key always holds the same bytes.
    if (await env.MEDIA.head(key)) return json({ exists: true });
    const length = Number(req.headers.get('Content-Length') ?? NaN);
    if (!req.body || !(length > 0)) return error(411, 'length required');
    if (length > MAX_PUT) return error(413, 'too large for one request; use a multipart upload');
    await env.MEDIA.put(key, req.body, meta);
    return json({ ok: true }, 201);
  }
  return error(405, 'method not allowed');
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    if (url.pathname === '/') return new Response('codex-motion media\n', { headers: CORS });
    const key = decodeURIComponent(url.pathname.slice(1));
    if (!KEY.test(key)) return error(404, 'not found');
    if (req.method === 'GET' || req.method === 'HEAD') return serve(req, env, ctx, key);
    const user = await authorise(req, env);
    if (!user) return error(401, 'sign in to upload');
    return write(req, env, key, user, url);
  },
} satisfies ExportedHandler<Env>;
