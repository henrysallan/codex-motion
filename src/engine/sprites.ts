// Loads L0 sprite files into the atlas, a few at a time, in the order the
// engine wants them. The engine hands over a fresh list every frame (nearest
// first): every clip on a board, and clips near the viewport of a scrolling
// pane, so a sprite that scrolled out of reach before its turn never loads.
// An evicted sprite comes back the same way, from OPFS.

import { L0_HEADER_BYTES, readL0Header } from '../media/l0format.ts';
import type { Asset } from '../media/library.ts';
import type { SpriteAtlas } from './atlas.ts';
import { loadBytes } from './storage.ts';

const CONCURRENCY = 8;
// Frames to wait before trying again when the atlas has no room at all.
const FULL_RETRY_FRAMES = 30;

async function fetchSprite(url: string) {
  const bytes = new Uint8Array(await loadBytes(url));
  const header = readL0Header(bytes);
  let blocks = bytes.subarray(L0_HEADER_BYTES);
  if (header.compressed) {
    // Write the bytes straight into the stream. Wrapping them in a Blob
    // first costs a synchronous trip to the browser's blob registry per
    // sprite, which took half the worker's time during a fast scroll.
    const inflate = new DecompressionStream('deflate-raw');
    const writer = inflate.writable.getWriter();
    const [out] = await Promise.all([new Response(inflate.readable).arrayBuffer(), writer.write(blocks), writer.close()]);
    blocks = new Uint8Array(out);
  }
  return { header, blocks };
}

export class SpriteLoader {
  readonly failed = new Set<string>();
  private readonly atlas: SpriteAtlas;
  private queue: Asset[] = [];
  private readonly loading = new Set<string>();
  // While the atlas is full of sprites in use, no loads before this clock.
  private retryAt = 0;
  private warnedFull = false;

  constructor(atlas: SpriteAtlas) {
    this.atlas = atlas;
  }

  get pending(): number {
    return this.queue.length + this.loading.size;
  }

  get queued(): boolean {
    return this.queue.length > 0;
  }

  isLoading(assetId: string): boolean {
    return this.loading.has(assetId);
  }

  // Replaces the queue with the sprites wanted now, most wanted first.
  want(assets: Asset[]): void {
    this.queue = assets;
    this.pump();
  }

  private pump(): void {
    if (this.atlas.clock < this.retryAt) return;
    while (this.loading.size < CONCURRENCY && this.queue.length > 0) {
      const asset = this.queue.shift()!;
      if (!asset.l0 || this.loading.has(asset.id) || this.failed.has(asset.id) || this.atlas.get(asset.id)) continue;
      this.loading.add(asset.id);
      fetchSprite(asset.l0.url)
        .then(({ header, blocks }) => {
          if (this.atlas.add(asset.id, header.frameWidth, header.frameHeight, header.frameCount, blocks)) {
            this.warnedFull = false;
            return;
          }
          // Everything resident is in use: wait for the views to move on.
          this.retryAt = this.atlas.clock + FULL_RETRY_FRAMES;
          if (!this.warnedFull) console.warn(`L0 atlas full: ${this.atlas.resident} sprites in use; ${asset.name} and others wait for room`);
          this.warnedFull = true;
        })
        .catch((e: unknown) => {
          this.failed.add(asset.id);
          console.warn(`L0 ${asset.name}:`, e);
        })
        .finally(() => {
          this.loading.delete(asset.id);
          this.pump();
        });
    }
  }
}
