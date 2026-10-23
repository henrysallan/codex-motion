// Main-thread handle on the render worker. Each pane that shows clips
// creates a view: a canvas transferred to the worker, so UI work on this
// thread never costs the board a frame.

import { mediaUrl } from '../data/media.ts';
import type { Asset } from '../media/library.ts';
import type {
  CameraState,
  EngineSettings,
  FocusState,
  FromWorker,
  OverlayRect,
  ToWorker,
  ViewItem,
  ViewKind,
  ViewStyle,
} from './protocol.ts';

export class EngineView {
  readonly id: number;
  readonly canvas: HTMLCanvasElement;
  private readonly client: EngineClient;
  private readonly observer: ResizeObserver;

  constructor(client: EngineClient, id: number, canvas: HTMLCanvasElement, kind: ViewKind, style: ViewStyle) {
    this.client = client;
    this.id = id;
    this.canvas = canvas;
    const dpr = window.devicePixelRatio;
    const rect = canvas.getBoundingClientRect();
    const offscreen = canvas.transferControlToOffscreen();
    client.send(
      {
        type: 'view',
        id,
        kind,
        canvas: offscreen,
        width: Math.max(1, Math.round(rect.width * dpr)),
        height: Math.max(1, Math.round(rect.height * dpr)),
        dpr,
        style,
      },
      [offscreen],
    );
    // Track the canvas's size in device pixels exactly, so clips are drawn
    // 1:1 with the display.
    this.observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const box = entry.devicePixelContentBoxSize?.[0];
      const ratio = window.devicePixelRatio;
      const w = box ? box.inlineSize : Math.round(entry.contentRect.width * ratio);
      const h = box ? box.blockSize : Math.round(entry.contentRect.height * ratio);
      client.send({ type: 'view:resize', id, width: Math.max(1, w), height: Math.max(1, h), dpr: ratio });
    });
    this.observer.observe(canvas, { box: 'device-pixel-content-box' });
  }

  setItems(items: ViewItem[]): void {
    this.client.send({ type: 'view:items', id: this.id, items });
  }

  setCamera(camera: CameraState): void {
    this.client.send({ type: 'view:camera', id: this.id, camera: { x: camera.x, y: camera.y, zoom: camera.zoom } });
  }

  setOverlay(rects: OverlayRect[]): void {
    this.client.send({ type: 'view:overlay', id: this.id, rects });
  }

  setStyle(style: ViewStyle): void {
    this.client.send({ type: 'view:style', id: this.id, style });
  }

  destroy(): void {
    this.observer.disconnect();
    this.client.send({ type: 'view:remove', id: this.id });
  }
}

export class EngineClient {
  private readonly worker: Worker;
  private nextView = 1;
  private readonly listeners = new Set<(msg: FromWorker) => void>();

  constructor(settings: EngineSettings) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'render' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      for (const l of this.listeners) l(e.data);
    };
    this.worker.onerror = (e) => {
      for (const l of this.listeners) l({ type: 'error', message: e.message || 'render worker failed to start' });
    };
    this.send({ type: 'init', settings });
  }

  on(listener: (msg: FromWorker) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createView(canvas: HTMLCanvasElement, kind: ViewKind, style: ViewStyle): EngineView {
    return new EngineView(this, this.nextView++, canvas, kind, style);
  }

  // Upserts asset metadata. Relative URLs inside a worker resolve against
  // the worker's script, so the worker gets absolute ones.
  setAssets(assets: Asset[]): void {
    const abs = mediaUrl;
    const resolved = assets.map((a) => ({
      ...a,
      l0: a.l0 && { ...a.l0, url: abs(a.l0.url) },
      l1: { ...a.l1, url: abs(a.l1.url) },
      l2: a.l2 && { ...a.l2, url: abs(a.l2.url) },
      original: a.original && { ...a.original, url: abs(a.original.url) },
    }));
    this.send({ type: 'assets', assets: resolved });
  }

  scrub(assetId: string | null, fraction = 0): void {
    this.send({ type: 'scrub', assetId, fraction });
  }

  setPaused(paused: boolean): void {
    this.send({ type: 'pause', paused });
  }

  setFocus(focus: FocusState | null): void {
    this.send({ type: 'focus', focus });
  }

  setSettings(settings: Partial<EngineSettings>): void {
    this.send({ type: 'settings', settings });
  }

  record(on: boolean): void {
    this.send({ type: 'record', on });
  }

  send(msg: ToWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }
}
