// The L0 sprite atlas: one 2D-array texture of 2048² layers holding clip
// sprite frames, so all L0 tiles draw in a single instanced call.
//
// It is a cache, not a store: CellAllocator (cells.ts) places each frame in
// a fixed cell and evicts the least recently used sprites once the texture
// reaches its budget. Sprites in use (on a board, or near the view in a
// scrolling pane) are never evicted; if they alone outgrow the budget, the
// texture grows past it, up to a hard limit. An evicted sprite reloads from
// OPFS when it is wanted again. The array grows by doubling and copying; the
// renderer rebinds when `version` changes.
//
// Format is BC1 when the device supports it, else RGBA8 with frames
// expanded on the CPU (4x the memory, same pixels).

import { bc1ByteLength, decodeBC1 } from '../media/bc1.ts';
import { ATLAS_SIZE, type AtlasEntry, CellAllocator } from './cells.ts';

export { ATLAS_SIZE, type AtlasEntry } from './cells.ts';

// Texture budget: eviction keeps the atlas within it (256 BC1 layers), and
// only sprites in use can push it to the hard limit.
const SOFT_BUDGET_BYTES = 512 * 1024 * 1024;
const HARD_BUDGET_BYTES = 1024 * 1024 * 1024;
const INITIAL_LAYERS = 4;

export class SpriteAtlas {
  readonly format: GPUTextureFormat;
  texture: GPUTexture;
  // Bumped whenever `texture` is replaced.
  version = 0;

  private readonly device: GPUDevice;
  private readonly cells: CellAllocator;

  constructor(device: GPUDevice, bc1: boolean, maxLayers: number) {
    this.device = device;
    this.format = bc1 ? 'bc1-rgba-unorm' : 'rgba8unorm';
    const layerBytes = ATLAS_SIZE * ATLAS_SIZE * this.bytesPerTexel;
    this.cells = new CellAllocator({
      layers: INITIAL_LAYERS,
      softCap: Math.min(maxLayers, Math.floor(SOFT_BUDGET_BYTES / layerBytes)),
      hardCap: Math.min(maxLayers, Math.max(INITIAL_LAYERS, Math.floor(HARD_BUDGET_BYTES / layerBytes))),
      onGrow: (from, to) => this.grow(from, to),
    });
    this.texture = this.create(INITIAL_LAYERS);
  }

  private get bytesPerTexel(): number {
    return this.format === 'rgba8unorm' ? 4 : 0.5;
  }

  get layers(): number {
    return this.cells.layerCount;
  }

  get layersInUse(): number {
    return this.cells.layersInUse;
  }

  get softCap(): number {
    return this.cells.softCap;
  }

  get resident(): number {
    return this.cells.size;
  }

  get evictions(): number {
    return this.cells.evictions;
  }

  get bytesAllocated(): number {
    return ATLAS_SIZE * ATLAS_SIZE * this.layers * this.bytesPerTexel;
  }

  get bytesUsed(): number {
    return this.cells.texelsUsed * this.bytesPerTexel;
  }

  // The allocator clock; sprites touched at the current value are in use.
  get clock(): number {
    return this.cells.clock;
  }

  // Starts a frame: sprites not touched from here on become evictable.
  tick(): void {
    this.cells.clock++;
  }

  get(key: string): AtlasEntry | undefined {
    return this.cells.get(key);
  }

  // Marks a sprite in use this frame.
  touch(entry: AtlasEntry): void {
    entry.usedAt = this.cells.clock;
  }

  // Finds room for a sprite (evicting idle ones if need be) and uploads its
  // frames. `blocks` holds frameCount BC1 frames back to back. Returns null
  // when everything resident is in use and the atlas is at its hard limit.
  add(key: string, frameWidth: number, frameHeight: number, frameCount: number, blocks: Uint8Array): AtlasEntry | null {
    const entry = this.cells.allocate(key, frameWidth, frameHeight, frameCount);
    if (!entry) return null;
    const frameBytes = bc1ByteLength(frameWidth, frameHeight);
    const size = { width: frameWidth, height: frameHeight, depthOrArrayLayers: 1 };
    entry.frames.forEach((f, i) => {
      const origin = { x: f.x, y: f.y, z: f.layer };
      const frame = blocks.subarray(i * frameBytes, (i + 1) * frameBytes);
      if (this.format === 'rgba8unorm') {
        const rgba = decodeBC1(frame, frameWidth, frameHeight);
        this.device.queue.writeTexture({ texture: this.texture, origin }, rgba, { bytesPerRow: frameWidth * 4 }, size);
      } else {
        // BC1 rows are rows of 4x4 blocks, 8 bytes each.
        this.device.queue.writeTexture({ texture: this.texture, origin }, frame, { bytesPerRow: (frameWidth / 4) * 8 }, size);
      }
    });
    return entry;
  }

  private grow(from: number, to: number): void {
    const next = this.create(to);
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: this.texture },
      { texture: next },
      { width: ATLAS_SIZE, height: ATLAS_SIZE, depthOrArrayLayers: from },
    );
    this.device.queue.submit([encoder.finish()]);
    this.texture.destroy();
    this.texture = next;
    this.version++;
  }

  private create(layers: number): GPUTexture {
    return this.device.createTexture({
      label: 'L0 atlas',
      format: this.format,
      size: { width: ATLAS_SIZE, height: ATLAS_SIZE, depthOrArrayLayers: layers },
      dimension: '2d',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    });
  }
}
