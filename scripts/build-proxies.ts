// Builds the level-of-detail ladder for every clip in a folder, the way the
// scraper ingest worker will: content-hash, probe, encode L1 and L2 proxies,
// render the L0 sprite, and write public/media/library.json.
//
//   node scripts/build-proxies.ts [--in media/sources] [--out public/media]
//
// Output per asset, keyed by content hash:
//   <id>/l0.trl0   24-frame BC1 sprite, 128 px tall (see src/media/l0format.ts)
//   <id>/l1.mp4    480p H.264
//   <id>/l2.mp4    1080p H.264 (when the source is meaningfully larger than L1)
//   <id>/asset.json
//
// Proxies use a 1 s closed GOP and no B-frames, so a decoder can start at
// any second and output order equals decode order. Assets whose asset.json
// exists are reused, so re-running only processes new files.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ALL_FORMATS, FilePathSource, Input } from 'mediabunny';
import { bc1ByteLength, encodeBC1 } from '../src/media/bc1.ts';
import { L0_MAX_FRAMES, spriteFrameSize, writeL0Header } from '../src/media/l0format.ts';
import type { Asset, Library, VideoRendition } from '../src/media/library.ts';
import { arg, assertFfmpeg, defaultConcurrency, ffmpeg, ffmpegPipe, pool } from './lib/ffmpeg.ts';

const srcDir = path.resolve(arg('in', 'media/sources'));
const outRoot = path.resolve(arg('out', 'public/media'));
const publicRoot = path.resolve('public');

const L1_HEIGHT = 480;
const L2_HEIGHT = 1080;
// Below this source height an L2 would barely improve on L1.
const L2_MIN_SOURCE_HEIGHT = L1_HEIGHT * 1.25;
const MAX_PROXY_FPS = 60;

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
const url = (file: string) => path.relative(publicRoot, file).split(path.sep).join('/');

async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex').slice(0, 16);
}

interface Probe {
  width: number;
  height: number;
  duration: number;
  fps: number;
}

async function probe(file: string): Promise<Probe> {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    const [end, start, stats] = await Promise.all([track.computeDuration(), track.getFirstTimestamp(), track.computePacketStats()]);
    return { width: track.displayWidth, height: track.displayHeight, duration: end - start, fps: stats.averagePacketRate };
  } finally {
    input.dispose();
  }
}

async function encodeProxy(src: string, out: string, info: Probe, height: number, crf: number, maxrateK: number): Promise<VideoRendition> {
  const fps = info.fps > MAX_PROXY_FPS ? info.fps / 2 : info.fps;
  const gop = Math.max(1, Math.round(fps));
  const vf = [`scale=-2:${height}:flags=lanczos`, ...(fps !== info.fps ? [`fps=${fps}`] : []), 'format=yuv420p'].join(',');
  const tmp = out.replace(/(\.\w+)$/, '.part$1');
  await ffmpeg([
    '-i', src, '-vf', vf, '-an',
    '-c:v', 'libx264', '-preset', 'medium', '-profile:v', 'high', '-crf', String(crf),
    '-maxrate', `${maxrateK}k`, '-bufsize', `${maxrateK * 2}k`,
    '-bf', '0', '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
    '-movflags', '+faststart', tmp,
  ]);
  fs.renameSync(tmp, out);
  const p = await probe(out);
  return { url: url(out), width: p.width, height: p.height, bytes: fs.statSync(out).size };
}

