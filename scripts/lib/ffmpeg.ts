// Small helpers for driving ffmpeg from the offline scripts.
//
// The binary comes from $FFMPEG when set, else `ffmpeg` on PATH. On Apple
// silicon without Rosetta an x86 ffmpeg on PATH fails with "bad CPU type", so
// point FFMPEG at an arm64 build (for example `brew install ffmpeg`).

import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';

export const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';

export function assertFfmpeg(): void {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    const why = r.error?.message ?? r.stderr?.trim() ?? `exit ${r.status}`;
    console.error(`ffmpeg not runnable (${FFMPEG}): ${why}`);
    console.error('Set FFMPEG=/path/to/arm64/ffmpeg or install one with `brew install ffmpeg`.');
    process.exit(1);
  }
}

// Runs ffmpeg to completion. Rejects with the tail of stderr on failure.
export function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim()}`))));
  });
}

// Runs ffmpeg and hands stdout to `onData` as it arrives.
export function ffmpegPipe(args: string[], onData: (chunk: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stdout.on('data', onData);
    p.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim()}`))));
  });
}

// Runs `task` over `items` with at most `limit` in flight.
export async function pool<T>(items: T[], limit: number, task: (item: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      await task(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

export const defaultConcurrency = Math.max(2, Math.floor(os.availableParallelism() / 2));

export function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
