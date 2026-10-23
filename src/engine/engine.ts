// The render worker's engine: owns the GPU device, the L0 atlas, every
// video decoder and the board clock, and draws each view once per display
// refresh.
//
// Per frame: advance the clocks, place every item of every view on screen
// (in double precision, on the CPU), keep the sprites those items need
// resident, let the scheduler assign tiers within one shared decoder budget,
// start/stop/crossfade video layers to match, then draw each view: one
// instanced call for all L0 tiles, one quad per decoded video frame, then
// overlay rects.
//
// Streams are shared: one decoder per (source, range, clock), however many
// tiles in however many views show it. A tile's video "layers" each point at
// a stream and carry their own crossfade alpha.

import type { Asset } from '../media/library.ts';
import { ATLAS_SIZE, SpriteAtlas } from './atlas.ts';
import { MediaCache } from './demux.ts';
import type {
  CameraState,
  EngineSettings,
  EngineStats,
  FocusState,
  FrameRecord,
  FromWorker,
  OverlayRect,
  RGBA,
  ToWorker,
  ViewItem,
  ViewKind,
  ViewStyle,
} from './protocol.ts';
import { OVERLAY_FLOATS, Renderer, TILE_FLOATS, type VideoDraw, type ViewTarget } from './renderer.ts';
import { plan, type Slot, type Tier } from './scheduler.ts';
import { SpriteLoader } from './sprites.ts';
import { VideoStream } from './stream.ts';

const FADE_MS = 150;
const MEDIA_CACHE_BYTES = 384 * 1024 * 1024;
// Prefetch margin around a view, as a fraction of its size, plus how far
// ahead (seconds) to lead a pan.
const PREFETCH_MARGIN = 0.15;
const PREFETCH_LEAD_S = 0.35;
// A scrolling view keeps sprites resident for items within this many
// viewports of its visible area (boards keep every item's).
const RESIDENT_VIEWPORTS = 2;
const STATS_INTERVAL_MS = 250;
const MAX_RECORD_FRAMES = 60 * 120;
// Streams beyond the budget that may linger while crossfading out.
const TRANSIENT_STREAMS = 8;
// Adaptive budget: decoder limits vary by device and load, and an
// overloaded decoder fails silently (frames arrive late, or a new decoder
// never produces one). Back off multiplicatively when that shows, creep
// back up one unit at a time once clean.
const BUDGET_CHECK_MS = 500;
const BUDGET_RECOVER_MS = 2000;
const BUDGET_MIN = 4;
const LATE_LIMIT = 0.05;
const STUCK_MS = 1500;

const TIER_COLORS: RGBA[] = [
  [0.55, 0.55, 0.55, 0.9],
  [0.25, 0.6, 1, 0.95],
  [1, 0.55, 0.15, 0.95],
  [1, 0.3, 0.6, 0.95],
];

const FULL_FRAME: [number, number, number, number] = [0, 0, 1, 1];

type Init = Extract<ToWorker, { type: 'init' }>;
type Post = (msg: FromWorker) => void;

interface View {
  id: number;
  kind: ViewKind;
  canvas: OffscreenCanvas;
  context: GPUCanvasContext;
  target: ViewTarget;
  width: number;
  height: number;
  dpr: number;
  style: ViewStyle;
  camera: CameraState;
  items: Item[];
  byId: Map<number, Item>;
  overlay: OverlayRect[];
  // Pan velocity in device px/s, for leading the prefetch margin.
  velocity: { x: number; y: number };
  lastCameraAt: number;
}

interface Layer {
  tier: Tier;
  key: string;
  alpha: number;
  wanted: boolean;
  createdAt: number;
}

interface Item {
  view: View;
  data: ViewItem;
  asset: Asset;
  slot: Slot;
  depth: number;
  // Source range in µs; the loop is rangeOut - rangeIn.
  rangeIn: number;
  rangeOut: number;
  assigned: Tier;
  layers: Layer[];
}

interface StreamEntry {
  stream: VideoStream;
  assetId: string;
  tier: Tier;
  loopUs: number;
  focus: boolean;
}

