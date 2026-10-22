// The L0 sprite atlas: one 2D-array texture of 2048² layers holding every
// clip's sprite sheet, so all L0 tiles draw in a single instanced call.
//
// Each sheet lays its frames out in a grid as wide as a layer allows, and
// sheets are shelf-packed into layers (heights are multiples of the 128 px
// frame height, so shelves fill well). The array grows by doubling and
// copying; the renderer rebinds when `version` changes.
//
// Format is BC1 when the device supports it, else RGBA8 with frames
// expanded on the CPU (4x the memory, same pixels).

import { bc1ByteLength, decodeBC1 } from '../media/bc1.ts';

export const ATLAS_SIZE = 2048;

export interface AtlasEntry {
  layer: number;
  x: number;
  y: number;
  cols: number;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
}

interface Shelf {
  y: number;
  height: number;
  x: number;
}

export class SpriteAtlas {
  readonly format: GPUTextureFormat;
  texture: GPUTexture;
  layers: number;
  // Bumped whenever `texture` is replaced.
  version = 0;
  bytesUsed = 0;

  private readonly device: GPUDevice;
  private readonly maxLayers: number;
  private shelves: Shelf[][] = [];
  // Next free row per layer, for opening new shelves.
  private top: number[] = [];

  constructor(device: GPUDevice, bc1: boolean, maxLayers: number) {
    this.device = device;
    this.format = bc1 ? 'bc1-rgba-unorm' : 'rgba8unorm';
    this.maxLayers = maxLayers;
    this.layers = 4;
    this.texture = this.create(this.layers);
    for (let i = 0; i < this.layers; i++) this.addLayer();
  }

  get bytesAllocated(): number {
    const perTexel = this.format === 'rgba8unorm' ? 4 : 0.5;
    return ATLAS_SIZE * ATLAS_SIZE * this.layers * perTexel;
  }

  // Reserves space for a sheet and uploads its frames. `blocks` holds
  // frameCount BC1 frames back to back. Returns null when the atlas is full.
  add(frameWidth: number, frameHeight: number, frameCount: number, blocks: Uint8Array): AtlasEntry | null {
    const cols = Math.min(frameCount, Math.floor(ATLAS_SIZE / frameWidth));
    const rows = Math.ceil(frameCount / cols);
    const spot = this.allocate(cols * frameWidth, rows * frameHeight);
    if (!spot) return null;
    const entry: AtlasEntry = { ...spot, cols, frameWidth, frameHeight, frameCount };

    const frameBytes = bc1ByteLength(frameWidth, frameHeight);
    const size = { width: frameWidth, height: frameHeight, depthOrArrayLayers: 1 };
    for (let i = 0; i < frameCount; i++) {
      const origin = { x: entry.x + (i % cols) * frameWidth, y: entry.y + Math.floor(i / cols) * frameHeight, z: entry.layer };
      const frame = blocks.subarray(i * frameBytes, (i + 1) * frameBytes);
      if (this.format === 'rgba8unorm') {
        const rgba = decodeBC1(frame, frameWidth, frameHeight);
        this.device.queue.writeTexture({ texture: this.texture, origin }, rgba, { bytesPerRow: frameWidth * 4 }, size);
      } else {
        // BC1 rows are rows of 4x4 blocks, 8 bytes each.
        this.device.queue.writeTexture({ texture: this.texture, origin }, frame, { bytesPerRow: (frameWidth / 4) * 8 }, size);
      }
    }
    this.bytesUsed += frameCount * frameWidth * frameHeight * (this.format === 'rgba8unorm' ? 4 : 0.5);
    return entry;
  }

  private allocate(width: number, height: number): { layer: number; x: number; y: number } | null {
    for (;;) {
      for (let layer = 0; layer < this.layers; layer++) {
        // An existing shelf of the same height with room left.
        for (const shelf of this.shelves[layer]) {
          if (shelf.height === height && ATLAS_SIZE - shelf.x >= width) {
            const spot = { layer, x: shelf.x, y: shelf.y };
            shelf.x += width;
            return spot;
          }
        }
        // Else open a new shelf on this layer.
        if (ATLAS_SIZE - this.top[layer] >= height) {
          const shelf = { y: this.top[layer], height, x: width };
          this.shelves[layer].push(shelf);
          this.top[layer] += height;
          return { layer, x: 0, y: shelf.y };
        }
      }
      if (!this.grow()) return null;
    }
  }

  private grow(): boolean {
    if (this.layers >= this.maxLayers) return false;
    const layers = Math.min(this.maxLayers, this.layers * 2);
    const next = this.create(layers);
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: this.texture },
      { texture: next },
      { width: ATLAS_SIZE, height: ATLAS_SIZE, depthOrArrayLayers: this.layers },
    );
    this.device.queue.submit([encoder.finish()]);
    this.texture.destroy();
    this.texture = next;
    for (let i = this.layers; i < layers; i++) this.addLayer();
    this.layers = layers;
    this.version++;
    return true;
  }

  private addLayer(): void {
    this.shelves.push([]);
    this.top.push(0);
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
