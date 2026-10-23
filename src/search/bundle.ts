// The search index bundle that scripts/search-index.ts builds from the
// library, and the search worker loads. Three files under media/search/:
//
//   manifest.json      points at the current bundle (short cache; replaced)
//   <hash>.json        SearchBundle: per-clip text and facets, page records
//                      shared by every clip on a page
//   <hash>.vec         int8 image vectors, one per doc in `docs` order:
//                      Float32 scales[count], then Int8 data[count * dims]
//
// The two content-hashed files never change, so they cache forever.

export interface SearchManifest {
  version: 1;
  built: string;
  count: number;
  // Storage keys of the bundle and vectors.
  bundle: string;
  vectors: string | null;
  // Embedding model and width; text queries must embed with the same model.
  model: string | null;
  dims: number;
}

export interface SearchPage {
  url: string;
  title?: string;
  description?: string;
  client?: string;
  studios: string[];
  year?: number;
  // The site's own tags, deduped case-insensitively.
  tags: string[];
  projectTypes: string[];
  sectors: string[];
  // Host it was scraped from.
  site: string;
}

export interface SearchDoc {
  id: string;
  title: string;
  // Index into `pages`, or -1.
  page: number;
  caption?: string;
  // Vocabulary and free visual tags ("technique:3d-render", "visual:chrome").
  tags: string[];
  duration: number;
  width: number;
  height: number;
  // Seconds since the epoch it was scraped or added; orders "Newest".
  added: number;
}

export interface SearchBundle {
  version: 1;
  built: string;
  // Display name per site host.
  sites: Record<string, string>;
  pages: SearchPage[];
  docs: SearchDoc[];
}

export interface PackedVectors {
  dims: number;
  // Per-vector dequantisation scale; 0 marks a doc with no vector.
  scales: Float32Array;
  data: Int8Array;
}

export function packVectors(vectors: (Float32Array | null)[], dims: number): Uint8Array<ArrayBuffer> {
  const n = vectors.length;
  const out = new Uint8Array(n * 4 + n * dims);
  const scales = new Float32Array(out.buffer, 0, n);
  const data = new Int8Array(out.buffer, n * 4, n * dims);
  vectors.forEach((v, i) => {
    if (!v) return;
    let max = 0;
    for (const x of v) max = Math.max(max, Math.abs(x));
    if (max === 0) return;
    scales[i] = max / 127;
    for (let k = 0; k < dims; k++) data[i * dims + k] = Math.round((v[k] / max) * 127);
  });
  return out;
}

export function unpackVectors(buf: ArrayBuffer, count: number, dims: number): PackedVectors {
  if (buf.byteLength !== count * 4 + count * dims) throw new Error(`vectors: expected ${count * 4 + count * dims} bytes, got ${buf.byteLength}`);
  return { dims, scales: new Float32Array(buf, 0, count), data: new Int8Array(buf, count * 4, count * dims) };
}
