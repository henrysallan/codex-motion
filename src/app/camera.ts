// The board camera: screen = (world - (x, y)) * zoom, in CSS px. Lives on
// the main thread with input and hit-testing; every change is forwarded to
// the render worker.

import type { CameraState } from '../engine/protocol.ts';

export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 16;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export class Camera implements CameraState {
  x = 0;
  y = 0;
  zoom = 1;

  set(s: CameraState): void {
    this.x = s.x;
    this.y = s.y;
    this.zoom = s.zoom;
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [sx / this.zoom + this.x, sy / this.zoom + this.y];
  }

  // Zooms by `factor`, keeping the world point under (sx, sy) fixed.
  zoomAt(sx: number, sy: number, factor: number): void {
    const [wx, wy] = this.toWorld(sx, sy);
    this.zoom = clampZoom(this.zoom * factor);
    this.x = wx - sx / this.zoom;
    this.y = wy - sy / this.zoom;
  }

  panBy(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
  }
}

// The camera that frames `r` inside a view, with padding in CSS px.
export function fitRect(r: Rect, viewW: number, viewH: number, padding = 48): CameraState {
  // Shrink the padding for small views so the fit never goes negative.
  const pad = Math.min(padding, viewW / 4, viewH / 4);
  const zoom = clampZoom(Math.min((viewW - pad * 2) / Math.max(1, r.w), (viewH - pad * 2) / Math.max(1, r.h)));
  return { zoom, x: r.x + r.w / 2 - viewW / 2 / zoom, y: r.y + r.h / 2 - viewH / 2 / zoom };
}

// Interpolates two cameras: the view centre moves linearly while zoom moves
// geometrically, which reads as a steady push-in rather than a lurch.
export function lerpCamera(a: CameraState, b: CameraState, t: number, viewW: number, viewH: number): CameraState {
  const ca = [a.x + viewW / 2 / a.zoom, a.y + viewH / 2 / a.zoom];
  const cb = [b.x + viewW / 2 / b.zoom, b.y + viewH / 2 / b.zoom];
  const zoom = a.zoom * Math.pow(b.zoom / a.zoom, t);
  const cx = ca[0] + (cb[0] - ca[0]) * t;
  const cy = ca[1] + (cb[1] - ca[1]) * t;
  return { zoom, x: cx - viewW / 2 / zoom, y: cy - viewH / 2 / zoom };
}

export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
