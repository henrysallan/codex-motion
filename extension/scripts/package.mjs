// Zips the extension for a GitHub release: what Load unpacked needs, plus
// the helper and its installer. Writes dist/motion.isthishenry.chrome-<version>.zip
// at the repo root and prints its path.
//
// Run: node extension/scripts/package.mjs [--check-tag ext-v0.3.0]
//
// --check-tag fails unless the tag names the manifest's version, so a
// release can't ship a zip whose manifest says something else.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(EXT, '..');
const NAME = 'motion.isthishenry.chrome';

// Everything else in extension/ (dev/, scripts/) is for working on it.
const FILES = ['manifest.json', 'background.js', 'picker.js', 'providers.js', 'capture.js', 'icons', 'host/install.sh', 'host/motion_host.py', 'README.md'];

const { version } = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));

const tagAt = process.argv.indexOf('--check-tag');
if (tagAt !== -1) {
  const tag = process.argv[tagAt + 1] ?? '';
  if (tag !== `ext-v${version}`) {
    console.error(`tag ${tag || '(none)'} doesn't match the manifest's version ${version}: tag it ext-v${version}, or bump manifest.json`);
    process.exit(1);
  }
}

const out = join(ROOT, 'dist', `${NAME}-${version}.zip`);
mkdirSync(dirname(out), { recursive: true });
rmSync(out, { force: true });
// Inside the zip everything sits under one folder, which is what you pick
// in Load unpacked. zip keeps install.sh executable.
const staging = join(ROOT, 'dist', NAME);
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
for (const f of FILES) {
  mkdirSync(dirname(join(staging, f)), { recursive: true });
  execFileSync('cp', ['-R', join(EXT, f), join(staging, f)]);
}
execFileSync('zip', ['-qr', '-X', out, NAME, '-x', '*.DS_Store'], { cwd: join(ROOT, 'dist') });
rmSync(staging, { recursive: true, force: true });
console.log(out);
