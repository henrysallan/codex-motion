// Draws views. Pipelines, the sampler and the sprite atlas are shared; each
// view gets a ViewTarget with its own buffers and depth texture.
//
// A frame: background, every visible L0 tile in one instanced draw, decoded
// video frames over their tiles, then overlay rects. Stacking uses the
// depth buffer rather than draw order: each item gets a depth from its
// z-order, L0 tiles write it, and video quads test against it (less-equal,
// so a video passes over its own tile but stays under anything stacked
// above). Video quads blend for the tier crossfade.

import type { SpriteAtlas } from './atlas.ts';
import type { RGB } from './protocol.ts';
import { backgroundShader, overlayShader, tileShader, videoShader } from './shaders.ts';

// Floats per tile instance / overlay rect; must match shaders.ts.
export const TILE_FLOATS = 12;
export const OVERLAY_FLOATS = 16;
const VIDEO_SLOT_BYTES = 256;
const VIDEO_FLOATS = 16;
const GLOBALS_FLOATS = 20;

export interface Globals {
  width: number;
  height: number;
  cameraX: number;
  cameraY: number;
  scale: number;
  dpr: number;
  // Device px.
  radius: number;
  grid: number;
  background: RGB;
  gridColor: RGB;
  placeholder: RGB;
}

export interface VideoDraw {
  frame: VideoFrame;
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
  depth: number;
  dim: number;
  crop: [number, number, number, number];
}

// Per-view GPU resources.
export class ViewTarget {
  readonly globals: GPUBuffer;
  readonly globalsData = new Float32Array(GLOBALS_FLOATS);
  tiles: GPUBuffer | null = null;
  tileCapacity = 0;
  overlay: GPUBuffer | null = null;
  overlayCapacity = 0;
  video: GPUBuffer | null = null;
  videoCapacity = 0;
  videoData = new Float32Array(0);
  depth: GPUTexture | null = null;
  tileBindGroup: GPUBindGroup | null = null;
  tileBindKey = '';
  overlayBindGroup: GPUBindGroup | null = null;
  globalsBindGroup: GPUBindGroup;

