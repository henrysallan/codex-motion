// Visual embeddings for the library: SigLIP 2 on 8 evenly spaced frames of
// each clip's L1 proxy, run locally (no API, no cost). Text embeds into the
// same space, so "slow liquid chrome loop" finds clips with no tags at all.
//
//   node scripts/embed.ts [--out public/media] [--force]
//   node scripts/embed.ts --query "kinetic type, hard cuts" [--top 12]
//   node scripts/embed.ts --like <asset id> [--top 12]
//
// Per asset: <id>/embedding.f32, one L2-normalized vector per frame (8;
// short clips repeat their last) and then their normalized mean. For search: embeddings.json + embeddings.f32,
// the means of every asset packed in library order. Weights download once
// (~700 MB) into media/models/.

import fs from 'node:fs';
import path from 'node:path';
import { AutoProcessor, AutoTokenizer, env, RawImage, SiglipTextModel, SiglipVisionModel } from '@huggingface/transformers';
import type { EmbeddingIndex, Library } from '../src/media/library.ts';
import { arg, assertFfmpeg, pool } from './lib/ffmpeg.ts';
import { proxyInput, rgbFrames } from './lib/frames.ts';
import { loadEnv } from './lib/claude.ts';

loadEnv();

const EMBED_MODEL = 'onnx-community/siglip2-base-patch16-224-ONNX';
const SIZE = 224;
const FRAMES = 8;

const outRoot = path.resolve(arg('out', 'public/media'));
const publicRoot = path.resolve('public');
const force = process.argv.includes('--force');
const query = arg('query', '');
const like = arg('like', '');
const top = Number(arg('top', '12'));
env.cacheDir = path.resolve('media/models');

const library = JSON.parse(fs.readFileSync(path.join(outRoot, 'library.json'), 'utf8')) as Library;
const indexPath = path.join(outRoot, 'embeddings.json');
const vectorFile = (id: string) => path.join(outRoot, id, 'embedding.f32');

function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

function loadIndex(): { index: EmbeddingIndex; means: Float32Array } {
  if (!fs.existsSync(indexPath)) {
    console.error('no embeddings yet; run `npm run embed` first');
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as EmbeddingIndex;
  const buf = fs.readFileSync(path.join(outRoot, path.basename(index.file)));
  return { index, means: new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4) };
}

function printRanked(index: EmbeddingIndex, means: Float32Array, target: Float32Array, skip?: string): void {
  const byId = new Map(library.assets.map((a) => [a.id, a]));
  const scored = index.ids
    .map((id, i) => ({ id, s: dot(target, means.subarray(i * index.dims, (i + 1) * index.dims)) }))
    .filter((x) => x.id !== skip)
    .sort((a, b) => b.s - a.s)
    .slice(0, top);
  for (const { id, s } of scored) {
    const a = byId.get(id);
    const where = a?.source ? `${a.source.site} ${new URL(a.source.pageUrl).pathname}` : 'library';
    console.log(`${s.toFixed(3)}  ${id}  ${(a?.name ?? '?').slice(0, 60).padEnd(60)}  ${where}`);
  }
}

// ---- search from the command line --------------------------------------------------

if (query || like) {
  const { index, means } = loadIndex();
  if (like) {
    const i = index.ids.findIndex((id) => id.startsWith(like));
    if (i < 0) throw new Error(`no embedding for ${like}`);
    printRanked(index, means, means.slice(i * index.dims, (i + 1) * index.dims), index.ids[i]);
  } else {
    const [tokenizer, text] = await Promise.all([AutoTokenizer.from_pretrained(index.model), SiglipTextModel.from_pretrained(index.model, { dtype: 'q8' })]);
    // SigLIP was trained on text padded to 64 tokens; match that.
    const inputs = tokenizer([query], { padding: 'max_length', max_length: 64, truncation: true });
    const { pooler_output } = await text(inputs);
    console.log(`"${query}"`);
    printRanked(index, means, normalize(pooler_output.data as Float32Array));
  }
  process.exit(0);
}

// ---- embed the library --------------------------------------------------------------

assertFfmpeg();
const todo = library.assets.filter((a) => force || !fs.existsSync(vectorFile(a.id)));
console.log(`embedding ${todo.length} of ${library.assets.length} clips with ${EMBED_MODEL}`);
const t0 = performance.now();
if (todo.length) {
  const [processor, vision] = await Promise.all([AutoProcessor.from_pretrained(EMBED_MODEL), SiglipVisionModel.from_pretrained(EMBED_MODEL, { dtype: 'fp32' })]);
  // ffmpeg extracts frames in parallel; inference runs one clip at a time
  // (onnxruntime already spreads a run across cores).
  let turn = Promise.resolve();
  const infer = (frames: Uint8ClampedArray[]) => {
    const run = turn.then(async () => {
      const { pooler_output } = await vision(await processor(frames.map((f) => new RawImage(f, SIZE, SIZE, 3))));
      return pooler_output.data as Float32Array;
    });
    turn = run.then(() => undefined, () => undefined);
    return run;
  };
  let done = 0;
  let failed = 0;
  await pool(todo, 4, async (asset) => {
    try {
      const frames = await rgbFrames(proxyInput(asset.l1.url), asset, FRAMES, SIZE);
      if (!frames.length) throw new Error('no frames decoded');
      const flat = await infer(frames);
      const width = flat.length / frames.length;
      const vectors = Array.from({ length: FRAMES }, (_, i) => {
        const f = Math.min(i, frames.length - 1);
        return normalize(flat.slice(f * width, (f + 1) * width));
      });
      const dims = width;
      const mean = new Float32Array(dims);
      for (const v of vectors) for (let k = 0; k < dims; k++) mean[k] += v[k];
      const out = new Float32Array(dims * (vectors.length + 1));
      vectors.forEach((v, i) => out.set(v, i * dims));
      out.set(normalize(mean), vectors.length * dims);
      fs.writeFileSync(vectorFile(asset.id), Buffer.from(out.buffer));
    } catch (e) {
      failed++;
      console.error(`\n${asset.id} ${asset.name}: ${(e as Error).message}`);
    }
    done++;
    if (process.stdout.isTTY) process.stdout.write(`\r  ${done}/${todo.length}`);
  });
  console.log(`\n${done - failed} embedded in ${((performance.now() - t0) / 1000).toFixed(0)}s${failed ? `, ${failed} failed` : ''}`);
  process.exitCode = failed ? 1 : 0;
}

// Pack the means of everything embedded, in library order.
const ids: string[] = [];
const means: Float32Array[] = [];
let dims = 0;
for (const a of library.assets) {
  const file = vectorFile(a.id);
  if (!fs.existsSync(file)) continue;
  const buf = fs.readFileSync(file);
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  // FRAMES vectors, then the mean.
  dims ||= all.length / (FRAMES + 1);
  ids.push(a.id);
  means.push(all.slice(all.length - dims));
}
const packed = new Float32Array(ids.length * dims);
means.forEach((m, i) => packed.set(m, i * dims));
fs.writeFileSync(path.join(outRoot, 'embeddings.f32'), Buffer.from(packed.buffer));
const index: EmbeddingIndex = { model: EMBED_MODEL, dims, ids, file: path.relative(publicRoot, path.join(outRoot, 'embeddings.f32')).split(path.sep).join('/') };
fs.writeFileSync(indexPath, JSON.stringify(index));
console.log(`index: ${ids.length} clips, ${(packed.byteLength / 1e6).toFixed(1)} MB`);
