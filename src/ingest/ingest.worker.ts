// In-browser ingest (spec: "Pipeline per clip"). For each dropped file:
//
//   1. probe and content-hash it, and report back so the main thread can
//      place it (or link to an existing copy) straight away;
//   2. on "build": write the original to OPFS first, so an interrupted
//      build can resume from it on the next open;
//   3. decode once, feeding every frame to the L1 and L2 encoders (H.264,
//      1 s keyframes, through mediabunny) and the L0 sprite sampler;
//   4. write L0, L1 and L2 to OPFS and report their paths.
//
// Videos go through mediabunny; GIFs and stills through ImageDecoder, as
// clips (a still is a one-frame, one-second loop).

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeVideo,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_MEDIUM,
  type Quality,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
} from 'mediabunny';
import { bc1ByteLength, encodeBC1 } from '../media/bc1.ts';
import { L0_MAX_FRAMES, spriteFrameSize, writeL0Header } from '../media/l0format.ts';
import type { SpriteRendition, VideoRendition } from '../media/library.ts';
import type { FromIngest, ProbeResult, ToIngest } from './protocol.ts';

const post = (msg: FromIngest) => (self as unknown as { postMessage(m: FromIngest): void }).postMessage(msg);

interface Job {
  file: File;
  meta: ProbeResult;
}

const jobs = new Map<number, Job>();
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

// ---- OPFS ----------------------------------------------------------------------

async function fileHandle(path: string, create: boolean): Promise<FileSystemFileHandle> {
  const parts = path.split('/');
  let dir = await navigator.storage.getDirectory();
  for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

async function writeFile(path: string, data: Blob | BufferSource): Promise<void> {
  const writable = await (await fileHandle(path, true)).createWritable();
  if (data instanceof Blob) await data.stream().pipeTo(writable);
  else {
    await writable.write(data);
    await writable.close();
  }
}

// ---- probe ---------------------------------------------------------------------

const isImage = (f: File) => f.type.startsWith('image/');

async function hash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function probe(file: File): Promise<ProbeResult> {
  if (isImage(file)) {
    const dec = new ImageDecoder({ data: file.stream(), type: file.type });
    try {
      await dec.tracks.ready;
      const { image } = await dec.decode({ frameIndex: 0 });
      const meta = { kind: 'image' as const, width: image.displayWidth, height: image.displayHeight, duration: 1, fps: 1 };
      image.close();
      return meta;
    } finally {
      dec.close();
    }
  }
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('no video track');
    const [end, start, stats] = await Promise.all([track.computeDuration(), track.getFirstTimestamp(), track.computePacketStats(120)]);
    return { kind: 'video', width: track.displayWidth, height: track.displayHeight, duration: end - start, fps: stats.averagePacketRate };
  } finally {
    input.dispose();
  }
}

// ---- outputs -------------------------------------------------------------------

interface Proxy {
  output: Output<Mp4OutputFormat, BufferTarget>;
  source: VideoSampleSource;
  width: number;
  height: number;
}

async function proxy(meta: ProbeResult, height: number, quality: Quality): Promise<Proxy> {
  const h = even(height);
  const w = even((h * meta.width) / meta.height);
  const codec = (await canEncodeVideo('avc', { width: w, height: h })) ? 'avc' : 'vp9';
  const source = new VideoSampleSource({
    codec,
    quality,
    keyFrameInterval: 1,
    sizeChangeBehavior: 'passThrough',
    transform: { width: w, height: h, fit: 'fill' },
  });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  output.addVideoTrack(source, { frameRate: Math.min(60, Math.max(1, Math.round(meta.fps))) });
  await output.start();
  return { output, source, width: w, height: h };
}

async function finishProxy(p: Proxy, path: string): Promise<VideoRendition> {
  p.source.close();
  await p.output.finalize();
  const bytes = p.output.target.buffer!;
  await writeFile(path, bytes);
  // URLs are storage keys; the same path in OPFS and in cloud storage.
  return { url: path, width: p.width, height: p.height, bytes: bytes.byteLength };
}

// Samples `count` frames evenly over the clip into a BC1 sprite.
class SpriteBuilder {
  private readonly fw: number;
  private readonly fh: number;
  private readonly count: number;
  private readonly duration: number;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly blocks: Uint8Array<ArrayBuffer>;
  private next = 0;

  constructor(width: number, height: number, duration: number, count: number) {
    const size = spriteFrameSize(width, height);
    this.fw = size.width;
    this.fh = size.height;
    this.count = Math.max(1, count);
    this.duration = duration;
    this.ctx = new OffscreenCanvas(this.fw, this.fh).getContext('2d', { willReadFrequently: true })!;
    this.blocks = new Uint8Array(this.count * bc1ByteLength(this.fw, this.fh));
  }

  // Captures `frame` for every sample point it covers ([t, t + dur) in s).
  consider(frame: VideoFrame | VideoSample, t: number, dur: number): void {
    while (this.next < this.count && t + dur > ((this.next + 0.5) * this.duration) / this.count) {
      if (frame instanceof VideoSample) frame.draw(this.ctx, 0, 0, this.fw, this.fh);
      else this.ctx.drawImage(frame, 0, 0, this.fw, this.fh);
      this.capture(this.next++);
    }
  }