  constructor(device: GPUDevice, globalsLayout: GPUBindGroupLayout) {
    this.globals = device.createBuffer({ size: GLOBALS_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.globalsBindGroup = device.createBindGroup({ layout: globalsLayout, entries: [{ binding: 0, resource: { buffer: this.globals } }] });
  }

  destroy(): void {
    this.globals.destroy();
    this.tiles?.destroy();
    this.overlay?.destroy();
    this.video?.destroy();
    this.depth?.destroy();
  }
}

export class Renderer {
  private readonly device: GPUDevice;
  private readonly atlas: SpriteAtlas;
  private readonly sampler: GPUSampler;
  private readonly globalsLayout: GPUBindGroupLayout;
  private readonly tileLayout: GPUBindGroupLayout;
  private readonly overlayLayout: GPUBindGroupLayout;
  private readonly videoLayout: GPUBindGroupLayout;
  private readonly backgroundPipeline: GPURenderPipeline;
  private readonly tilePipeline: GPURenderPipeline;
  private readonly videoPipeline: GPURenderPipeline;
  private readonly overlayPipeline: GPURenderPipeline;

  constructor(device: GPUDevice, format: GPUTextureFormat, atlas: SpriteAtlas) {
    this.device = device;
    this.atlas = atlas;
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

    const vf = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    this.globalsLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: vf, buffer: { type: 'uniform' } }],
    });
    this.tileLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: vf, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: vf, texture: { viewDimension: '2d-array' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.overlayLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: vf, buffer: { type: 'uniform' } },
        { binding: 1, visibility: vf, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.videoLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: vf, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: VIDEO_FLOATS * 4 } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });

    const depth = (write: boolean, compare: GPUCompareFunction): GPUDepthStencilState => ({
      format: 'depth24plus',
      depthWriteEnabled: write,
      depthCompare: compare,
    });
    const straight: GPUBlendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const premultiplied: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    };
    const pipeline = (label: string, code: string, layouts: GPUBindGroupLayout[], ds: GPUDepthStencilState, blend?: GPUBlendState) => {
      const module = device.createShaderModule({ label, code });
      return device.createRenderPipeline({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: layouts }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: 'fs', targets: [{ format, blend }] },
        primitive: { topology: label === 'background' ? 'triangle-list' : 'triangle-strip' },
        depthStencil: ds,
      });
    };
    this.backgroundPipeline = pipeline('background', backgroundShader, [this.globalsLayout], depth(false, 'always'));
    this.tilePipeline = pipeline('tiles', tileShader, [this.tileLayout], depth(true, 'less-equal'), straight);
    this.videoPipeline = pipeline('video', videoShader, [this.globalsLayout, this.videoLayout], depth(false, 'less-equal'), straight);
    this.overlayPipeline = pipeline('overlay', overlayShader, [this.overlayLayout], depth(false, 'always'), premultiplied);
  }

  createTarget(): ViewTarget {
    return new ViewTarget(this.device, this.globalsLayout);
  }

  render(
    t: ViewTarget,
    texture: GPUTexture,
    g: Globals,
    tiles: Float32Array,
    tileCount: number,
    videos: VideoDraw[],
    overlay: Float32Array,
    overlayCount: number,
  ): void {
    const device = this.device;
    const gd = t.globalsData;
    gd.set([g.width, g.height, g.cameraX, g.cameraY, g.scale, g.dpr, g.radius, g.grid]);
    gd.set([...g.background, 1, ...g.gridColor, 1, ...g.placeholder, 1], 8);
    device.queue.writeBuffer(t.globals, 0, gd);

    if (tileCount > t.tileCapacity) {
      t.tiles?.destroy();
      t.tileCapacity = Math.max(256, tileCount * 2);
      t.tiles = device.createBuffer({ size: t.tileCapacity * TILE_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    if (tileCount > 0) device.queue.writeBuffer(t.tiles!, 0, tiles, 0, tileCount * TILE_FLOATS);

    if (overlayCount > t.overlayCapacity) {
      t.overlay?.destroy();
      t.overlayCapacity = Math.max(64, overlayCount * 2);
      t.overlay = device.createBuffer({ size: t.overlayCapacity * OVERLAY_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      t.overlayBindGroup = null;
    }
    if (overlayCount > 0) device.queue.writeBuffer(t.overlay!, 0, overlay, 0, overlayCount * OVERLAY_FLOATS);

    if (videos.length > t.videoCapacity) {
      t.video?.destroy();
      t.videoCapacity = Math.max(16, videos.length * 2);
      t.videoData = new Float32Array((t.videoCapacity * VIDEO_SLOT_BYTES) / 4);
      t.video = device.createBuffer({ size: t.videoCapacity * VIDEO_SLOT_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    }
    const stride = VIDEO_SLOT_BYTES / 4;
    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      t.videoData.set([v.x, v.y, v.w, v.h, v.frame.displayWidth, v.frame.displayHeight, v.alpha, v.depth, v.dim, 0, 0, 0, ...v.crop], i * stride);
    }
    if (videos.length > 0) device.queue.writeBuffer(t.video!, 0, t.videoData, 0, videos.length * stride);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), clearValue: [...g.background, 1], loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: {
        view: this.depthView(t, texture.width, texture.height),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    pass.setPipeline(this.backgroundPipeline);
    pass.setBindGroup(0, t.globalsBindGroup);
    pass.draw(3);

    if (tileCount > 0) {
      pass.setPipeline(this.tilePipeline);
      pass.setBindGroup(0, this.tileBindGroup(t));
      pass.draw(4, tileCount);
    }

    if (videos.length > 0) {
      pass.setPipeline(this.videoPipeline);
      pass.setBindGroup(0, t.globalsBindGroup);
      for (let i = 0; i < videos.length; i++) {
        const bindGroup = device.createBindGroup({
          layout: this.videoLayout,
          entries: [
            { binding: 0, resource: { buffer: t.video!, size: VIDEO_FLOATS * 4 } },
            { binding: 1, resource: device.importExternalTexture({ source: videos[i].frame }) },
            { binding: 2, resource: this.sampler },
          ],
        });
        pass.setBindGroup(1, bindGroup, [i * VIDEO_SLOT_BYTES]);
        pass.draw(4);
      }
    }

    if (overlayCount > 0) {
      t.overlayBindGroup ??= device.createBindGroup({
        layout: this.overlayLayout,
        entries: [
          { binding: 0, resource: { buffer: t.globals } },
          { binding: 1, resource: { buffer: t.overlay! } },
        ],
      });
      pass.setPipeline(this.overlayPipeline);
      pass.setBindGroup(0, t.overlayBindGroup);
      pass.draw(4, overlayCount);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  private tileBindGroup(t: ViewTarget): GPUBindGroup {
    const key = `${this.atlas.version}:${t.tileCapacity}`;
    if (!t.tileBindGroup || key !== t.tileBindKey) {
      t.tileBindKey = key;
      t.tileBindGroup = this.device.createBindGroup({
        layout: this.tileLayout,
        entries: [
          { binding: 0, resource: { buffer: t.globals } },
          { binding: 1, resource: { buffer: t.tiles! } },
          { binding: 2, resource: this.atlas.texture.createView({ dimension: '2d-array' }) },
          { binding: 3, resource: this.sampler },
        ],
      });
    }
    return t.tileBindGroup;
  }

  private depthView(t: ViewTarget, width: number, height: number): GPUTextureView {
    if (!t.depth || t.depth.width !== width || t.depth.height !== height) {
      t.depth?.destroy();
      t.depth = this.device.createTexture({ size: { width, height }, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    return t.depth.createView();
  }
}
