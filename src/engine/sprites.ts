// Loads L0 sprite files into the atlas, nearest-first, a few at a time.
// L0 is the tier that must always be there, so it loads eagerly for every
// clip on the board as soon as the board opens.

import { L0_HEADER_BYTES, readL0Header } from '../media/l0format.ts';
import type { Asset } from '../media/library.ts';
import type { AtlasEntry, SpriteAtlas } from './atlas.ts';
import { loadBytes } from './storage.ts';

const CONCURRENCY = 8;

async function fetchSprite(url: string) {
  const bytes = new Uint8Array(await loadBytes(url));
  const header = readL0Header(bytes);
  let blocks = bytes.subarray(L0_HEADER_BYTES);
  if (header.compressed) {
    const stream = new Blob([blocks]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    blocks = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return { header, blocks };
}

export class SpriteLoader {
  readonly entries = new Map<string, AtlasEntry>();
  readonly failed = new Set<string>();
  private readonly atlas: SpriteAtlas;
  private queue: Asset[] = [];
  private inFlight = 0;
  private readonly requested = new Set<string>();
  private readonly onLoad: () => void;

  constructor(atlas: SpriteAtlas, onLoad: () => void) {
    this.atlas = atlas;
    this.onLoad = onLoad;
  }

  get pending(): number {
    return this.queue.length + this.inFlight;
  }

  // Queues assets whose sprite isn't loaded yet, in the given (priority)
  // order. Assets without a sprite yet (mid-ingest) are picked up by a later
  // call once they have one.
  request(assets: Asset[]): void {
    for (const a of assets) {
      if (!a.l0 || this.requested.has(a.id)) continue;
      this.requested.add(a.id);
      this.queue.push(a);
    }
    this.pump();
  }

  private pump(): void {
    while (this.inFlight < CONCURRENCY && this.queue.length > 0) {
      const asset = this.queue.shift()!;
      this.inFlight++;
      fetchSprite(asset.l0!.url)
        .then(({ header, blocks }) => {
          const entry = this.atlas.add(header.frameWidth, header.frameHeight, header.frameCount, blocks);
          if (!entry) throw new Error('L0 atlas full');
          this.entries.set(asset.id, entry);
          this.onLoad();
        })
        .catch((e: unknown) => {
          this.failed.add(asset.id);
          console.warn(`L0 ${asset.name}:`, e);
        })
        .finally(() => {
          this.inFlight--;
          this.pump();
        });
    }
  }
}
