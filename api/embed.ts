// GET /api/embed?q=<text>: the text's SigLIP 2 embedding, in the space the
// library's image vectors live in (scripts/embed.ts), as 768 little-endian
// float32s. The search worker scores clips against it.
//
// A Vercel Function in production; the Vite dev server serves the same
// handler (vite.config.ts). The text model (~300 MB, int8) downloads once
// per instance into EMBED_CACHE_DIR. Answers are immutable, so the CDN and
// browsers keep each query's vector for good.

import { AutoTokenizer, env, type PreTrainedModel, type PreTrainedTokenizer, SiglipTextModel } from '@huggingface/transformers';

export const MODEL = 'onnx-community/siglip2-base-patch16-224-ONNX';
const MAX_CHARS = 200;

env.cacheDir = process.env.EMBED_CACHE_DIR ?? '/tmp/models';

let loading: Promise<[PreTrainedTokenizer, PreTrainedModel]> | null = null;
const load = () =>
  (loading ??= Promise.all([AutoTokenizer.from_pretrained(MODEL), SiglipTextModel.from_pretrained(MODEL, { dtype: 'q8' })]).catch((e) => {
    loading = null;
    throw e;
  }));

// One inference at a time; onnxruntime already uses every core for one.
let turn: Promise<unknown> = Promise.resolve();

async function embed(text: string): Promise<Float32Array> {
  const [tokenizer, model] = await load();
  const run = turn.then(async () => {
    // SigLIP was trained on text padded to 64 tokens; match that.
    const inputs = tokenizer([text], { padding: 'max_length', max_length: 64, truncation: true });
    const { pooler_output } = await model(inputs);
    const v = Float32Array.from(pooler_output.data as Float32Array);
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  });
  turn = run.catch(() => {});
  return run;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Embed-Model' };

export async function GET(request: Request): Promise<Response> {
  const q = (new URL(request.url).searchParams.get('q') ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
  if (!q) return new Response('missing q', { status: 400, headers: CORS });
  try {
    const v = await embed(q);
    return new Response(v.buffer as ArrayBuffer, {
      headers: {
        ...CORS,
        'Content-Type': 'application/octet-stream',
        'X-Embed-Model': MODEL,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (e) {
    console.error('embed failed', e);
    return new Response('embedding failed', { status: 503, headers: { ...CORS, 'Cache-Control': 'no-store' } });
  }
}
