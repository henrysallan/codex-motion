// The outbox: edits waiting to reach Supabase. Each record keeps only its
// latest version, so a drag that touched a placement many times sends it
// once. Flushes shortly after each edit while signed in; on failure it keeps
// everything and retries with backoff. Last writer wins.

import { create } from 'zustand';
import { type Op, push, type Table } from './remote.ts';
import { getSession, onAuthChange } from './supabase.ts';

const outbox = new Map<string, Op>();
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;
let backoff = 0;

// Sync status for the top bar.
export const useSyncStatus = create<{ pending: number; error: string | null }>(() => ({ pending: 0, error: null }));

function report(error: string | null = useSyncStatus.getState().error): void {
  useSyncStatus.setState({ pending: outbox.size, error });
}

export function enqueue(table: Table, id: string, row: Record<string, unknown> | null): void {
  outbox.set(`${table}:${id}`, { table, id, row });
  report();
  schedule(300);
}

function schedule(delay: number): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, delay);
}

export async function flush(): Promise<void> {
  if (flushing || outbox.size === 0 || !getSession()) return;
  flushing = true;
  const batch = [...outbox.entries()];
  try {
    await push(batch.map(([, op]) => op));
    // Drop what was sent, unless it changed again meanwhile.
    for (const [key, op] of batch) if (outbox.get(key) === op) outbox.delete(key);
    backoff = 0;
    report(null);
  } catch (e) {
    backoff = Math.min(30_000, backoff ? backoff * 2 : 2000);
    console.warn('sync failed, retrying in', backoff, 'ms:', e);
    report(e instanceof Error ? e.message : String(e));
    schedule(backoff);
  } finally {
    flushing = false;
  }
  if (outbox.size) schedule(300);
}

// Sends what's waiting and resolves once nothing is left or in flight, or
// after `ms`: for a step that has to come after every edit made so far.
export async function drain(ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while ((flushing || outbox.size) && Date.now() < until) {
    if (!flushing) await flush();
    if (flushing || outbox.size) await new Promise((done) => setTimeout(done, 100));
  }
}

onAuthChange((session) => {
  if (session && outbox.size) schedule(0);
});

addEventListener('online', () => schedule(0));