  private capture(i: number): void {
    const px = this.ctx.getImageData(0, 0, this.fw, this.fh).data;
    const size = bc1ByteLength(this.fw, this.fh);
    encodeBC1(new Uint8Array(px.buffer, px.byteOffset, px.byteLength), this.fw, this.fh, this.blocks.subarray(i * size, (i + 1) * size));
  }

  async finish(path: string): Promise<SpriteRendition> {
    // Short or irregular clips may leave sample points uncovered: repeat
    // the last captured frame.
    if (this.next === 0) this.capture(this.next++);
    while (this.next < this.count) this.capture(this.next++);
    const compressed = await new Response(new Blob([this.blocks]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
    const header = writeL0Header({ format: 'bc1', compressed: true, frameWidth: this.fw, frameHeight: this.fh, frameCount: this.count });
    const data = new Uint8Array(header.length + compressed.byteLength);
    data.set(header);
    data.set(new Uint8Array(compressed), header.length);
    await writeFile(path, data);
    return { url: path, format: 'bc1', frameWidth: this.fw, frameHeight: this.fh, frameCount: this.count, bytes: data.byteLength };
  }
}

// ---- build ---------------------------------------------------------------------

async function build(jobId: number, id: string, job: Job): Promise<void> {
  const { file, meta } = job;
  const dir = `media/${id}`;
  const ext = (file.name.match(/\.(\w+)$/)?.[1] ?? 'bin').toLowerCase();
  const originalPath = `${dir}/original.${ext}`;
  await writeFile(originalPath, file);
  post({ type: 'original', jobId, url: originalPath, bytes: file.size });

  const l1Height = Math.min(480, meta.height);
  const wantL2 = meta.height >= 600;
  const l1 = await proxy(meta, l1Height, QUALITY_MEDIUM);
  const l2 = wantL2 ? await proxy(meta, Math.min(1080, meta.height), QUALITY_HIGH) : null;
  const outputs = l2 ? [l1, l2] : [l1];
  let duration = meta.duration;
  let sprite: SpriteBuilder;

  if (meta.kind === 'image') {
    const dec = new ImageDecoder({ data: file.stream(), type: file.type });
    await dec.tracks.ready;
    await dec.completed;
    const frames = dec.tracks.selectedTrack?.frameCount ?? 1;
    // Durations first (needed to place sprite samples), then encode.
    const decoded: { image: VideoFrame; t: number; d: number }[] = [];
    let t = 0;
    for (let i = 0; i < frames; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const d = frames === 1 ? 1 : Math.max(0.02, (image.duration ?? 100_000) / 1e6);
      decoded.push({ image, t, d });
      t += d;
    }
    dec.close();
    duration = t;
    sprite = new SpriteBuilder(meta.width, meta.height, duration, Math.min(L0_MAX_FRAMES, frames));
    for (let i = 0; i < decoded.length; i++) {
      const { image, t: ts, d } = decoded[i];
      const sample = new VideoSample(image, { timestamp: ts, duration: d });
      for (const o of outputs) await o.source.add(sample);
      sprite.consider(image, ts, d);
      sample.close();
      image.close();
      post({ type: 'progress', jobId, progress: (i + 1) / decoded.length });
    }
  } else {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
    const track = (await input.getPrimaryVideoTrack())!;
    const start = await track.getFirstTimestamp();
    const total = Math.max(1, Math.round(meta.duration * meta.fps));
    sprite = new SpriteBuilder(meta.width, meta.height, duration, Math.min(L0_MAX_FRAMES, total));
    let n = 0;
    for await (const sample of new VideoSampleSink(track).samples()) {
      const t = sample.timestamp - start;
      sample.setTimestamp(t);
      for (const o of outputs) await o.source.add(sample);
      sprite.consider(sample, t, sample.duration || 1 / meta.fps);
      sample.close();
      if (++n % 15 === 0) post({ type: 'progress', jobId, progress: Math.min(0.99, n / total) });
    }
    input.dispose();
  }

  // Smallest first, as it would sync.
  const l0r = await sprite.finish(`${dir}/l0.trl0`);
  const l1r = await finishProxy(l1, `${dir}/l1.mp4`);
  const l2r = l2 ? await finishProxy(l2, `${dir}/l2.mp4`) : null;
  post({ type: 'done', jobId, duration, l0: l0r, l1: l1r, l2: l2r });
}

self.onmessage = async (e: MessageEvent<ToIngest>) => {
  const msg = e.data;
  try {
    if (msg.type === 'probe') {
      const meta = await probe(msg.file);
      const id = await hash(msg.file);
      jobs.set(msg.jobId, { file: msg.file, meta });
      post({ type: 'identified', jobId: msg.jobId, id, meta });
    } else if (msg.type === 'build') {
      const job = jobs.get(msg.jobId);
      if (!job) return;
      jobs.delete(msg.jobId);
      await build(msg.jobId, msg.id, job);
    } else if (msg.type === 'resume') {
      const file = await (await fileHandle(msg.path, false)).getFile();
      const named = new File([file], msg.name, { type: msg.mime });
      const meta = await probe(named);
      await build(msg.jobId, msg.id, { file: named, meta });
    } else if (msg.type === 'cancel') {
      jobs.delete(msg.jobId);
    }
  } catch (err) {
    post({ type: 'error', jobId: msg.jobId, message: err instanceof Error ? err.message : String(err) });
  }
};
