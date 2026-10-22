// Render worker entry. Messages that arrive while the GPU device is still
// being created are queued and replayed in order.

import { Engine } from './engine.ts';
import type { FromWorker, ToWorker } from './protocol.ts';

const post = (msg: FromWorker) => (self as unknown as { postMessage(m: FromWorker): void }).postMessage(msg);

let engine: Engine | null = null;
const pending: ToWorker[] = [];

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  if (msg.type === 'init') {
    Engine.create(msg, post).then(
      (created) => {
        engine = created;
        for (const m of pending.splice(0)) created.handle(m);
      },
      (err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  } else if (engine) {
    engine.handle(msg);
  } else {
    pending.push(msg);
  }
};