export class Engine {
  static async create(init: Init, post: Post): Promise<Engine> {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    if (typeof VideoDecoder === 'undefined') throw new Error('WebCodecs VideoDecoder is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter.');
    const bc = adapter.features.has('texture-compression-bc');
    const maxLayers = Math.min(adapter.limits.maxTextureArrayLayers, 512);
    const device = await adapter.requestDevice({
      requiredFeatures: bc ? ['texture-compression-bc'] : [],
      requiredLimits: { maxTextureArrayLayers: maxLayers },
    });
    device.lost.then((info) => post({ type: 'error', message: `GPU device lost: ${info.message}` }));
    device.addEventListener('uncapturederror', (e) => console.error('WebGPU:', (e as GPUUncapturedErrorEvent).error.message));

    const engine = new Engine(init, post, device, bc, maxLayers);
    const info = adapter.info;
    post({
      type: 'ready',
      info: {
        adapter: [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'unknown',
        atlasFormat: engine.atlas.format,
        maxLayers,
      },
    });
    return engine;
  }

  private readonly post: Post;
  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  private readonly renderer: Renderer;
  private readonly atlas: SpriteAtlas;
  private readonly sprites: SpriteLoader;
  private readonly cache = new MediaCache(MEDIA_CACHE_BYTES);
  private readonly assets = new Map<string, Asset>();
  private readonly views = new Map<number, View>();

  private settings: EngineSettings;
  private paused = false;
  private boardTimeMs = 0;
  private scrub: { assetId: string; fraction: number } | null = null;
  private focus: FocusState | null = null;
  // Focus clock, virtual µs on the focused item's loop.
  private focusTimeUs = 0;

  private readonly streams = new Map<string, StreamEntry>();
  // Lowest tier that failed to decode, per asset.
  private readonly blocked = new Map<string, Tier>();
  private failures = 0;
  private readonly assignment = new Map<Slot, Tier>();
  private tileData = new Float32Array(TILE_FLOATS * 256);
  private overlayData = new Float32Array(OVERLAY_FLOATS * 64);
  private readonly videos: VideoDraw[] = [];

  private budget: number;
  private budgetCheckAt = 0;
  private cleanSince = 0;

  private lastTick = 0;
  private readonly intervals: number[] = [];
  private readonly cpuTimes: number[] = [];
  private readonly lateWindow: [number, number][] = [];
  private lastStatsAt = 0;
  // Visible items drawn without their sprite, last frame.
  private missingSprites = 0;
  private recording: FrameRecord[] | null = null;
  private shownTiers: [number, number, number] = [0, 0, 0];
  private videoDraws = 0;
  private lateDraws = 0;

  private constructor(init: Init, post: Post, device: GPUDevice, bc: boolean, maxLayers: number) {
    this.post = post;
    this.device = device;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.settings = { ...init.settings };
    this.budget = this.settings.decoderBudget;
    this.atlas = new SpriteAtlas(device, bc, maxLayers);
    this.renderer = new Renderer(device, this.format, this.atlas);
    this.sprites = new SpriteLoader(this.atlas);
    requestAnimationFrame(this.tick);
  }

  handle(msg: ToWorker): void {
    switch (msg.type) {
      case 'assets':
        this.setAssets(msg.assets);
        break;
      case 'view':
        this.addView(msg);
        break;
      case 'view:remove':
        this.removeView(msg.id);
        break;
      case 'view:resize': {
        const v = this.views.get(msg.id);
        if (!v) break;
        v.width = msg.width;
        v.height = msg.height;
        v.dpr = msg.dpr;
        v.canvas.width = msg.width;
        v.canvas.height = msg.height;
        break;
      }
      case 'view:style': {
        const v = this.views.get(msg.id);
        if (v) v.style = msg.style;
        break;
      }
      case 'view:items': {
        const v = this.views.get(msg.id);
        if (v) this.setItems(v, msg.items);
        break;
      }
      case 'view:camera': {
        const v = this.views.get(msg.id);
        if (v) this.setCamera(v, msg.camera);
        break;
      }
      case 'view:overlay': {
        const v = this.views.get(msg.id);
        if (v) v.overlay = msg.rects;
        break;
      }
      case 'scrub':
        this.scrub = msg.assetId === null ? null : { assetId: msg.assetId, fraction: Math.min(0.9999, Math.max(0, msg.fraction)) };
        break;
      case 'pause':
        this.paused = msg.paused;
        break;
      case 'focus':
        this.setFocus(msg.focus);
        break;
      case 'settings':
        this.settings = { ...this.settings, ...msg.settings };
        if (msg.settings.decoderBudget !== undefined) this.budget = msg.settings.decoderBudget;
        break;
      case 'record':
        if (msg.on) this.recording = [];
        else if (this.recording) {
          this.post({ type: 'record', frames: this.recording });
          this.recording = null;
        }
        break;
      case 'init':
        break;
    }
  }

  // ---- scene ---------------------------------------------------------------

  private addView(msg: Extract<ToWorker, { type: 'view' }>): void {
    const context = msg.canvas.getContext('webgpu');
    if (!context) {
      this.post({ type: 'error', message: 'Could not create a WebGPU canvas context.' });
      return;
    }
    context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });
    msg.canvas.width = msg.width;
    msg.canvas.height = msg.height;
    this.views.set(msg.id, {
      id: msg.id,
      kind: msg.kind,
      canvas: msg.canvas,
      context,
      target: this.renderer.createTarget(),
      width: msg.width,
      height: msg.height,
      dpr: msg.dpr,
      style: msg.style,
      camera: { x: 0, y: 0, zoom: 1 },
      items: [],
      byId: new Map(),
      overlay: [],
      velocity: { x: 0, y: 0 },
      lastCameraAt: 0,
    });
  }

  private removeView(id: number): void {
    const v = this.views.get(id);
    if (!v) return;
    this.views.delete(id);
    v.target.destroy();
    v.context.unconfigure();
    // Streams no tile uses any more are closed on the next frame.
  }

  private setAssets(assets: Asset[]): void {
    for (const a of assets) {
      // New renditions (an upload's proxies replacing its original) get a
      // fresh chance at every tier.
      const prev = this.assets.get(a.id);
      if (prev && (prev.l1.url !== a.l1.url || prev.l2?.url !== a.l2?.url || prev.original?.url !== a.original?.url)) this.blocked.delete(a.id);
      this.assets.set(a.id, a);
    }
    for (const v of this.views.values()) {
      for (const it of v.items) {
        const a = this.assets.get(it.asset.id);
        if (a && a !== it.asset) {
          it.asset = a;
          this.refreshItem(it);
        }
      }
    }
  }

  private setItems(view: View, items: ViewItem[]): void {
    const order = [...items].sort((a, b) => a.z - b.z);
    const rank = new Map(order.map((p, i) => [p.id, i]));
    const n = Math.max(1, items.length - 1);
    const next: Item[] = [];
    const byId = new Map<number, Item>();
    for (const data of items) {
      const asset = this.assets.get(data.assetId);
      if (!asset) continue;
      // Higher z, smaller depth: nearer.
      const depth = 0.9 - (0.8 * rank.get(data.id)!) / n;
      let it = view.byId.get(data.id);
      if (it) {
        it.data = data;
        it.asset = asset;
        it.depth = depth;
      } else {
        it = {
          view,
          data,
          asset,
          depth,
          slot: {
            x: 0, y: 0, w: 0, h: 0,
            visible: false, nearby: false, visibleArea: 0,
            keys: [null, null, null],
            current: 0, blocked: null, focused: false, needsVideo: false,
          },
          rangeIn: 0,
          rangeOut: 0,
          assigned: 0,
          layers: [],
        };
      }
      this.refreshItem(it);
      next.push(it);
      byId.set(data.id, it);
    }
    view.items = next;
    view.byId = byId;
  }

  // Recomputes an item's range and stream keys after its data, asset or
  // focus changed. Layers on old keys crossfade out on their own.
  private refreshItem(it: Item): void {
    const d = it.asset.duration * 1e6;
    const inUs = Math.max(0, Math.min(d - 1000, (it.data.inPoint ?? 0) * 1e6));
    const outUs = it.data.outPoint !== undefined ? Math.min(d, it.data.outPoint * 1e6) : d;
    const prevIn = it.rangeIn;
    const prevOut = it.rangeOut;
    it.rangeIn = Math.round(inUs);
    it.rangeOut = Math.round(Math.max(inUs + 1000, outUs));
    const focused = this.isFocused(it);
    // The focus clock is virtual time on the item's loop; when the range
    // moves, re-anchor it so the playhead keeps its source time.
    if (focused && prevOut > prevIn && (prevIn !== it.rangeIn || prevOut !== it.rangeOut)) {
      const prevLoop = prevOut - prevIn;
      const source = prevIn + (((this.focusTimeUs % prevLoop) + prevLoop) % prevLoop);
      const loop = it.rangeOut - it.rangeIn;
      const k = Math.max(0, Math.floor(this.focusTimeUs / prevLoop));
      this.focusTimeUs = k * loop + (Math.min(it.rangeOut - 1, Math.max(it.rangeIn, source)) - it.rangeIn);
    }
    const key = (url: string | undefined) => (url ? `${url}|${it.rangeIn}|${it.rangeOut}${focused ? '|focus' : ''}` : null);
    const a = it.asset;
    it.slot.keys = [key(a.l1.url), key(a.l2?.url), key(a.original?.url)];
    it.slot.focused = focused;
  }

  private isFocused(it: Item): boolean {
    return !!this.focus && this.focus.viewId === it.view.id && this.focus.itemId === it.data.id;
  }

  private setCamera(v: View, c: CameraState): void {
    const now = performance.now();
    const dt = (now - v.lastCameraAt) / 1000;
    if (dt > 0 && dt < 0.2) {
      const s = c.zoom * v.dpr;
      const vx = ((v.camera.x - c.x) * s) / dt;
      const vy = ((v.camera.y - c.y) * s) / dt;
      v.velocity.x = v.velocity.x * 0.6 + vx * 0.4;
      v.velocity.y = v.velocity.y * 0.6 + vy * 0.4;
    }
    v.lastCameraAt = now;
    v.camera = c;
  }

  private setFocus(f: FocusState | null): void {
    const prev = this.focus;
    const same = prev && f && prev.viewId === f.viewId && prev.itemId === f.itemId;
    // A newly focused item starts its own clock where the board clock is.
    if (f && !same) this.focusTimeUs = Math.round(this.boardTimeMs * 1000);
    this.focus = f ? { viewId: f.viewId, itemId: f.itemId, playing: f.playing, speed: f.speed } : null;
    const it = f ? this.views.get(f.viewId)?.byId.get(f.itemId) : null;
    if (f && it) {
      const loop = it.rangeOut - it.rangeIn;
      if (f.seek !== undefined) {
        const k = Math.floor(this.focusTimeUs / loop);
        this.focusTimeUs = k * loop + Math.min(loop - 1, Math.max(0, f.seek * 1e6 - it.rangeIn));
      }
      if (f.step) this.focusTimeUs += Math.round((f.step * 1e6) / (it.asset.fps || 30));
      if (this.focusTimeUs < 0) this.focusTimeUs += loop * Math.ceil(-this.focusTimeUs / loop);
    }
    if (!same) {
      // Keys carry the clock, so refresh the old and new focused items.
      for (const v of this.views.values()) {
        if (prev?.viewId === v.id) {
          const p = v.byId.get(prev.itemId);
          if (p) this.refreshItem(p);
        }
        if (f?.viewId === v.id && it) this.refreshItem(it);
      }
    }
  }

  // Keeps the sprites items need resident: every item of a board, and the
  // items of a scrolling view within RESIDENT_VIEWPORTS of its visible area.
  // Touching a sprite each frame keeps it from being evicted; missing ones
  // are queued visible first, then nearest. Runs after layout, on slots.
  private updateSprites(): void {
    this.atlas.tick();
    const missing: { asset: Asset; d: number }[] = [];
    for (const v of this.views.values()) {
      const { width: W, height: H } = v;
      const reachX = v.kind === 'board' ? Infinity : W * RESIDENT_VIEWPORTS;
      const reachY = v.kind === 'board' ? Infinity : H * RESIDENT_VIEWPORTS;
      for (const it of v.items) {
        const s = it.slot;
        // Distance outside the viewport, device px; 0 when visible.
        const dx = Math.max(0, -(s.x + s.w), s.x - W);
        const dy = Math.max(0, -(s.y + s.h), s.y - H);
        if (dx > reachX || dy > reachY) continue;
        const a = it.asset;
        const entry = this.atlas.get(a.id);
        if (entry) this.atlas.touch(entry);
        else if (a.l0 && !this.sprites.failed.has(a.id) && !this.sprites.isLoading(a.id)) {
          // Visible ones (0) first, then nearest; the centre breaks ties.
          const centre = Math.hypot(s.x + s.w / 2 - W / 2, s.y + s.h / 2 - H / 2);
          missing.push({ asset: a, d: Math.hypot(dx, dy) + centre * 0.01 });
        }
      }
    }
    if (missing.length === 0 && !this.sprites.queued) return;
    missing.sort((a, b) => a.d - b.d);
    const seen = new Set<string>();
    this.sprites.want(missing.filter((m) => !seen.has(m.asset.id) && seen.add(m.asset.id)).map((m) => m.asset));
  }

  // ---- time ----------------------------------------------------------------

  // Virtual playhead (µs) for a timeline: the focus clock, a hover scrub of
  // the asset, or the board clock.
  private targetUs(assetId: string, loopUs: number, focus: boolean): number {
    if (focus) return this.focusTimeUs;
    const t = Math.round(this.boardTimeMs * 1000);
    if (this.scrub?.assetId === assetId) return Math.floor(t / loopUs) * loopUs + Math.floor(this.scrub.fraction * loopUs);
    return t;
  }

  private itemTarget(it: Item): number {
    return this.targetUs(it.asset.id, it.rangeOut - it.rangeIn, it.slot.focused);
  }

  // ---- frame ---------------------------------------------------------------

  private tick = (now: number): void => {
    requestAnimationFrame(this.tick);
    const cap = this.settings.fpsCap;
    if (cap > 0 && this.lastTick && now - this.lastTick < 1000 / cap - 2) return;
    const interval = this.lastTick ? now - this.lastTick : 1000 / 60;
    this.lastTick = now;
    const dt = Math.min(100, interval);
    if (!this.paused) this.boardTimeMs += dt;
    if (this.focus?.playing) this.focusTimeUs += Math.round(dt * 1000 * this.focus.speed);

    const start = performance.now();
    try {
      this.frame(now, dt);
    } catch (e) {
      console.error(e);
    }
    const cpu = performance.now() - start;

    this.intervals.push(interval);
    this.cpuTimes.push(cpu);
    this.lateWindow.push([this.videoDraws, this.lateDraws]);
    if (this.intervals.length > 120) {
      this.intervals.shift();
      this.cpuTimes.shift();
      this.lateWindow.shift();
    }
    if (this.recording && this.recording.length < MAX_RECORD_FRAMES) {
      let l1 = 0;
      let l2 = 0;
      for (const s of this.streams.values()) s.tier >= 2 ? l2++ : l1++;
      this.recording.push({
        dt: interval,
        cpu,
        visible: this.shownTiers[0] + this.shownTiers[1] + this.shownTiers[2],
        decoders: this.streams.size,
        l1,
        l2,
        videos: this.videoDraws,
        late: this.lateDraws,
      });
    }
    this.adaptBudget(now);
    if (now - this.lastStatsAt > STATS_INTERVAL_MS) {
      this.lastStatsAt = now;
      this.post({ type: 'stats', stats: this.stats() });
    }
  };

  private frame(now: number, dt: number): void {
    const slots: Slot[] = [];
    for (const v of this.views.values()) {
      // Pan velocity decays once camera updates stop.
      if (now - v.lastCameraAt > 50) {
        v.velocity.x *= 0.8;
        v.velocity.y *= 0.8;
      }
      this.layoutView(v, slots);
    }
    this.updateSprites();
    plan(slots, this.settings, this.budget, this.assignment);
    this.syncLayers(now, dt);

    let videoDraws = 0;
    let lateDraws = 0;
    let missing = 0;
    const tiers: [number, number, number] = [0, 0, 0];
    for (const v of this.views.values()) {
      const r = this.drawView(v, tiers);
      videoDraws += r.videos;
      lateDraws += r.late;
      missing += r.missing;
    }
    this.shownTiers = tiers;
    this.missingSprites = missing;
    this.videoDraws = videoDraws;
    this.lateDraws = lateDraws;

    const f = this.focus;
    if (f) {
      const it = this.views.get(f.viewId)?.byId.get(f.itemId);
      if (it) {
        const loop = it.rangeOut - it.rangeIn;
        const local = ((this.focusTimeUs % loop) + loop) % loop;
        this.post({ type: 'focusTime', time: (it.rangeIn + local) / 1e6, inPoint: it.rangeIn / 1e6, outPoint: it.rangeOut / 1e6 });
      }
    }
  }

  private layoutView(v: View, slots: Slot[]): void {
    const { width: W, height: H } = v;
    const scale = v.camera.zoom * v.dpr;
    const camX = v.camera.x;
    const camY = v.camera.y;
    const lead = PREFETCH_LEAD_S;
    const left = W * PREFETCH_MARGIN + Math.max(0, -v.velocity.x) * lead;
    const right = W * PREFETCH_MARGIN + Math.max(0, v.velocity.x) * lead;
    const top = H * PREFETCH_MARGIN + Math.max(0, -v.velocity.y) * lead;
    const bottom = H * PREFETCH_MARGIN + Math.max(0, v.velocity.y) * lead;
    for (const it of v.items) {
      const p = it.data;
      const s = it.slot;
      s.x = (p.x - camX) * scale;
      s.y = (p.y - camY) * scale;
      s.w = p.w * scale;
      s.h = p.h * scale;
      s.visible = s.x < W && s.x + s.w > 0 && s.y < H && s.y + s.h > 0;
      s.nearby = !s.visible && s.x < W + right && s.x + s.w > -left && s.y < H + bottom && s.y + s.h > -top;
      s.visibleArea = s.visible ? (Math.min(s.x + s.w, W) - Math.max(s.x, 0)) * (Math.min(s.y + s.h, H) - Math.max(s.y, 0)) : 0;
      s.current = it.assigned;
      s.blocked = this.blocked.get(it.asset.id) ?? null;
      s.needsVideo = !it.asset.l0 || this.sprites.failed.has(it.asset.id);
      slots.push(s);
    }
  }

  private syncLayers(now: number, dt: number): void {
    for (const e of this.streams.values()) e.stream.used = false;
    const step = dt / FADE_MS;

    for (const v of this.views.values()) {
      for (const it of v.items) {
        const tier = this.assignment.get(it.slot) ?? 0;
        it.assigned = tier;
        const key = tier > 0 ? it.slot.keys[tier - 1] : null;
        if (key) {
          let e = this.streams.get(key);
          if (!e || !e.stream.decoding) {
            const url = tier === 3 ? it.asset.original!.url : tier === 2 ? it.asset.l2!.url : it.asset.l1.url;
            e = {
              stream: new VideoStream(key, url, it.rangeIn, it.rangeOut, this.cache, now),
              assetId: it.asset.id,
              tier,
              loopUs: it.rangeOut - it.rangeIn,
              focus: it.slot.focused,
            };
            this.streams.set(key, e);
          }
          if (!it.layers.some((l) => l.key === key)) it.layers.push({ tier, key, alpha: 0, wanted: true, createdAt: now });
        }
        for (const l of it.layers) l.wanted = l.key === key;

        // Crossfades: a new layer fades in over the old one, which is
        // dropped once covered; with no replacement, fade back to the sprite.
        const onScreen = it.slot.visible || it.slot.nearby;
        const incoming = it.layers.find((l) => l.wanted && this.streams.get(l.key)?.stream.decoding);
        it.layers = it.layers.filter((l) => {
          const e = this.streams.get(l.key);
          if (!e || e.stream.state === 'failed') {
            if (e) this.markFailed(e);
            return false;
          }
          if (l.wanted) {
            if (e.stream.current()) l.alpha = Math.min(1, l.alpha + step);
          } else if (!onScreen || (incoming && incoming.alpha >= 1)) {
            return false;
          } else if (!incoming) {
            l.alpha -= step;
            if (l.alpha <= 0) return false;
          }
          e.stream.used = true;
          return true;
        });
      }
    }

    for (const [key, e] of this.streams) {
      if (!e.stream.used) {
        e.stream.close();
        this.streams.delete(key);
      } else {
        e.stream.update(this.targetUs(e.assetId, e.loopUs, e.focus));
      }
    }

    // Fast pans can leave many streams fading out at once; past the budget
    // plus a margin, cut unwanted layers (oldest first) and their streams.
    const limit = this.budget + TRANSIENT_STREAMS;
    if (this.streams.size > limit) {
      const unwanted: { it: Item; l: Layer }[] = [];
      for (const v of this.views.values()) for (const it of v.items) for (const l of it.layers) if (!l.wanted) unwanted.push({ it, l });
      unwanted.sort((a, b) => a.l.createdAt - b.l.createdAt);
      for (const { it, l } of unwanted) {
        if (this.streams.size <= limit) break;
        it.layers = it.layers.filter((x) => x !== l);
        if (!this.layerUses(l.key)) {
          this.streams.get(l.key)?.stream.close();
          this.streams.delete(l.key);
        }
      }
    }
  }

  private layerUses(key: string): boolean {
    for (const v of this.views.values()) for (const it of v.items) for (const l of it.layers) if (l.key === key) return true;
    return false;
  }

  private markFailed(e: StreamEntry): void {
    this.failures++;
    const prev = this.blocked.get(e.assetId);
    this.blocked.set(e.assetId, prev === undefined ? e.tier : (Math.min(prev, e.tier) as Tier));
    const name = this.assets.get(e.assetId)?.name ?? e.assetId;
    console.warn(`tier ${e.tier} decode failed for ${name}: ${e.stream.error}`);
    this.streams.delete(e.stream.key);
  }

  // ---- drawing -------------------------------------------------------------

  private drawView(v: View, tiers: [number, number, number]): { videos: number; late: number; missing: number } {
    const items = v.items;
    if (this.tileData.length < items.length * TILE_FLOATS) this.tileData = new Float32Array(items.length * TILE_FLOATS * 2);
    const td = this.tileData;
    let n = 0;
    let missing = 0;
    for (const it of items) {
      const s = it.slot;
      if (!s.visible) continue;
      const o = n * TILE_FLOATS;
      td[o] = s.x;
      td[o + 1] = s.y;
      td[o + 2] = s.w;
      td[o + 3] = s.h;
      const entry = this.atlas.get(it.asset.id);
      if (entry) {
        const loop = it.rangeOut - it.rangeIn;
        const local = ((this.itemTarget(it) % loop) + loop) % loop;
        const source = (it.rangeIn + local) / (it.asset.duration * 1e6);
        const f = entry.frames[Math.min(entry.frameCount - 1, Math.max(0, Math.floor(source * entry.frameCount)))];
        const [u0, v0, u1, v1] = it.data.crop ?? FULL_FRAME;
        td[o + 4] = (f.x + u0 * entry.frameWidth) / ATLAS_SIZE;
        td[o + 5] = (f.y + v0 * entry.frameHeight) / ATLAS_SIZE;
        td[o + 6] = (f.x + u1 * entry.frameWidth) / ATLAS_SIZE;
        td[o + 7] = (f.y + v1 * entry.frameHeight) / ATLAS_SIZE;
        td[o + 8] = f.layer;
      } else {
        td[o + 4] = td[o + 5] = td[o + 6] = td[o + 7] = 0;
        td[o + 8] = -1;
        if (it.asset.l0 && !this.sprites.failed.has(it.asset.id)) missing++;
      }
      td[o + 9] = it.depth;
      td[o + 10] = it.data.dim ?? 1;
      td[o + 11] = 0;
      n++;
    }

    // Video layers over their tiles: back to front by z, and within a tile
    // older layers first so a replacement fades in on top.
    const videos = this.videos;
    videos.length = 0;
    let videoDraws = 0;
    let lateDraws = 0;
    const shown = new Map<Item, Tier>();
    const ordered = items.filter((it) => it.slot.visible && it.layers.length > 0).sort((a, b) => a.data.z - b.data.z);
    for (const it of ordered) {
      const layers = it.layers.length > 1 ? [...it.layers].sort((a, b) => a.createdAt - b.createdAt) : it.layers;
      for (const l of layers) {
        if (l.alpha <= 0) continue;
        const e = this.streams.get(l.key);
        const frame = e?.stream.current();
        if (!e || !frame) continue;
        // Scrubs and focus seek on purpose; their catch-up isn't decoder lag.
        if (l.alpha >= 1 && !e.focus && this.scrub?.assetId !== e.assetId) {
          videoDraws++;
          if (!e.stream.onTime()) lateDraws++;
        }
        const s = it.slot;
        videos.push({ frame, x: s.x, y: s.y, w: s.w, h: s.h, alpha: l.alpha, depth: it.depth, dim: it.data.dim ?? 1, crop: it.data.crop ?? FULL_FRAME });
        if (l.alpha >= 0.5) shown.set(it, Math.max(shown.get(it) ?? 0, l.tier) as Tier);
      }
    }
    for (const it of items) if (it.slot.visible) tiers[Math.min(2, shown.get(it) ?? 0)]++;

    const overlayCount = this.buildOverlay(v, shown);
    const scale = v.camera.zoom * v.dpr;
    this.renderer.render(
      v.target,
      v.context.getCurrentTexture(),
      {
        width: v.width,
        height: v.height,
        cameraX: v.camera.x,
        cameraY: v.camera.y,
        scale,
        dpr: v.dpr,
        radius: v.style.radius * v.dpr,
        grid: v.style.grid,
        background: v.style.background,
        gridColor: v.style.gridColor,
        placeholder: v.style.placeholder,
      },
      td,
      n,
      videos,
      this.overlayData,
      overlayCount,
    );
    return { videos: videoDraws, late: lateDraws, missing };
  }

  // Converts the view's overlay rects (and tier outlines when on) to device
  // px for the overlay pass. Returns the rect count.
  private buildOverlay(v: View, shown: Map<Item, Tier>): number {
    const tierRects = this.settings.showTiers ? v.items.filter((it) => it.slot.visible).length : 0;
    const total = v.overlay.length + tierRects;
    if (this.overlayData.length < total * OVERLAY_FLOATS) this.overlayData = new Float32Array(total * OVERLAY_FLOATS * 2);
    const od = this.overlayData;
    const scale = v.camera.zoom * v.dpr;
    let n = 0;
    const put = (x: number, y: number, w: number, h: number, fill: RGBA, stroke: RGBA, sw: number, r: number) => {
      const o = n++ * OVERLAY_FLOATS;
      od[o] = x;
      od[o + 1] = y;
      od[o + 2] = w;
      od[o + 3] = h;
      od.set(fill, o + 4);
      od.set(stroke, o + 8);
      od[o + 12] = sw;
      od[o + 13] = r;
    };
    if (tierRects) {
      const none: RGBA = [0, 0, 0, 0];
      for (const it of v.items) {
        if (!it.slot.visible) continue;
        const s = it.slot;
        put(s.x, s.y, s.w, s.h, none, TIER_COLORS[shown.get(it) ?? 0], 2 * v.dpr, v.style.radius * v.dpr);
      }
    }
    for (const r of v.overlay) {
      const world = r.space === 'world';
      const x = world ? (r.x - v.camera.x) * scale : r.x * v.dpr;
      const y = world ? (r.y - v.camera.y) * scale : r.y * v.dpr;
      const w = world ? r.w * scale : r.w * v.dpr;
      const h = world ? r.h * scale : r.h * v.dpr;
      put(x, y, w, h, r.fill, r.stroke, r.strokeWidth * v.dpr, r.radius * v.dpr);
    }
    return n;
  }

  // ---- budget & stats ------------------------------------------------------

  private adaptBudget(now: number): void {
    if (now - this.budgetCheckAt < BUDGET_CHECK_MS) return;
    this.budgetCheckAt = now;
    const max = this.settings.decoderBudget;
    // Decoders that are configured but have produced nothing (still
    // downloading doesn't count: that's the network, not the decoder).
    const stuck = [...this.streams.values()].filter((e) => e.stream.state === 'ready' && !e.stream.started && now - e.stream.readyAt > STUCK_MS);
    if (this.lateRatio() > LATE_LIMIT || stuck.length > 0) {
      this.budget = Math.min(max, Math.max(BUDGET_MIN, Math.floor(this.budget * 0.75)));
      this.cleanSince = now;
      // A decoder that never produced a frame may never will; restart it.
      for (const e of stuck) {
        e.stream.close();
        this.streams.delete(e.stream.key);
      }
    } else if (this.budget < max && now - this.cleanSince > BUDGET_RECOVER_MS) {
      this.budget++;
    }
  }

  // Share of fully faded-in video tiles that drew a stale frame, last ~1 s.
  private lateRatio(): number {
    let videos = 0;
    let late = 0;
    for (const [v, l] of this.lateWindow) {
      videos += v;
      late += l;
    }
    return videos ? late / videos : 0;
  }

  private stats(): EngineStats {
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
    const mean = this.intervals.reduce((a, b) => a + b, 0) / Math.max(1, this.intervals.length);
    // The display interval is roughly the fastest interval we see.
    const refresh = this.settings.fpsCap > 0 ? 1000 / this.settings.fpsCap : pct(0.1);
    let decodersL2 = 0;
    let waiting = 0;
    for (const e of this.streams.values()) {
      if (e.tier >= 2) decodersL2++;
      if (e.stream.state === 'loading' || !e.stream.started) waiting++;
    }
    const assetIds = new Set<string>();
    for (const v of this.views.values()) for (const it of v.items) assetIds.add(it.asset.id);
    let resident = 0;
    for (const id of assetIds) if (this.atlas.get(id)) resident++;
    return {
      fps: 1000 / mean,
      refreshHz: 1000 / refresh,
      frameP50: pct(0.5),
      frameP95: pct(0.95),
      frameMax: sorted[sorted.length - 1] ?? 0,
      drops: this.intervals.filter((i) => i > refresh * 1.5).length,
      cpuMs: this.cpuTimes.reduce((a, b) => a + b, 0) / Math.max(1, this.cpuTimes.length),
      visible: this.shownTiers[0] + this.shownTiers[1] + this.shownTiers[2],
      tiers: this.shownTiers,
      decoders: this.streams.size,
      decodersL2,
      budget: this.budget,
      streamsWaiting: waiting,
      lateRatio: this.lateRatio(),
      failed: this.failures,
      l0Resident: resident,
      l0Total: assetIds.size,
      l0Missing: this.missingSprites,
      l0Cached: this.atlas.resident,
      l0Pending: this.sprites.pending,
      l0Evictions: this.atlas.evictions,
      l0Bytes: this.atlas.bytesAllocated,
      l0BytesUsed: this.atlas.bytesUsed,
      atlasLayers: this.atlas.layers,
      atlasLayersUsed: this.atlas.layersInUse,
      atlasCap: this.atlas.softCap,
      atlasFormat: this.atlas.format,
      boardTime: this.boardTimeMs / 1000,
      paused: this.paused,
    };
  }
}
