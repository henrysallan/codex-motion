// The M0 gate benchmark: a scripted camera path over the open board while
// the worker records every frame. It holds the full-board overview (every clip
// on screen), pushes into L1 and L2 territory, pans fast enough to exercise
// prefetch and tier switching, and comes back out.
//
// Gate: 200 clips on screen at 60 fps. Judged on the frame intervals while
// the whole board is visible, and reported for the run as a whole.

import type { CameraState, FrameRecord } from '../../engine/protocol.ts';
import { engine } from '../engine.ts';
import { fitRect } from '../camera.ts';
import type { BoardController } from './BoardController.ts';

interface Leg {
  name: string;
  to: CameraState;
  ms: number;
  hold?: boolean;
}

export interface BenchResult {
  legs: { name: string; frames: FrameRecord[] }[];
}

function path(board: BoardController, w: number, h: number): Leg[] {
  const b = board.contentBounds() ?? { x: 0, y: 0, w: 1000, h: 1000 };
  const placements = board.placementList().sort((p, q) => p.y - q.y || p.x - q.x);
  const all = fitRect(b, w, h);
  // A window a quarter of the board wide: clips ~2x their overview size.
  const quarter = (fx: number, fy: number, frac: number) =>
    fitRect({ x: b.x + b.w * fx, y: b.y + b.h * fy, w: b.w * frac, h: b.h * frac }, w, h, 0);
  const clip = placements[Math.floor(placements.length / 2)] ?? b;
  const close = fitRect(clip, w, h, 40);
  return [
    { name: 'overview hold', to: all, ms: 3000, hold: true },
    { name: 'push to L1', to: quarter(0.1, 0.1, 0.3), ms: 2500 },
    { name: 'pan across', to: quarter(0.6, 0.1, 0.3), ms: 3000 },
    { name: 'pan down', to: quarter(0.6, 0.6, 0.3), ms: 2000 },
    { name: 'push to L2', to: close, ms: 2500 },
    { name: 'L2 hold', to: close, ms: 1500, hold: true },
    { name: 'pull out', to: all, ms: 2500 },
    { name: 'fast pans', to: quarter(0.05, 0.5, 0.5), ms: 1200 },
    { name: 'fast pans', to: quarter(0.45, 0.0, 0.5), ms: 1200 },
    { name: 'fast pans', to: quarter(0.5, 0.5, 0.5), ms: 1200 },
    { name: 'overview return', to: all, ms: 1500 },
    { name: 'overview hold', to: all, ms: 3000, hold: true },
  ];
}

// Starts or stops recording; stopping resolves with the recorded frames.
function record(on: boolean): Promise<FrameRecord[]> {
  return new Promise((resolve) => {
    if (on) {
      engine.record(true);
      resolve([]);
      return;
    }
    const off = engine.on((msg) => {
      if (msg.type !== 'record') return;
      off();
      resolve(msg.frames);
    });
    engine.record(false);
  });
}

export async function runBench(board: BoardController): Promise<BenchResult> {
  const { w, h } = board.viewSize;
  const legs = path(board, w, h);
  // Settle at the start position and let sprites and decoders warm up.
  await board.animateTo(legs[0].to, 600);
  await new Promise((r) => setTimeout(r, 1500));

  const result: BenchResult = { legs: [] };
  for (const leg of legs) {
    void record(true);
    if (leg.hold) await new Promise((r) => setTimeout(r, leg.ms));
    else await board.animateTo(leg.to, leg.ms);
    result.legs.push({ name: leg.name, frames: await record(false) });
  }
  return result;
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
};

export interface Summary {
  lines: string[];
  pass: boolean;
}

// 60 fps holds when 95% of frames arrive within one 60 Hz interval and
// under 1% take more than 1.5 of them.
export function summarize(r: BenchResult): Summary {
  const row = (name: string, f: FrameRecord[]) => {
    const dts = f.map((x) => x.dt);
    const mean = dts.reduce((a, b) => a + b, 0) / Math.max(1, dts.length);
    const slow = dts.filter((d) => d > 25).length;
    const cpu = pct(
      f.map((x) => x.cpu),
      0.95,
    );
    const vis = Math.max(0, ...f.map((x) => x.visible));
    const videos = f.reduce((a, x) => a + x.videos, 0);
    const late = videos ? (100 * f.reduce((a, x) => a + x.late, 0)) / videos : 0;
    const dec = Math.max(0, ...f.map((x) => x.decoders));
    return {
      name,
      fps: 1000 / mean,
      p95: pct(dts, 0.95),
      p99: pct(dts, 0.99),
      slowPct: (100 * slow) / Math.max(1, dts.length),
      cpu,
      vis,
      dec,
      late,
      frames: dts.length,
    };
  };
  const rows = r.legs.map((l) => row(l.name, l.frames));
  const total = row('whole run', r.legs.flatMap((l) => l.frames));
  const overview = row('overview holds', r.legs.filter((l) => l.name === 'overview hold').flatMap((l) => l.frames));
  const ok = (x: ReturnType<typeof row>) => x.p95 <= 17.5 && x.slowPct < 1;
  const pass = ok(overview) && overview.vis >= 200;
  const fmt = (x: ReturnType<typeof row>) =>
    `${x.name.padEnd(16)} ${x.fps.toFixed(0).padStart(4)} fps  p95 ${x.p95.toFixed(1).padStart(5)}  p99 ${x.p99.toFixed(1).padStart(5)} ms  ` +
    `>25ms ${x.slowPct.toFixed(1).padStart(4)}%  cpu95 ${x.cpu.toFixed(1).padStart(4)}  clips ${String(x.vis).padStart(3)}  ` +
    `dec ${String(x.dec).padStart(2)}  late ${x.late.toFixed(1).padStart(4)}%`;
  return {
    pass,
    lines: [
      `GATE  ${overview.vis} clips on screen at 60 fps: ${overview.vis < 200 ? 'n/a (open a board with 200+ clips)' : pass ? 'PASS' : 'FAIL'}`,
      '',
      fmt(overview),
      fmt(total),
      '',
      ...rows.map(fmt),
    ],
  };
}
