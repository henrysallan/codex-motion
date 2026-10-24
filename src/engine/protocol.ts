// Messages between the main thread (document, input, UI) and the render
// worker (GPU device, decoders, scheduler). The main thread owns every
// layout; the worker only draws what it was last told.
//
// The worker draws any number of views (one per pane: the board, the feed
// grid, collection covers), each on its own canvas, all sharing one GPU
// device, one sprite atlas, one board clock and one decoder budget.

import type { Asset } from '../media/library.ts';

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];

// A clip in a view, in world units (CSS px at zoom 1).
export interface ViewItem {
  id: number;
  assetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  // Stacking order; higher draws on top.
  z: number;
  // Source range in seconds; the clip loops [inPoint, outPoint).
  inPoint?: number;
  outPoint?: number;
  // 1 = normal; lower dims the clip toward the background.
  dim?: number;
  // Region of the source frame to show, normalised [u0, v0, u1, v1];
  // collection covers crop to fill their box.
  crop?: [number, number, number, number];
  // Shows only the part inside this rect (world units), its corners rounded
  // by `radius` CSS px: the board frame the clip sits in.
  clip?: ClipRect;
}

export interface ClipRect {
  x: number;
  y: number;
  w: number;
  h: number;
  radius: number;
}

// A filled rect drawn under the clips, stacked with them by z (a board
// frame). World units; stroke width and radius in CSS px.
export interface ViewBackdrop {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  fill: RGBA;
  stroke: RGBA;
  strokeWidth: number;
  radius: number;
}

// How a view keeps sprites resident. A board keeps every clip's L0 sprite
// loaded, so no tile is ever blank. A scrolling pane (the Feed, collection
// covers) may hold thousands of clips; it loads sprites only for clips
// within a couple of viewports of what is visible, and the rest can be
// evicted.
export type ViewKind = 'board' | 'scroll';

// screen = (world - (x, y)) * zoom, in CSS px.
export interface CameraState {
  x: number;
  y: number;
  zoom: number;
}

export interface ViewStyle {
  background: RGB;
  // Dot grid strength; 0 hides it.
  grid: number;
  gridColor: RGB;
  // Tile corner radius in CSS px.
  radius: number;
  placeholder: RGB;
}

// Flat UI drawn over the clips: selection outlines, handles, marquee.
export interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
  // 'world' rects follow the camera; 'screen' rects are in CSS px.
  space: 'world' | 'screen';
  fill: RGBA;
  stroke: RGBA;
  // Stroke width and corner radius in CSS px.
  strokeWidth: number;
  radius: number;
}

export interface EngineSettings {
  // Decoder budget in cost units: an L1 decoder costs 1, an L2 or original
  // costs l2Cost.
  decoderBudget: number;
  l2Cost: number;
  // On-screen height in device px at which a clip asks for L1 / L2.
  l1MinHeight: number;
  l2MinHeight: number;
  // Start decoders for clips just outside a view, in the pan direction.
  prefetch: boolean;
  // Outline each clip in its tier's colour.
  showTiers: boolean;
  // Render rate cap in Hz; 0 renders at the display rate.
  fpsCap: number;
}

export const defaultSettings: EngineSettings = {
  decoderBudget: 24,
  l2Cost: 3,
  l1MinHeight: 192,
  l2MinHeight: 672,
  prefetch: true,
  showTiers: false,
  fpsCap: 0,
};

// Focus mode: one item plays on its own clock at full quality.
export interface FocusState {
  viewId: number;
  itemId: number;
  playing: boolean;
  speed: number;
  // One-shot commands: jump to a source time (s), or step by frames.
  seek?: number;
  step?: number;
}

export type ToWorker =
  | { type: 'init'; settings: EngineSettings }
  | { type: 'assets'; assets: Asset[] }
  | { type: 'view'; id: number; kind: ViewKind; canvas: OffscreenCanvas; width: number; height: number; dpr: number; style: ViewStyle }
  | { type: 'view:remove'; id: number }
  | { type: 'view:resize'; id: number; width: number; height: number; dpr: number }
  | { type: 'view:style'; id: number; style: ViewStyle }
  | { type: 'view:items'; id: number; items: ViewItem[] }
  | { type: 'view:backdrops'; id: number; backdrops: ViewBackdrop[] }
  | { type: 'view:camera'; id: number; camera: CameraState }
  | { type: 'view:overlay'; id: number; rects: OverlayRect[] }
  // Hover scrub: every placement of the asset follows `fraction` of its range.
  | { type: 'scrub'; assetId: string | null; fraction: number }
  | { type: 'pause'; paused: boolean }
  | { type: 'focus'; focus: FocusState | null }
  | { type: 'settings'; settings: Partial<EngineSettings> }
  // Start or stop per-frame recording for a benchmark run.
  | { type: 'record'; on: boolean };

export interface EngineStats {
  fps: number;
  refreshHz: number;
  frameP50: number;
  frameP95: number;
  frameMax: number;
  // Frames that took over 1.5x the refresh interval, in the last window.
  drops: number;
  cpuMs: number;
  visible: number;
  // Visible clips currently showing L0, L1, L2 (an original counts as L2).
  tiers: [number, number, number];
  decoders: number;
  decodersL2: number;
  // Effective decoder budget after overload back-off.
  budget: number;
  streamsWaiting: number;
  // Share of video tiles drawn with a stale frame (decoder behind), last window.
  lateRatio: number;
  failed: number;
  // Clips in views whose sprite is resident, of all clips in views.
  l0Resident: number;
  l0Total: number;
  // Visible clips drawn without their sprite (still loading), last frame.
  l0Missing: number;
  // Sprites in the atlas (including idle ones kept as a cache), sprites
  // waiting to load, and evictions so far.
  l0Cached: number;
  l0Pending: number;
  l0Evictions: number;
  // Atlas texture size, and the part holding frames.
  l0Bytes: number;
  l0BytesUsed: number;
  atlasLayers: number;
  atlasLayersUsed: number;
  // Layers eviction keeps the atlas within.
  atlasCap: number;
  atlasFormat: string;
  boardTime: number;
  paused: boolean;
}

export interface FrameRecord {
  // Frame interval (ms) and worker CPU time for the frame (ms).
  dt: number;
  cpu: number;
  visible: number;
  decoders: number;
  l1: number;
  l2: number;
  // Video tiles drawn this frame, and how many showed a stale frame.
  videos: number;
  late: number;
}

export interface GpuInfo {
  adapter: string;
  atlasFormat: string;
  maxLayers: number;
}

export type FromWorker =
  | { type: 'ready'; info: GpuInfo }
  | { type: 'error'; message: string }
  | { type: 'stats'; stats: EngineStats }
  | { type: 'record'; frames: FrameRecord[] }
  // Focus clock, every frame while focused: source time and range in
  // seconds, the tier on screen and the tier on its way (0 sprite, 1 L1,
  // 2 L2, 3 original).
  | { type: 'focusTime'; time: number; inPoint: number; outPoint: number; tier: number; target: number };
