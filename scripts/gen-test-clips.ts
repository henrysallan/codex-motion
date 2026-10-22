// Generates synthetic "reference" clips for the renderer spike: varied
// aspect ratios, frame rates, durations and motion (smooth gradients, moiré,
// noise fields, cellular automata, fractal zooms, eased kinetic shapes and
// type). Every clip carries its label, a frame counter and a progress bar so
// tier switches and loop restarts can be checked by eye.
//
//   node scripts/gen-test-clips.ts [--count 200] [--out media/sources] [--seed 1]
//
// Deterministic for a given seed. Existing outputs are skipped.

import fs from 'node:fs';
import path from 'node:path';
import { arg, assertFfmpeg, defaultConcurrency, ffmpeg, pool } from './lib/ffmpeg.ts';

const count = Number(arg('count', '200'));
const outDir = path.resolve(arg('out', 'media/sources'));
const seed = Number(arg('seed', '1'));

const MONO = '/System/Library/Fonts/SFNSMono.ttf';
const SANS = '/System/Library/Fonts/SFNS.ttf';

function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ctx {
  w: number;
  h: number;
  fps: number;
  dur: number;
  seed: number;
  rnd: () => number;
}

const pick = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const range = (rnd: () => number, lo: number, hi: number) => lo + (hi - lo) * rnd();
const int = (rnd: () => number, lo: number, hi: number) => Math.floor(range(rnd, lo, hi + 1));
const hex = (rnd: () => number) => {
  // Saturated-ish colours: random hue, high chroma.
  const hue = rnd() * 360, s = range(rnd, 0.55, 1), l = range(rnd, 0.35, 0.65);
  const k = (n: number) => (n + hue / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return '0x' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
};

// Each recipe returns a filtergraph fragment ending in [base]. Periods are
// whole divisions of the clip duration, so shape-driven clips loop cleanly.
const recipes: Record<string, (c: Ctx) => string> = {
  gradients: ({ w, h, fps, seed, rnd }) =>
    `gradients=s=${w}x${h}:r=${fps}:c0=${hex(rnd)}:c1=${hex(rnd)}:c2=${hex(rnd)}:c3=${hex(rnd)}` +
    `:n=${int(rnd, 2, 4)}:speed=${range(rnd, 0.004, 0.03).toFixed(4)}` +
    `:type=${pick(rnd, ['linear', 'radial', 'circular', 'spiral', 'square'])}:seed=${seed}[base]`,

  zoneplate: ({ w, h, fps, rnd }) =>
    // Coefficients above ~8 alias into grey noise at 1080p.
    `zoneplate=s=${w}x${h}:r=${fps}:kx2=${int(rnd, 1, 8)}:ky2=${int(rnd, 1, 8)}` +
    `:kt=${int(rnd, 2, 10)}:ku=${int(rnd, 0, 300)}:kv=${int(rnd, 0, 300)}` +
    `:xo=${int(rnd, -w, w) >> 1}:yo=${int(rnd, -h, h) >> 1},hue=h=${int(rnd, 0, 359)}:s=${range(rnd, 1, 2.5).toFixed(2)}[base]`,

  perlin: ({ w, h, fps, seed, rnd }) =>
    `perlin=s=${w >> 2}x${h >> 2}:r=${fps}:octaves=${int(rnd, 3, 6)}:persistence=${range(rnd, 0.45, 0.7).toFixed(2)}` +
    `:xscale=${range(rnd, 1, 4).toFixed(2)}:yscale=${range(rnd, 1, 4).toFixed(2)}:tscale=${range(rnd, 0.3, 2).toFixed(2)}` +
    `:random_mode=seed:random_seed=${seed},scale=${w}:${h}:flags=bicubic,format=yuv444p,` +
    `pseudocolor=p=${pick(rnd, ['magma', 'inferno', 'plasma', 'viridis', 'turbo', 'cool', 'heat', 'fiery', 'helix', 'spectral'])}[base]`,

  life: ({ w, h, fps, seed, rnd }) => {
    const cell = pick(rnd, [6, 8, 12]);
    return (
      `life=s=${Math.round(w / cell)}x${Math.round(h / cell)}:r=${pick(rnd, [fps, Math.round(fps / 2)])}` +
      `:mold=${int(rnd, 5, 40)}:ratio=${range(rnd, 0.08, 0.35).toFixed(2)}:seed=${seed}` +
      `:life_color=${hex(rnd)}:death_color=${hex(rnd)}:mold_color=${hex(rnd)},` +
      `fps=${fps},scale=${w}:${h}:flags=neighbor[base]`
    );
  },

  mandelbrot: ({ w, h, fps, dur, rnd }) =>
    `mandelbrot=s=${w >> 1}x${h >> 1}:r=${fps}:maxiter=${int(rnd, 150, 400)}` +
    `:end_scale=${range(rnd, 0.002, 0.2).toFixed(4)}:end_pts=${Math.round(dur * fps)}:outer=normalized_iteration_count,` +
    `scale=${w}:${h}:flags=bicubic,hue=h=${int(rnd, 0, 359)}[base]`,

  testsrc: ({ w, h, fps, dur }) => `testsrc2=s=${w}x${h}:r=${fps},hue=H=2*PI*t/${dur}[base]`,

  cellauto: ({ w, h, fps, seed, rnd }) => {
    const cell = pick(rnd, [3, 4, 6]);
    const [r, g, b] = [range(rnd, 0.2, 1), range(rnd, 0.2, 1), range(rnd, 0.2, 1)].map((v) => v.toFixed(2));
    return (
      `cellauto=s=${Math.round(w / cell)}x${Math.round(h / cell)}:r=${fps}` +
      `:rule=${pick(rnd, [18, 22, 30, 45, 54, 60, 73, 90, 105, 110, 126, 150])}` +
      `:ratio=${range(rnd, 0.2, 0.6).toFixed(2)}:seed=${seed}:scroll=1:full=1,` +
      `scale=${w}:${h}:flags=neighbor,format=rgb24,colorchannelmixer=rr=${r}:gg=${g}:bb=${b}[base]`
    );
  },

  sierpinski: ({ w, h, fps, seed, rnd }) =>
    `sierpinski=s=${w}x${h}:r=${fps}:type=${pick(rnd, ['carpet', 'triangle'])}:jump=${int(rnd, 1, 8)}:seed=${seed},` +
    `hue=h=${int(rnd, 0, 359)}[base]`,

  // Eased shapes on a flat ground: square-ish waves through tanh give the
  // hold-and-snap feel of keyframed motion graphics.
  shapes: ({ w, h, fps, dur, rnd }) => {
    const n = int(rnd, 3, 6);
    const parts = [`color=c=${hex(rnd)}:s=${w}x${h}:r=${fps}[s0]`];
    for (let i = 0; i < n; i++) {
      const size = Math.round(Math.min(w, h) * range(rnd, 0.08, 0.3));
      const k = int(rnd, 1, 3);
      const sharp = range(rnd, 1, 8).toFixed(1);
      const ph = range(rnd, 0, 6.28).toFixed(2);
      const wave = (axis: 'x' | 'y') =>
        axis === 'x'
          ? `(W-w)*(0.5+0.5*tanh(${sharp}*sin(2*PI*t*${k}/${dur}+${ph}))/tanh(${sharp}))`
          : `(H-h)*(0.5+0.5*tanh(${sharp}*cos(2*PI*t*${k}/${dur}+${ph}))/tanh(${sharp}))`;
      const spin = rnd() < 0.5;
      parts.push(
        spin
          ? `color=c=${hex(rnd)}:s=${size}x${size}:r=${fps},format=rgba,` +
              `rotate=a='2*PI*t*${k}/${dur}':c=none:ow=hypot(iw\\,ih):oh=ow[p${i}]`
          : `color=c=${hex(rnd)}:s=${size}x${Math.round(size * range(rnd, 0.3, 1.5))}:r=${fps}[p${i}]`,
      );
      parts.push(`[s${i}][p${i}]overlay=x='${wave('x')}':y='${wave('y')}':eval=frame[s${i + 1}]`);
    }
    parts.push(`[s${n}]null[base]`);
    return parts.join(';');
  },

  type: ({ w, h, fps, dur, seed, rnd }) => {
    const word = pick(rnd, ['MOTION', 'LOOP', 'EASE', 'KINETIC', 'FRAME', 'TRACE', 'FLOW', 'SNAP', 'DRIFT', 'PULSE']);
    const k = int(rnd, 1, 3);
    const size = Math.round(Math.min(w, h) * range(rnd, 0.16, 0.3));
    return (
      `gradients=s=${w}x${h}:r=${fps}:c0=${hex(rnd)}:c1=${hex(rnd)}:speed=0.01:seed=${seed},` +
      `drawtext=fontfile=${SANS}:text='${word}':fontsize=${size}:fontcolor=white` +
      `:x='(w-text_w)/2+(w/3)*tanh(4*sin(2*PI*t*${k}/${dur}))':y='(h-text_h)/2',` +
      `drawtext=fontfile=${SANS}:text='${word}':fontsize=${Math.round(size / 3)}:fontcolor=black@0.7` +
      `:x='(w-text_w)/2-(w/4)*sin(2*PI*t*${k}/${dur})':y='h*0.75'[base]`
    );
  },
};

const ASPECTS: [number, number][] = [
  [1920, 1080], [1920, 1080], [1920, 1080], [1920, 1080],
  [1080, 1920], [1080, 1920],
  [1080, 1080], [1080, 1080],
  [1080, 1350], [1080, 1350],
  [1920, 804],
];
const FPS = [30, 30, 30, 30, 30, 24, 24, 25, 60, 60];
const DURATIONS = [2.5, 3, 4, 4, 5, 6, 6, 8, 10, 12];

interface Job {
  file: string;
  args: string[];
}

function planClip(i: number): Job {
  const rnd = mulberry32(seed * 100003 + i * 7919);
  const kind = Object.keys(recipes)[i % Object.keys(recipes).length];
  const [w, h] = pick(rnd, ASPECTS);
  const fps = pick(rnd, FPS);
  const dur = pick(rnd, DURATIONS);
  const ctx: Ctx = { w, h, fps, dur, seed: seed * 1000 + i, rnd };
  const label = `#${String(i).padStart(3, '0')} ${kind}`;
  const fs_ = Math.round(Math.min(w, h) / 18);
  const pad = Math.round(fs_ * 0.6);
  const bar = Math.max(6, Math.round(h / 90));
  const graph = [
    recipes[kind](ctx),
    `[base]drawtext=fontfile=${MONO}:text='${label}':x=${pad}:y=${pad}:fontsize=${fs_}:fontcolor=white` +
      `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(pad / 2)},` +
      `drawtext=fontfile=${MONO}:text='%{n}':x=w-text_w-${pad}:y=${pad}:fontsize=${fs_}:fontcolor=white` +
      `:box=1:boxcolor=black@0.55:boxborderw=${Math.round(pad / 2)}[lab]`,
    `color=c=white:s=${w}x${bar}:r=${fps}[bar]`,
    // Tag BT.709 explicitly: L0 is converted by ffmpeg and L1/L2 by the
    // browser, and both must read the same matrix or tier crossfades shift colour.
    `[lab][bar]overlay=x='-w+W*t/${dur}':y=H-h:eval=frame,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[out]`,
  ].join(';');
  const file = path.join(outDir, `clip-${String(i).padStart(3, '0')}-${kind}.mp4`);
  const args = [
    '-filter_complex', graph, '-map', '[out]', '-t', String(dur),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-maxrate', '15M', '-bufsize', '30M',
    '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-g', String(fps * 2), '-movflags', '+faststart', '-an', file,
  ];
  return { file, args };
}

assertFfmpeg();
fs.mkdirSync(outDir, { recursive: true });
const jobs = Array.from({ length: count }, (_, i) => planClip(i)).filter((j) => !fs.existsSync(j.file));
console.log(`generating ${jobs.length} clips into ${path.relative(process.cwd(), outDir)} (${count - jobs.length} already exist)`);
const t0 = performance.now();
let done = 0;
let failed = 0;
await pool(jobs, defaultConcurrency, async (job) => {
  const tmp = job.file.replace(/\.mp4$/, '.part.mp4');
  try {
    await ffmpeg([...job.args.slice(0, -1), tmp]);
    fs.renameSync(tmp, job.file);
  } catch (e) {
    failed++;
    fs.rmSync(tmp, { force: true });
    console.error(`\n${path.basename(job.file)}: ${(e as Error).message}`);
  }
  done++;
  if (process.stdout.isTTY) process.stdout.write(`\r  ${done}/${jobs.length}`);
});
console.log(`\ndone in ${((performance.now() - t0) / 1000).toFixed(1)}s${failed ? `, ${failed} failed` : ''}`);
process.exitCode = failed ? 1 : 0;
