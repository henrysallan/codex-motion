// Reads the sample table of an MP4/MOV track from its `moov` box: every
// frame's byte range in the file, presentation time, duration and whether
// it is a keyframe. With that index the render worker can fetch and decode
// the frames around a playhead without reading the rest of the file.
//
// Only the boxes the index needs are parsed; codec configuration is left to
// mediabunny. Fragmented MP4s keep their samples in `moof` boxes instead,
// so they have no index here (null) and are read whole.

export interface SampleTable {
  trackId: number;
  timescale: number;
  // Per sample, in decode order. Times are in timescale units; `pts` is the
  // decode time plus the composition offset.
  offsets: Float64Array;
  sizes: Uint32Array;
  pts: Float64Array;
  durations: Float64Array;
  keys: Uint8Array;
}

export interface Box {
  type: string;
  // Offset of the box and of its payload, and the end of the box.
  start: number;
  body: number;
  end: number;
}

// The box header at `at`, or null when fewer than its header's bytes are
// in `bytes`. `base` is the file offset of bytes[0] and `limit` the end of
// the enclosing box (or the file), for boxes that run to the end.
export function readBox(bytes: Uint8Array, at: number, base = 0, limit = base + bytes.length): Box | null {
  const i = at - base;
  if (i < 0 || i + 8 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = view.getUint32(i);
  const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
  let header = 8;
  if (size === 1) {
    if (i + 16 > bytes.length) return null;
    size = Number(view.getBigUint64(i + 8));
    header = 16;
  } else if (size === 0) {
    size = limit - at;
  }
  if (size < header) throw new Error(`bad ${type} box at ${at}`);
  return { type, start: at, body: at + header, end: at + size };
}

function children(bytes: Uint8Array, parent: Box): Box[] {
  const out: Box[] = [];
  for (let at = parent.body; at + 8 <= parent.end; ) {
    const b = readBox(bytes, at, 0, parent.end);
    if (!b || b.end > parent.end) break;
    out.push(b);
    at = b.end;
  }
  return out;
}

const child = (bytes: Uint8Array, parent: Box | undefined, type: string) => (parent ? children(bytes, parent).find((b) => b.type === type) : undefined);

// The sample table of track `trackId` in `moov`, a buffer holding exactly
// the moov box. Null when the track has no samples in it (fragmented).
export function readSampleTable(moov: Uint8Array, trackId: number): SampleTable | null {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const u32 = (at: number) => view.getUint32(at);
  const root = readBox(moov, 0);
  if (!root || root.type !== 'moov') throw new Error('not a moov box');
  if (child(moov, root, 'mvex')) return null;

  for (const trak of children(moov, root)) {
    if (trak.type !== 'trak') continue;
    const tkhd = child(moov, trak, 'tkhd');
    if (!tkhd) continue;
    const id = moov[tkhd.body] === 1 ? u32(tkhd.body + 20) : u32(tkhd.body + 12);
    if (id !== trackId) continue;

    const mdia = child(moov, trak, 'mdia');
    const mdhd = child(moov, mdia, 'mdhd');
    const stbl = child(moov, child(moov, mdia, 'minf'), 'stbl');
    if (!mdhd || !stbl) throw new Error(`track ${trackId}: no sample table`);
    const timescale = moov[mdhd.body] === 1 ? u32(mdhd.body + 20) : u32(mdhd.body + 12);
    const boxes = new Map(children(moov, stbl).map((b) => [b.type, b]));

    // Sizes.
    let sizes: Uint32Array;
    const stsz = boxes.get('stsz');
    const stz2 = boxes.get('stz2');
    if (stsz) {
      const fixed = u32(stsz.body + 4);
      const n = u32(stsz.body + 8);
      sizes = new Uint32Array(n);
      if (fixed) sizes.fill(fixed);
      else for (let i = 0; i < n; i++) sizes[i] = u32(stsz.body + 12 + 4 * i);
    } else if (stz2) {
      const bits = moov[stz2.body + 7];
      const n = u32(stz2.body + 8);
      sizes = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        const at = stz2.body + 12;
        if (bits === 4) sizes[i] = (moov[at + (i >> 1)] >> (i & 1 ? 0 : 4)) & 15;
        else if (bits === 8) sizes[i] = moov[at + i];
        else sizes[i] = view.getUint16(at + 2 * i);
      }
    } else {
      throw new Error(`track ${trackId}: no sample sizes`);
    }
    const count = sizes.length;
    if (count === 0) return null;

    // Offsets: chunks from stco/co64, samples per chunk from stsc.
    const stco = boxes.get('stco');
    const co64 = boxes.get('co64');
    const chunkCount = stco ? u32(stco.body + 4) : co64 ? u32(co64.body + 4) : 0;
    const chunkOffset = (c: number) => (stco ? u32(stco.body + 8 + 4 * c) : Number(view.getBigUint64(co64!.body + 8 + 8 * c)));
    const stsc = boxes.get('stsc');
    if (!stsc || chunkCount === 0) throw new Error(`track ${trackId}: no chunk table`);
    const runs = u32(stsc.body + 4);
    const offsets = new Float64Array(count);
    let s = 0;
    for (let r = 0; r < runs && s < count; r++) {
      const at = stsc.body + 8 + 12 * r;
      const first = u32(at) - 1;
      const perChunk = u32(at + 4);
      const last = r + 1 < runs ? u32(at + 12) - 1 : chunkCount;
      for (let c = first; c < last && s < count; c++) {
        let offset = chunkOffset(c);
        for (let k = 0; k < perChunk && s < count; k++, s++) {
          offsets[s] = offset;
          offset += sizes[s];
        }
      }
    }
    if (s < count) throw new Error(`track ${trackId}: chunk table covers ${s} of ${count} samples`);

    // Decode times and durations from stts, composition offsets from ctts.
    const stts = boxes.get('stts');
    if (!stts) throw new Error(`track ${trackId}: no time table`);
    const pts = new Float64Array(count);
    const durations = new Float64Array(count);
    let dts = 0;
    s = 0;
    for (let e = 0, n = u32(stts.body + 4); e < n && s < count; e++) {
      const runCount = u32(stts.body + 8 + 8 * e);
      const delta = u32(stts.body + 12 + 8 * e);
      for (let k = 0; k < runCount && s < count; k++, s++) {
        pts[s] = dts;
        durations[s] = delta;
        dts += delta;
      }
    }
    for (; s < count; s++) pts[s] = dts;
    const ctts = boxes.get('ctts');
    if (ctts) {
      s = 0;
      for (let e = 0, n = u32(ctts.body + 4); e < n && s < count; e++) {
        const runCount = u32(ctts.body + 8 + 8 * e);
        // Version 0 offsets are unsigned, but writers put negative ones there too.
        const offset = view.getInt32(ctts.body + 12 + 8 * e);
        for (let k = 0; k < runCount && s < count; k++, s++) pts[s] += offset;
      }
    }

    // Keyframes: listed in stss (1-based), or every sample without one.
    const keys = new Uint8Array(count);
    const stss = boxes.get('stss');
    if (stss) {
      for (let e = 0, n = u32(stss.body + 4); e < n; e++) {
        const i = u32(stss.body + 8 + 4 * e) - 1;
        if (i >= 0 && i < count) keys[i] = 1;
      }
    } else {
      keys.fill(1);
    }

    return { trackId, timescale, offsets, sizes, pts, durations, keys };
  }
  throw new Error(`no track ${trackId}`);
}
