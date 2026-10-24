// Checks for the security headers in vercel.json. Run with `npm test`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

interface VercelConfig {
  headers: { source: string; headers: { key: string; value: string }[] }[];
}

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8')) as VercelConfig;
const all = config.headers.find((h) => h.source === '/(.*)')?.headers ?? [];
const header = (key: string) => all.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
const csp = header('Content-Security-Policy') ?? header('Content-Security-Policy-Report-Only') ?? '';
const directive = (name: string) =>
  csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .find(([n]) => n === name)
    ?.slice(1) ?? [];

test('every route gets the security headers', () => {
  assert.ok(csp, 'a Content-Security-Policy');
  assert.equal(header('X-Content-Type-Options'), 'nosniff');
  assert.equal(header('Referrer-Policy'), 'strict-origin-when-cross-origin');
  assert.deepEqual(directive('frame-ancestors'), ["'none'"]);
  assert.deepEqual(directive('object-src'), ["'none'"]);
});

// index.html's inline theme script runs before first paint, so script-src
// allows it by hash. Editing the script means updating the hash here.
test('script-src allows index.html’s inline scripts by hash, and nothing else inline', () => {
  const html = readFileSync(new URL('index.html', root), 'utf8');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  const src = directive('script-src');
  for (const hash of inline) assert.ok(src.includes(hash), `script-src needs ${hash} for index.html's inline script`);
  assert.deepEqual(
    src.filter((s) => s.startsWith("'sha256-")),
    inline,
    'no stale hashes',
  );
  assert.ok(!src.includes("'unsafe-inline'") && !src.includes("'unsafe-eval'"));
});