async function buildSprite(src: string, out: string, info: Probe): Promise<Asset['l0']> {
  const { width: fw, height: fh } = spriteFrameSize(info.width, info.height);
  const frameBytes = fw * fh * 4;
  // Thin long clips before they reach us; we only keep 24 frames.
  const total = info.duration * info.fps;
  const thin = total > 480 ? [`fps=${(480 / info.duration).toFixed(4)}`] : [];
  const vf = [...thin, `scale=${fw}:${fh}:flags=area:in_color_matrix=auto`, 'format=rgba'].join(',');
  const chunks: Buffer[] = [];
  await ffmpegPipe(['-i', src, '-vf', vf, '-f', 'rawvideo', 'pipe:1'], (c) => chunks.push(c));
  const all = Buffer.concat(chunks);
  const decoded = Math.floor(all.length / frameBytes);
  if (decoded === 0) throw new Error('no frames decoded for L0');

  const frameCount = Math.min(L0_MAX_FRAMES, decoded);
  const blockBytes = bc1ByteLength(fw, fh);
  const payload = new Uint8Array(frameCount * blockBytes);
  for (let i = 0; i < frameCount; i++) {
    const s = Math.floor(((i + 0.5) * decoded) / frameCount);
    encodeBC1(all.subarray(s * frameBytes, (s + 1) * frameBytes), fw, fh, payload.subarray(i * blockBytes, (i + 1) * blockBytes));
  }
  const body = zlib.deflateRawSync(payload, { level: 9 });
  const header = writeL0Header({ format: 'bc1', compressed: true, frameWidth: fw, frameHeight: fh, frameCount });
  fs.writeFileSync(out, Buffer.concat([header, body]));
  return { url: url(out), format: 'bc1', frameWidth: fw, frameHeight: fh, frameCount, bytes: header.length + body.length };
}

async function buildAsset(src: string): Promise<Asset> {
  const id = await hashFile(src);
  const dir = path.join(outRoot, id);
  const manifest = path.join(dir, 'asset.json');
  if (fs.existsSync(manifest)) return JSON.parse(fs.readFileSync(manifest, 'utf8')) as Asset;

  fs.mkdirSync(dir, { recursive: true });
  const info = await probe(src);
  const l1Height = even(Math.min(L1_HEIGHT, info.height));
  const [l0, l1, l2] = await Promise.all([
    buildSprite(src, path.join(dir, 'l0.trl0'), info),
    encodeProxy(src, path.join(dir, 'l1.mp4'), info, l1Height, 23, 2500),
    info.height >= L2_MIN_SOURCE_HEIGHT
      ? encodeProxy(src, path.join(dir, 'l2.mp4'), info, even(Math.min(L2_HEIGHT, info.height)), 23, 8000)
      : Promise.resolve(null),
  ]);
  const asset: Asset = {
    id,
    name: path.basename(src, path.extname(src)),
    duration: Number(info.duration.toFixed(4)),
    width: info.width,
    height: info.height,
    fps: Number(info.fps.toFixed(3)),
    l0,
    l1,
    l2,
  };
  fs.writeFileSync(manifest, JSON.stringify(asset, null, 2));
  return asset;
}

assertFfmpeg();
const sources = fs
  .readdirSync(srcDir)
  .filter((f) => VIDEO_EXTENSIONS.has(path.extname(f).toLowerCase()) && !f.includes('.part.'))
  .sort()
  .map((f) => path.join(srcDir, f));
console.log(`building proxies for ${sources.length} clips from ${path.relative(process.cwd(), srcDir)}`);
fs.mkdirSync(outRoot, { recursive: true });

const t0 = performance.now();
const assets: Asset[] = [];
let done = 0;
let failed = 0;
// Each asset runs three ffmpeg processes at once, so halve the pool.
await pool(sources, Math.max(1, Math.floor(defaultConcurrency / 2)), async (src) => {
  try {
    assets.push(await buildAsset(src));
  } catch (e) {
    failed++;
    console.error(`\n${path.basename(src)}: ${(e as Error).message}`);
  }
  done++;
  if (process.stdout.isTTY) process.stdout.write(`\r  ${done}/${sources.length}`);
});

// Dedupe by content hash; two source files with identical bytes are one asset.
const unique = [...new Map(assets.map((a) => [a.id, a])).values()].sort((a, b) => a.name.localeCompare(b.name));
const library: Library = { version: 1, assets: unique };
fs.writeFileSync(path.join(outRoot, 'library.json'), JSON.stringify(library));

const sum = (f: (a: Asset) => number) => unique.reduce((s, a) => s + f(a), 0);
const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
console.log(`\n${unique.length} assets in ${((performance.now() - t0) / 1000).toFixed(1)}s${failed ? `, ${failed} failed` : ''}`);
console.log(`  L0 ${mb(sum((a) => a.l0?.bytes ?? 0))}  L1 ${mb(sum((a) => a.l1.bytes))}  L2 ${mb(sum((a) => a.l2?.bytes ?? 0))}`);
process.exitCode = failed ? 1 : 0;
