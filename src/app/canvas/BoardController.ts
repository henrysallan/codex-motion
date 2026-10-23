// The canvas pane's interaction core, kept out of React so gestures never
// wait on a render: camera, selection, marquee, move with snap, resize,
// hover scrub, fly-in of added clips, and focus mode.
//
// The store is the source of truth. The controller mirrors one collection,
// draws it into its engine view, and writes back once per gesture (one
// undo step). Mid-gesture positions live only here.

import type { EngineView } from '../../engine/client.ts';
import type { CameraState, OverlayRect, ViewItem } from '../../engine/protocol.ts';
import type { Note, Placement } from '../../data/model.ts';
import { Camera, easeInOut, fitRect, lerpCamera, MAX_ZOOM, MIN_ZOOM, type Rect } from '../camera.ts';
import { engine } from '../engine.ts';
import { dropTargets, type DropTarget, on } from '../events.ts';
import { addAssets } from '../actions.ts';
import { infoPanelInset, useDetail } from '../detail/state.ts';
import { space, spaceTap } from '../keys.ts';
import { arrange, bounds } from '../layout/arrange.ts';
import {
  addNote,
  deleteItems,
  notesOf,
  placementsOf,
  redo,
  savePlacements,
  setFocus,
  toggleNoteFormat,
  setSelection,
  topZ,
  undo,
  updatePrefs,
  useStore,
} from '../store.ts';
import { overlayColors, type Resolved } from '../theme.ts';

export type Tool = 'select' | 'hand' | 'note' | 'comment';

export interface BoardCallbacks {
  // Camera moved (for the zoom readout).
  onCamera(c: CameraState): void;
  // Screen rect (pane-relative CSS px) of the selection, for the selection
  // bar; null while dragging or with nothing selected.
  onSelectionRect(r: Rect | null): void;
  onTool(t: Tool): void;
  onContextMenu(x: number, y: number, hitId: string | null): void;
  onEditNote(id: string): void;
  // A click with the comment tool, at a pane-relative point. Without it the
  // board has no comment tool.
  onComment?(sx: number, sy: number, clientX: number, clientY: number): void;
}

type Gesture =
  | { kind: 'pan'; pointerId: number; x: number; y: number }
  | { kind: 'marquee'; pointerId: number; x0: number; y0: number; x1: number; y1: number; base: Set<string> }
  | { kind: 'move'; pointerId: number; sx: number; sy: number; wx: number; wy: number; originals: Map<string, Rect>; moved: boolean; bbox: Rect }
  | {
      kind: 'resize';
      pointerId: number;
      corner: number;
      box: Rect;
      originals: Map<string, Rect>;
      // Grabbed corner minus the press point, in world units, so the corner
      // doesn't jump to the pointer on the first move.
      grab: [number, number];
      // Text boxes reflow rather than scale, so a selection of only text
      // resizes each axis on its own; anything with clips keeps its aspect.
      free: boolean;
      minX: number;
      minY: number;
    }
  // Text tool press, placed on release: a click makes a default box, a drag
  // draws one (world units).
  | { kind: 'note'; pointerId: number; sx: number; sy: number; x0: number; y0: number; x1: number; y1: number; dragged: boolean }
  // Comment tool press: a click drops a pin on release, a drag pans.
  | { kind: 'comment'; pointerId: number; sx: number; sy: number; x: number; y: number; moved: boolean };

interface FlyIn {
  from: Rect;
  start: number;
}

const HANDLE_PX = 10;
const SNAP = 16;
const MOVE_THRESHOLD_PX = 3;
const FLY_MS = 320;
const NOTE_FALLBACK_H = 80;
// Resizing stops shrinking at these, in world units.
const MIN_CLIP_SIDE = 24;
const MIN_NOTE_W = 40;
const MIN_NOTE_H = 12;
const CAMERA_KEY = 'trace.camera.';

export class BoardController {
  readonly camera = new Camera();
  tool: Tool = 'select';
  // A published collection someone else is viewing: look, don't touch.
  readonly readonly: boolean;

  private readonly host: HTMLElement;
  // Keyboard shortcuts work anywhere in the pane, including its toolbars.
  private readonly keyTarget: HTMLElement;
  private readonly notesLayer: HTMLElement;
  private readonly view: EngineView;
  private readonly collectionId: string;
  private readonly cb: BoardCallbacks;
  private theme: Resolved = 'light';

  private placements = new Map<string, Placement>();
  private notes = new Map<string, Note>();
  // Placements topmost first, for hit-testing.
  private stack: Placement[] = [];
  private nums = new Map<string, number>();
  private byNum = new Map<number, string>();
  private nextNum = 1;
  private selection = new Set<string>();
  private hover: string | null = null;
  private gesture: Gesture | null = null;
  // Mid-gesture or mid-animation geometry, by placement or note id.
  private live = new Map<string, Rect>();
  private flyIns = new Map<string, FlyIn>();
  private flyFrame = 0;
  private cameraAnim = 0;
  private pointer: { x: number; y: number } | null = null;
  private focusId: string | null = null;
  private preFocusCamera: CameraState | null = null;
  private size = { w: 0, h: 0 };
  private fitted = false;
  // Focus was entered before the pane had a size; frame it on first layout.
  private pendingFocusFrame = false;
  private readonly unsubs: (() => void)[] = [];
  private readonly dropTarget: DropTarget;
  private saveCameraTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(host: HTMLElement, notesLayer: HTMLElement, view: EngineView, collectionId: string, cb: BoardCallbacks, readonly = false) {
    this.readonly = readonly;
    this.host = host;
    this.keyTarget = host.parentElement ?? host;
    this.notesLayer = notesLayer;
    this.view = view;
    this.collectionId = collectionId;
    this.cb = cb;

    const saved = localStorage.getItem(CAMERA_KEY + collectionId);
    if (saved) {
      try {
        const c = JSON.parse(saved) as CameraState;
        // Ignore anything implausible; we'll fit instead.
        if ([c.x, c.y, c.zoom].every(Number.isFinite) && c.zoom > MIN_ZOOM * 1.5 && c.zoom <= MAX_ZOOM) {
          this.camera.set(c);
          this.fitted = true;
        }
      } catch {
        // Corrupt: fit instead.
      }
    }

    this.sync();
    this.unsubs.push(
      useStore.subscribe((s, prev) => {
        if (s.placements !== prev.placements || s.notes !== prev.notes || s.selection !== prev.selection) this.sync();
        if (s.focus !== prev.focus) this.syncFocus();
      }),
      on('added', (e) => e.collectionId === collectionId && this.flyIn(e.ids, e.from)),
      useDetail.subscribe((s, prev) => {
        if (s.infoPanel !== prev.infoPanel && this.focusId) this.frameFocused();
      }),
    );

    const ro = new ResizeObserver(([entry]) => {
      this.size = { w: entry.contentRect.width, h: entry.contentRect.height };
      if (this.size.w <= 0 || this.size.h <= 0) return;
      if (!this.fitted) {
        this.fitted = true;
        this.fitAll(false);
      } else this.pushCamera();
      if (this.pendingFocusFrame) {
        this.pendingFocusFrame = false;
        this.frameFocused();
      }
    });
    ro.observe(host);
    this.unsubs.push(() => ro.disconnect());

    host.addEventListener('wheel', this.onWheel, { passive: false });
    host.addEventListener('pointerdown', this.onPointerDown);
    host.addEventListener('pointermove', this.onPointerMove);
    host.addEventListener('pointerup', this.onPointerUp);
    host.addEventListener('pointercancel', this.onPointerUp);
    host.addEventListener('pointerleave', this.onPointerLeave);
    host.addEventListener('dblclick', this.onDoubleClick);
    host.addEventListener('contextmenu', this.onContextMenu);
    this.keyTarget.addEventListener('keydown', this.onKeyDown);

    this.dropTarget = {
      accepts: (x, y) => {
        const r = host.getBoundingClientRect();
        return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
      },
      hover: (_x, _y, over) => host.classList.toggle('drop-hover', over),
      drop: (assetIds, x, y) => {
        const r = host.getBoundingClientRect();
        const [wx, wy] = this.camera.toWorld(x - r.left, y - r.top);
        addAssets(collectionId, assetIds, { x: wx, y: wy });
      },
    };
    if (!readonly) dropTargets.add(this.dropTarget);

    this.syncFocus();
    this.pushCamera();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    dropTargets.delete(this.dropTarget);
    cancelAnimationFrame(this.flyFrame);
    cancelAnimationFrame(this.cameraAnim);
    this.host.removeEventListener('wheel', this.onWheel);
    this.host.removeEventListener('pointerdown', this.onPointerDown);
    this.host.removeEventListener('pointermove', this.onPointerMove);
    this.host.removeEventListener('pointerup', this.onPointerUp);
    this.host.removeEventListener('pointercancel', this.onPointerUp);
    this.host.removeEventListener('pointerleave', this.onPointerLeave);
    this.host.removeEventListener('dblclick', this.onDoubleClick);
    this.host.removeEventListener('contextmenu', this.onContextMenu);
    this.keyTarget.removeEventListener('keydown', this.onKeyDown);
    if (this.focusId) {
      engine.setFocus(null);
      spaceTap.focus = null;
    }
    engine.scrub(null);
    this.saveCamera();
  }

  setTheme(theme: Resolved): void {
    this.theme = theme;
    this.pushOverlay();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.host.dataset.tool = tool;
    this.cb.onTool(tool);
  }

  // ---- store mirror --------------------------------------------------------

  private sync(): void {
    if (this.gesture && this.gesture.kind !== 'pan' && this.gesture.kind !== 'marquee' && this.gesture.kind !== 'comment') return;
    const s = useStore.getState();
    this.placements = new Map(placementsOf(this.collectionId, s.placements).map((p) => [p.id, p]));
    this.notes = new Map(notesOf(this.collectionId, s.notes).map((n) => [n.id, n]));
    this.stack = [...this.placements.values()].sort((a, b) => b.z - a.z);
    this.selection = new Set(s.selection.filter((id) => this.placements.has(id) || this.notes.has(id)));
    if (this.hover && !this.placements.has(this.hover)) this.hover = null;
    this.pushItems();
    this.pushOverlay();
  }

  private num(id: string): number {
    let n = this.nums.get(id);
    if (n === undefined) {
      n = this.nextNum++;
      this.nums.set(id, n);
      this.byNum.set(n, id);
    }
    return n;
  }

  private boxOf(id: string): Rect | null {
    const live = this.live.get(id);
    // A note is as tall as its text, whatever width a gesture gives it.
    if (live) return this.notes.has(id) ? { ...live, h: this.noteHeight(id) } : live;
    const p = this.placements.get(id);
    if (p) return p;
    const n = this.notes.get(id);
    if (n) return { x: n.x, y: n.y, w: n.w, h: this.noteHeight(id) };
    return null;
  }

  private notesOnly(): boolean {
    for (const id of this.selection) if (!this.notes.has(id)) return false;
    return this.selection.size > 0;
  }

  // Height of a note's text alone, at its current width.
  private textHeight(id: string): number {
    const el = this.notesLayer.querySelector<HTMLElement>(`[data-note="${id}"] .note-text`);
    return el?.offsetHeight ?? 0;
  }

  private noteHeight(id: string): number {
    const el = this.notesLayer.querySelector<HTMLElement>(`[data-note="${id}"]`);
    return el?.offsetHeight || NOTE_FALLBACK_H;
  }

  private pushItems(): void {
    const items: ViewItem[] = [];
    const now = performance.now();
    for (const p of this.placements.values()) {
      let b: Rect = this.live.get(p.id) ?? p;
      const fly = this.flyIns.get(p.id);
      if (fly) {
        const t = easeInOut(Math.min(1, (now - fly.start) / FLY_MS));
        b = { x: fly.from.x + (p.x - fly.from.x) * t, y: fly.from.y + (p.y - fly.from.y) * t, w: fly.from.w + (p.w - fly.from.w) * t, h: fly.from.h + (p.h - fly.from.h) * t };
      }
      items.push({
        id: this.num(p.id),
        assetId: p.assetId,
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        z: p.z,
        inPoint: p.inPoint ?? undefined,
        outPoint: p.outPoint ?? undefined,
        dim: this.focusId && this.focusId !== p.id ? 0.14 : 1,
      });
    }
    this.view.setItems(items);
    // Comment pins and notes follow live geometry while dragged.
    for (const [id, b] of this.live) {
      for (const pin of this.notesLayer.querySelectorAll<HTMLElement>(`[data-anchor="${id}"]`)) {
        pin.style.left = `${b.x + Number(pin.dataset.px) * b.w}px`;
        pin.style.top = `${b.y + Number(pin.dataset.py) * b.h}px`;
      }
      if (!this.notes.has(id)) continue;
      const el = this.notesLayer.querySelector<HTMLElement>(`[data-note="${id}"]`);
      if (el) {
        el.style.left = `${b.x}px`;
        el.style.top = `${b.y}px`;
        el.style.width = `${b.w}px`;
        // Moves leave a note's height to its text.
        if (this.gesture?.kind === 'resize') el.style.minHeight = `${b.h}px`;
      }
    }
  }

  // Selection outlines, hover, handles and marquee, as GPU overlay rects in
  // world space so they track the camera exactly.
  private pushOverlay(): void {
    const { accent, handle } = overlayColors[this.theme];
    const z = this.camera.zoom;
    const rects: OverlayRect[] = [];
    const outline = (b: Rect, a: number, width: number, radius = 2) =>
      rects.push({ ...b, space: 'world', fill: [0, 0, 0, 0], stroke: [...accent, a], strokeWidth: width, radius });

    const g = this.gesture;
    if (this.hover && !this.selection.has(this.hover) && !g && !this.focusId) {
      const b = this.boxOf(this.hover);
      if (b) outline(b, 0.55, 1.5);
    }
    if (!this.focusId) {
      for (const id of this.selection) {
        if (!this.placements.has(id)) continue;
        const b = this.boxOf(id);
        if (b) outline(b, 1, 2);
      }
      const box = this.selectionBounds();
      if (box && !(g?.kind === 'move' && g.moved)) {
        if (this.selection.size > 1) outline(box, 0.45, 1, 0);
        const s = HANDLE_PX / z;
        for (const [cx, cy] of corners(box)) {
          rects.push({ x: cx - s / 2, y: cy - s / 2, w: s, h: s, space: 'world', fill: [...handle, 1], stroke: [...accent, 1], strokeWidth: 1.5, radius: 2.5 });
        }
      }
    }
    if (g?.kind === 'marquee' || (g?.kind === 'note' && g.dragged)) {
      rects.push({
        x: Math.min(g.x0, g.x1),
        y: Math.min(g.y0, g.y1),
        w: Math.abs(g.x1 - g.x0),
        h: Math.abs(g.y1 - g.y0),
        space: 'world',
        fill: [...accent, 0.07],
        stroke: [...accent, 0.7],
        strokeWidth: 1,
        radius: 0,
      });
    }
    this.view.setOverlay(rects);
    this.cb.onSelectionRect(g && g.kind !== 'pan' ? null : this.selectionScreenRect());
  }

  private selectionBounds(): Rect | null {
    const boxes: Rect[] = [];
    for (const id of this.selection) {
      const b = this.boxOf(id);
      if (b) boxes.push(b);
    }
    return bounds(boxes);
  }

  private selectionScreenRect(): Rect | null {
    if (this.focusId) return null;
    const b = this.selectionBounds();
    if (!b) return null;
    const z = this.camera.zoom;
    return { x: (b.x - this.camera.x) * z, y: (b.y - this.camera.y) * z, w: b.w * z, h: b.h * z };
  }

  private pushCamera(): void {
    const c = this.camera;
    this.view.setCamera(c);
    this.notesLayer.style.transform = `scale(${c.zoom}) translate(${-c.x}px, ${-c.y}px)`;
    // Lets note outlines stay a constant screen width.
    this.notesLayer.style.setProperty('--zoom', String(c.zoom));
    this.cb.onCamera({ x: c.x, y: c.y, zoom: c.zoom });
    this.pushOverlay();
    this.scheduleSaveCamera();
  }

  private scheduleSaveCamera(): void {
    if (this.saveCameraTimer) return;
    this.saveCameraTimer = setTimeout(() => this.saveCamera(), 500);
  }

  private saveCamera(): void {
    if (this.saveCameraTimer) clearTimeout(this.saveCameraTimer);
    this.saveCameraTimer = null;
    const c = this.focusId && this.preFocusCamera ? this.preFocusCamera : this.camera;
    try {
      localStorage.setItem(CAMERA_KEY + this.collectionId, JSON.stringify({ x: c.x, y: c.y, zoom: c.zoom }));
    } catch {
      // Not critical.
    }
  }

  // ---- camera ----------------------------------------------------------------

  animateTo(target: CameraState, ms = 350): Promise<void> {
    cancelAnimationFrame(this.cameraAnim);
    const from: CameraState = { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom };
    const start = performance.now();
    return new Promise((resolve) => {
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ms);
        this.camera.set(lerpCamera(from, target, easeInOut(t), this.size.w, this.size.h));
        this.pushCamera();
        if (t < 1) this.cameraAnim = requestAnimationFrame(step);
        else resolve();
      };
      this.cameraAnim = requestAnimationFrame(step);
    });
  }

  contentBounds(): Rect | null {
    const boxes: Rect[] = [...this.placements.values()];
    for (const n of this.notes.values()) boxes.push({ x: n.x, y: n.y, w: n.w, h: this.noteHeight(n.id) });
    return bounds(boxes);
  }

  fitAll(animate = true): void {
    if (this.size.w <= 0 || this.size.h <= 0) return;
    const b = this.contentBounds() ?? { x: -400, y: -300, w: 800, h: 600 };
    const target = fitRect(b, this.size.w, this.size.h, 64);
    target.zoom = Math.min(target.zoom, 2);
    if (animate) void this.animateTo(target);
    else {
      cancelAnimationFrame(this.cameraAnim);
      this.camera.set(lerpCamera(target, target, 1, this.size.w, this.size.h));
      this.pushCamera();
    }
  }

  zoomTo(zoom: number): void {
    const { w, h } = this.size;
    const cx = this.camera.x + w / 2 / this.camera.zoom;
    const cy = this.camera.y + h / 2 / this.camera.zoom;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
    void this.animateTo({ zoom: z, x: cx - w / 2 / z, y: cy - h / 2 / z }, 250);
  }

  zoomBy(factor: number): void {
    cancelAnimationFrame(this.cameraAnim);
    this.camera.zoomAt(this.size.w / 2, this.size.h / 2, factor);
    this.pushCamera();
  }

  get viewSize(): { w: number; h: number } {
    return this.size;
  }

  // ---- hit testing -----------------------------------------------------------

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.host.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  hitTest(sx: number, sy: number): Placement | null {
    const [wx, wy] = this.camera.toWorld(sx, sy);
    for (const p of this.stack) {
      const b = this.live.get(p.id) ?? p;
      if (wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h) return p;
    }
    return null;
  }

  // Notes draw above clips, so they win where the two overlap.
  private noteAt(sx: number, sy: number): string | null {
    const [wx, wy] = this.camera.toWorld(sx, sy);
    let top: Note | null = null;
    for (const n of this.notes.values()) {
      const b = this.boxOf(n.id)!;
      if (wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h && (!top || n.z > top.z)) top = n;
    }
    return top?.id ?? null;
  }

  private handleAt(sx: number, sy: number): number {
    if (this.focusId) return -1;
    const b = this.selectionBounds();
    if (!b) return -1;
    const z = this.camera.zoom;
    const pts = corners(b);
    for (let i = 0; i < 4; i++) {
      const hx = (pts[i][0] - this.camera.x) * z;
      const hy = (pts[i][1] - this.camera.y) * z;
      if (Math.abs(sx - hx) <= HANDLE_PX && Math.abs(sy - hy) <= HANDLE_PX) return i;
    }
    return -1;
  }

  // ---- input -------------------------------------------------------------------

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    cancelAnimationFrame(this.cameraAnim);
    const p = this.local(e);
    const lineScale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.size.h : 1;
    const dx = e.deltaX * lineScale;
    const dy = e.deltaY * lineScale;
    // A notched mouse wheel sends whole-number vertical steps; a trackpad
    // sends fine fractional deltas on both axes.
    const mouseWheel = e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY));
    if (e.ctrlKey || e.metaKey || mouseWheel) {
      const clamped = Math.max(-60, Math.min(60, dy));
      this.camera.zoomAt(p.x, p.y, Math.exp(-clamped * (e.ctrlKey && !mouseWheel ? 0.012 : 0.004)));
    } else {
      this.camera.panBy(-dx, -dy);
    }
    this.pointer = p;
    this.pushCamera();
    this.updateHover();
  };

  // Notes call this from their own pointerdown.
  pointerDownOnNote(e: PointerEvent | React.PointerEvent, id: string): void {
    // The comment tool pins over notes like anywhere else (onPointerDown).
    if (e.button !== 0 || space.down || this.tool === 'hand' || this.tool === 'comment' || this.readonly) return;
    e.stopPropagation();
    this.host.focus({ preventScroll: true });
    // Selection handles straddle the note's corners.
    const p = this.local(e);
    const corner = this.handleAt(p.x, p.y);
    if (corner >= 0) {
      this.beginResize(e, corner, p);
      return;
    }
    this.selectFor(id, e.shiftKey || e.metaKey || e.ctrlKey);
    this.beginMove(e, p);
  }

  private onPointerDown = (e: PointerEvent) => {
    // Notes handle their own presses (React runs after this native listener),
    // and comment pins and threads are their own UI.
    if (e.button === 2 || commentIdOf(e.target) || (noteIdOf(e.target) && this.tool !== 'comment')) return;
    this.host.focus({ preventScroll: true });
    cancelAnimationFrame(this.cameraAnim);
    const p = this.local(e);
    if (e.button === 0 && this.tool === 'comment' && !space.down) {
      this.host.setPointerCapture(e.pointerId);
      this.gesture = { kind: 'comment', pointerId: e.pointerId, sx: p.x, sy: p.y, x: e.clientX, y: e.clientY, moved: false };
      this.setHover(null);
      return;
    }
    // Read-only boards pan on any drag.
    if (e.button === 1 || space.down || this.tool === 'hand' || (this.readonly && !this.focusId)) {
      if (space.down) space.used = true;
      this.host.setPointerCapture(e.pointerId);
      this.gesture = { kind: 'pan', pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      this.host.classList.add('panning');
      this.setHover(null);
      return;
    }
    if (e.button !== 0) return;
    if (this.focusId) {
      // In focus mode a click off the clip leaves focus.
      if (this.hitTest(p.x, p.y)?.id !== this.focusId) this.exitFocus();
      return;
    }
    const corner = this.handleAt(p.x, p.y);
    if (corner >= 0) {
      this.beginResize(e, corner, p);
      return;
    }
    const hit = this.hitTest(p.x, p.y);
    if (hit && this.tool === 'select') {
      this.selectFor(hit.id, e.shiftKey || e.metaKey || e.ctrlKey);
      this.beginMove(e, p);
      return;
    }
    if (this.tool === 'note') {
      // Placing it now would lose the note's focus to the press's own
      // focus change, and an empty note deletes itself on blur.
      this.host.setPointerCapture(e.pointerId);
      const [wx, wy] = this.camera.toWorld(p.x, p.y);
      this.gesture = { kind: 'note', pointerId: e.pointerId, sx: p.x, sy: p.y, x0: wx, y0: wy, x1: wx, y1: wy, dragged: false };
      return;
    }
    // Marquee on empty board.
    this.host.setPointerCapture(e.pointerId);
    const [wx, wy] = this.camera.toWorld(p.x, p.y);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    this.gesture = { kind: 'marquee', pointerId: e.pointerId, x0: wx, y0: wy, x1: wx, y1: wy, base: additive ? new Set(this.selection) : new Set() };
    if (!additive) setSelection([]);
    engine.scrub(null);
  };

  private selectFor(id: string, toggle: boolean): void {
    const s = useStore.getState().selection;
    if (toggle) setSelection(s.includes(id) ? s.filter((x) => x !== id) : [...s, id]);
    else if (!s.includes(id)) setSelection([id]);
  }

  private beginResize(e: PointerEvent | React.PointerEvent, corner: number, p: { x: number; y: number }): void {
    this.host.setPointerCapture(e.pointerId);
    const box = this.selectionBounds()!;
    const originals = new Map<string, Rect>();
    const free = this.notesOnly();
    // Smallest scale per axis that keeps every item above its minimum size.
    let minX = 0;
    let minY = 0;
    for (const id of this.selection) {
      const o = { ...this.boxOf(id)! };
      originals.set(id, o);
      if (this.notes.has(id)) {
        minX = Math.max(minX, MIN_NOTE_W / o.w);
        minY = Math.max(minY, MIN_NOTE_H / o.h);
      } else {
        const m = MIN_CLIP_SIDE / Math.min(o.w, o.h);
        minX = Math.max(minX, m);
        minY = Math.max(minY, m);
      }
    }
    if (!free) minX = minY = Math.max(minX, minY);
    const [wx, wy] = this.camera.toWorld(p.x, p.y);
    const [cx, cy] = corners(box)[corner];
    this.gesture = { kind: 'resize', pointerId: e.pointerId, corner, box, originals, grab: [cx - wx, cy - wy], free, minX, minY };
    this.setHover(null);
    engine.scrub(null);
  }

  private beginMove(e: PointerEvent | React.PointerEvent, p: { x: number; y: number }): void {
    const ids = useStore.getState().selection;
    if (ids.length === 0) return;
    this.host.setPointerCapture(e.pointerId);
    const [wx, wy] = this.camera.toWorld(p.x, p.y);
    const originals = new Map<string, Rect>();
    for (const id of ids) {
      const b = this.boxOf(id);
      if (b) originals.set(id, { ...b });
    }
    this.gesture = { kind: 'move', pointerId: e.pointerId, sx: p.x, sy: p.y, wx, wy, originals, moved: false, bbox: bounds([...originals.values()])! };
  }

  private onPointerMove = (e: PointerEvent) => {
    const p = this.local(e);
    this.pointer = p;
    const g = this.gesture;
    if (!g) {
      if (commentIdOf(e.target)) this.setHover(null);
      else this.updateHover();
      return;
    }
    if (g.pointerId !== e.pointerId) return;
    if (g.kind === 'comment') {
      if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) < MOVE_THRESHOLD_PX) return;
      if (!g.moved) {
        g.moved = true;
        this.host.classList.add('panning');
      }
      this.camera.panBy(e.clientX - g.x, e.clientY - g.y);
      g.x = e.clientX;
      g.y = e.clientY;
      this.pushCamera();
      return;
    }
    if (g.kind === 'pan') {
      this.camera.panBy(e.clientX - g.x, e.clientY - g.y);
      g.x = e.clientX;
      g.y = e.clientY;
      this.pushCamera();
      return;
    }
    const [wx, wy] = this.camera.toWorld(p.x, p.y);
    if (g.kind === 'note') {
      g.x1 = wx;
      g.y1 = wy;
      g.dragged ||= Math.hypot(p.x - g.sx, p.y - g.sy) >= MOVE_THRESHOLD_PX;
      this.pushOverlay();
      return;
    }
    if (g.kind === 'marquee') {
      g.x1 = wx;
      g.y1 = wy;
      const r = { x: Math.min(g.x0, g.x1), y: Math.min(g.y0, g.y1), w: Math.abs(g.x1 - g.x0), h: Math.abs(g.y1 - g.y0) };
      const hit = new Set(g.base);
      for (const pl of this.placements.values()) if (intersects(pl, r)) hit.add(pl.id);
      for (const n of this.notes.values()) if (intersects({ x: n.x, y: n.y, w: n.w, h: this.noteHeight(n.id) }, r)) hit.add(n.id);
      setSelection([...hit]);
      this.pushOverlay();
      return;
    }
    if (g.kind === 'move') {
      if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) < MOVE_THRESHOLD_PX) return;
      if (!g.moved) {
        g.moved = true;
        engine.scrub(null);
        this.host.classList.add('moving');
      }
      let dx = wx - g.wx;
      let dy = wy - g.wy;
      if (useStore.getState().snap && !e.altKey) {
        dx = Math.round((g.bbox.x + dx) / SNAP) * SNAP - g.bbox.x;
        dy = Math.round((g.bbox.y + dy) / SNAP) * SNAP - g.bbox.y;
      }
      for (const [id, o] of g.originals) this.live.set(id, { ...o, x: o.x + dx, y: o.y + dy });
      this.pushItems();
      this.pushOverlay();
      return;
    }
    if (g.kind === 'resize') {
      const pts = corners(g.box);
      const [ax, ay] = pts[(g.corner + 2) % 4];
      const [cx, cy] = pts[g.corner];
      const dx = cx - ax;
      const dy = cy - ay;
      // Where the grabbed corner wants to be.
      const tx = wx + g.grab[0];
      const ty = wy + g.grab[1];
      // Scaling keeps the box's aspect, so the corner can only move along its
      // diagonal; put it at the point there nearest the pointer. Past the
      // anchor this goes negative and the minimum takes over.
      const s = ((tx - ax) * dx + (ty - ay) * dy) / (dx * dx + dy * dy);
      const sx = Math.max(g.free ? (tx - ax) / dx : s, g.minX);
      const sy = Math.max(g.free ? (ty - ay) / dy : s, g.minY);
      for (const [id, o] of g.originals) {
        this.live.set(id, { x: ax + (o.x - ax) * sx, y: ay + (o.y - ay) * sy, w: o.w * sx, h: o.h * sy });
      }
      this.pushItems();
      this.pushOverlay();
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    const g = this.gesture;
    if (!g || g.pointerId !== e.pointerId) return;
    this.gesture = null;
    this.host.classList.remove('panning', 'moving');
    if (this.host.hasPointerCapture(e.pointerId)) this.host.releasePointerCapture(e.pointerId);
    if (g.kind === 'move' && !g.moved) {
      // A click on one of several selected items selects just it.
      const hit = this.hitTest(this.local(e).x, this.local(e).y);
      const sel = useStore.getState().selection;
      if (hit && !e.shiftKey && !e.metaKey && !e.ctrlKey && sel.length > 1) setSelection([hit.id]);
    }
    if ((g.kind === 'move' && g.moved) || g.kind === 'resize') this.commitLive(g.kind === 'resize');
    if (g.kind === 'note' && e.type === 'pointerup') {
      this.setTool('select');
      if (g.dragged) {
        const x = Math.min(g.x0, g.x1);
        const y = Math.min(g.y0, g.y1);
        this.addNoteBox({ x, y }, { w: Math.max(MIN_NOTE_W, Math.abs(g.x1 - g.x0)), h: Math.max(MIN_NOTE_H, Math.abs(g.y1 - g.y0)) });
      } else this.placeNote(g.sx, g.sy);
    }
    if (g.kind === 'comment' && !g.moved && e.type === 'pointerup') this.cb.onComment?.(g.sx, g.sy, e.clientX, e.clientY);
    this.live.clear();
    this.sync();
    this.updateHover();
  };

  private onPointerLeave = () => {
    this.pointer = null;
    if (!this.gesture) this.setHover(null);
  };

  // Writes mid-gesture geometry back to the store as one undo step.
  // A move leaves notes' heights alone. A resize keeps a note's height only
  // if it made the box taller than its text; otherwise the box goes on
  // fitting its text.
  private commitLive(resized: boolean): void {
    const ps: Placement[] = [];
    const ns: Note[] = [];
    for (const [id, b] of this.live) {
      const p = this.placements.get(id);
      if (p) ps.push({ ...p, x: b.x, y: b.y, w: b.w, h: b.h });
      const n = this.notes.get(id);
      if (n) ns.push({ ...n, x: b.x, y: b.y, w: b.w, h: resized ? (b.h > this.textHeight(id) + 0.5 ? b.h : null) : n.h });
    }
    this.live.clear();
    savePlacements(this.collectionId, ps, ns);
    // The gesture set min-heights itself, and React won't clear a style its
    // props never changed.
    if (resized) {
      for (const n of ns) {
        const el = this.notesLayer.querySelector<HTMLElement>(`[data-note="${n.id}"]`);
        if (el) el.style.minHeight = n.h === null ? '' : `${n.h}px`;
      }
    }
  }

  private onDoubleClick = (e: MouseEvent) => {
    // Double-clicks inside a note being edited select words. The comment
    // tool's clicks each drop a pin.
    if ((e.target as HTMLElement).isContentEditable || this.tool === 'comment' || commentIdOf(e.target)) return;
    const p = this.local(e);
    // A press on a note captures the pointer, which retargets the dblclick
    // to the host, so find the note by position too.
    const noteId = noteIdOf(e.target) ?? this.noteAt(p.x, p.y);
    if (noteId) {
      if (!this.focusId && !this.readonly) this.cb.onEditNote(noteId);
      return;
    }
    const hit = this.hitTest(p.x, p.y);
    if (hit) {
      if (this.focusId === hit.id) this.exitFocus();
      else this.enterFocus(hit.id);
    } else if (!this.focusId && !this.readonly) this.placeNote(p.x, p.y);
  };

  // Adds an empty note at a pane-relative point and starts editing it.
  placeNote(sx: number, sy: number): void {
    const [wx, wy] = this.camera.toWorld(sx, sy);
    this.addNoteBox({ x: wx, y: wy });
  }

  private addNoteBox(at: { x: number; y: number }, size?: { w: number; h: number }): void {
    const n = addNote(this.collectionId, at, size);
    setSelection([n.id]);
    this.cb.onEditNote(n.id);
  }

  editNote(id: string): void {
    setSelection([id]);
    this.cb.onEditNote(id);
  }

  placeNoteAtClient(clientX: number, clientY: number): void {
    const p = this.local({ clientX, clientY });
    this.placeNote(p.x, p.y);
  }

  private onContextMenu = (e: MouseEvent) => {
    // Comment fields keep the browser's menu (paste).
    if (commentIdOf(e.target)) return;
    e.preventDefault();
    if (this.readonly) return;
    const p = this.local(e);
    const id = noteIdOf(e.target) ?? this.hitTest(p.x, p.y)?.id ?? null;
    if (id && !this.selection.has(id)) setSelection([id]);
    this.cb.onContextMenu(e.clientX, e.clientY, id);
  };

  private updateHover(): void {
    if (this.gesture || !this.pointer || this.focusId || this.tool !== 'select') {
      this.setHover(null);
      return;
    }
    const hit = this.hitTest(this.pointer.x, this.pointer.y);
    this.setHover(hit?.id ?? null);
    const corner = this.handleAt(this.pointer.x, this.pointer.y);
    this.host.dataset.handle = corner < 0 ? '' : String(corner % 2);
    if (hit && useStore.getState().scrubOnHover) {
      const [wx] = this.camera.toWorld(this.pointer.x, this.pointer.y);
      engine.scrub(hit.assetId, Math.min(0.9999, Math.max(0, (wx - hit.x) / hit.w)));
    } else engine.scrub(null);
  }

  private setHover(id: string | null): void {
    if (id === this.hover) return;
    this.hover = id;
    if (!id) engine.scrub(null);
    this.pushOverlay();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
    // Enter and Space activate a focused button.
    if (t instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return;
    const meta = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (this.readonly && (meta || ['delete', 'backspace', 'n', 't', 'i', 'o', '`'].includes(key))) return;
    if (this.readonly && key.startsWith('arrow')) {
      const step = e.shiftKey ? 400 : 100;
      this.camera.panBy(key === 'arrowleft' ? step : key === 'arrowright' ? -step : 0, key === 'arrowup' ? step : key === 'arrowdown' ? -step : 0);
      this.pushCamera();
      e.preventDefault();
      return;
    }
    if (meta && key === 'z') {
      if (e.shiftKey) redo(this.collectionId);
      else undo(this.collectionId);
    } else if (meta && key === 'y') redo(this.collectionId);
    else if (meta && key === 'a') setSelection([...this.placements.keys(), ...this.notes.keys()]);
    else if (meta && (key === 'b' || key === 'i' || key === 'u')) {
      const ids = [...this.selection].filter((id) => this.notes.has(id));
      if (!ids.length) return;
      toggleNoteFormat(this.collectionId, ids, key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline');
    } else if (meta) return;
    else if (key === 'delete' || key === 'backspace') this.deleteSelection();
    else if (key === 'enter' && this.selection.size === 1 && this.notes.has([...this.selection][0])) this.editNote([...this.selection][0]);
    else if (key === 'escape') {
      if (this.tool === 'comment') this.setTool('select');
      else if (this.focusId) this.exitFocus();
      else setSelection([]);
    } else if (key === 'c' && this.cb.onComment) this.setTool(this.tool === 'comment' ? 'select' : 'comment');
    else if (key.startsWith('arrow')) {
      const step = e.shiftKey ? 10 : 1;
      const dx = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
      const dy = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
      if (this.selection.size) this.nudge(dx, dy);
      else {
        this.camera.panBy(-dx * 40, -dy * 40);
        this.pushCamera();
      }
    } else if (key === 'f' || key === '0') this.fitAll();
    else if (key === '1') this.zoomTo(1);
    else if (key === '=' || key === '+') this.zoomBy(1.25);
    else if (key === '-') this.zoomBy(0.8);
    else if (key === 'v') this.setTool('select');
    else if (key === 'h') this.setTool('hand');
    else if (key === 'n' || key === 't') this.setTool('note');
    else if (key === '`') updatePrefs({ hud: !useStore.getState().hud });
    else if (key === 'i' && this.focusId) this.setRangeAtPlayhead('in');
    else if (key === 'o' && this.focusId) this.setRangeAtPlayhead('out');
    else if ((key === ',' || key === '.') && this.focusId) this.stepFocus(key === ',' ? -1 : 1);
    else return;
    e.preventDefault();
  };

  // ---- edits -------------------------------------------------------------------

  deleteSelection(): void {
    const ids = [...this.selection];
    if (this.focusId && ids.includes(this.focusId)) this.exitFocus();
    if (ids.length) deleteItems(this.collectionId, ids);
  }

  nudge(dx: number, dy: number): void {
    const ps: Placement[] = [];
    const ns: Note[] = [];
    for (const id of this.selection) {
      const p = this.placements.get(id);
      if (p) ps.push({ ...p, x: p.x + dx, y: p.y + dy });
      const n = this.notes.get(id);
      if (n) ns.push({ ...n, x: n.x + dx, y: n.y + dy });
    }
    savePlacements(this.collectionId, ps, ns);
  }

  arrangeSelection(mode: 'grid' | 'row'): void {
    const ps = [...this.selection].map((id) => this.placements.get(id)).filter((p): p is Placement => !!p);
    if (ps.length < 2) return;
    const next = arrange(ps, mode);
    savePlacements(this.collectionId, ps.map((p, i) => ({ ...p, ...next[i] })));
  }

  bringToFront(): void {
    let z = topZ(this.collectionId);
    const ps = [...this.selection]
      .map((id) => this.placements.get(id))
      .filter((p): p is Placement => !!p)
      .sort((a, b) => a.z - b.z)
      .map((p) => ({ ...p, z: ++z }));
    savePlacements(this.collectionId, ps);
  }

  sendToBack(): void {
    let z = Math.min(0, ...[...this.placements.values()].map((p) => p.z));
    const ps = [...this.selection]
      .map((id) => this.placements.get(id))
      .filter((p): p is Placement => !!p)
      .sort((a, b) => b.z - a.z)
      .map((p) => ({ ...p, z: --z }));
    savePlacements(this.collectionId, ps);
  }

  // Animates freshly added clips in from where they were dropped, selects
  // them, and pans to reveal them if they landed off screen.
  private flyIn(ids: string[], from: { x: number; y: number } | null): void {
    this.sync();
    const now = performance.now();
    for (const id of ids) {
      const p = this.placements.get(id);
      if (!p) continue;
      const o = from ?? { x: p.x + p.w / 2, y: p.y + p.h / 2 };
      this.flyIns.set(id, { from: { x: o.x - p.w * 0.3, y: o.y - p.h * 0.3, w: p.w * 0.6, h: p.h * 0.6 }, start: now });
    }
    setSelection(ids);
    cancelAnimationFrame(this.flyFrame);
    const tick = (t: number) => {
      for (const [id, f] of this.flyIns) if (t - f.start >= FLY_MS) this.flyIns.delete(id);
      this.pushItems();
      if (this.flyIns.size) this.flyFrame = requestAnimationFrame(tick);
    };
    this.flyFrame = requestAnimationFrame(tick);
    this.reveal(ids);
  }

  private reveal(ids: string[]): void {
    const b = bounds(ids.map((id) => this.placements.get(id)).filter((p): p is Placement => !!p));
    if (!b || this.size.w === 0) return;
    const z = this.camera.zoom;
    const view = { x: this.camera.x, y: this.camera.y, w: this.size.w / z, h: this.size.h / z };
    const margin = 40 / z;
    const inside = b.x >= view.x + margin && b.y >= view.y + margin && b.x + b.w <= view.x + view.w - margin && b.y + b.h <= view.y + view.h - margin;
    if (inside) return;
    const fit = fitRect(b, this.size.w, this.size.h, 80);
    const zoom = Math.min(z, fit.zoom);
    void this.animateTo({ zoom, x: b.x + b.w / 2 - this.size.w / 2 / zoom, y: b.y + b.h / 2 - this.size.h / 2 / zoom }, 450);
  }

  // ---- focus mode ----------------------------------------------------------------

  enterFocus(id: string): void {
    if (!this.placements.has(id)) return;
    if (!this.focusId) this.preFocusCamera = { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom };
    setSelection([id]);
    setFocus({ collectionId: this.collectionId, placementId: id, playing: true, speed: 1 });
  }

  exitFocus(): void {
    if (!this.focusId) return;
    setFocus(null);
  }

  // Mirrors store focus into the engine, the camera and the dimming.
  private syncFocus(): void {
    const f = useStore.getState().focus;
    const id = f && f.collectionId === this.collectionId && this.placements.has(f.placementId) ? f.placementId : null;
    const entering = id && id !== this.focusId;
    const leaving = !id && this.focusId;
    this.focusId = id;
    if (id && f) {
      engine.setFocus({ viewId: this.view.id, itemId: this.num(id), playing: f.playing, speed: f.speed });
      spaceTap.focus = () => {
        const cur = useStore.getState().focus;
        if (cur) setFocus({ ...cur, playing: !cur.playing });
      };
    } else {
      engine.setFocus(null);
      spaceTap.focus = null;
    }
    if (entering) {
      this.preFocusCamera ??= { x: this.camera.x, y: this.camera.y, zoom: this.camera.zoom };
      if (this.size.w > 0 && this.size.h > 0) this.frameFocused();
      else this.pendingFocusFrame = true;
    }
    if (leaving && this.preFocusCamera) {
      void this.animateTo(this.preFocusCamera, 380);
      this.preFocusCamera = null;
    }
    this.pushItems();
    this.pushOverlay();
  }

  // Fits the focused clip in the pane, leaving room for the focus bar.
  private frameFocused(): void {
    const p = this.focusId ? this.placements.get(this.focusId) : null;
    if (!p) return;
    // Leave room for the info panel too, when it's docked on the right.
    const w = Math.max(100, this.size.w - infoPanelInset(this.size.w));
    void this.animateTo(fitRect(p, w, Math.max(100, this.size.h - 110), 40), 420);
  }

  seekFocus(seconds: number): void {
    const f = useStore.getState().focus;
    if (!f || !this.focusId) return;
    engine.setFocus({ viewId: this.view.id, itemId: this.num(this.focusId), playing: f.playing, speed: f.speed, seek: seconds });
  }

  stepFocus(frames: number): void {
    const f = useStore.getState().focus;
    if (!f || !this.focusId) return;
    if (f.playing) setFocus({ ...f, playing: false });
    engine.setFocus({ viewId: this.view.id, itemId: this.num(this.focusId), playing: false, speed: f.speed, step: frames });
  }

  // Latest focus playhead (seconds), fed by the engine.
  focusTime = 0;

  setRange(inPoint: number | null, outPoint: number | null): void {
    if (this.readonly) return;
    const p = this.focusId ? this.placements.get(this.focusId) : null;
    if (!p) return;
    const a = useStore.getState().assets[p.assetId];
    const dur = a?.duration ?? 0;
    // Snap to frame boundaries so loops start on a whole frame.
    const frame = 1 / (a?.fps || 30);
    const snap = (t: number) => Math.round(t / frame) * frame;
    let i = inPoint === null ? null : Math.max(0, snap(inPoint));
    let o = outPoint === null ? null : Math.min(dur, snap(outPoint));
    if (i !== null && i <= 0.0005) i = null;
    if (o !== null && o >= dur - 0.0005) o = null;
    if (i !== null && o !== null && o - i < frame * 2) return;
    savePlacements(this.collectionId, [{ ...p, inPoint: i, outPoint: o }]);
  }

  private setRangeAtPlayhead(which: 'in' | 'out'): void {
    const p = this.focusId ? this.placements.get(this.focusId) : null;
    if (!p) return;
    if (which === 'in') this.setRange(this.focusTime, p.outPoint);
    else this.setRange(p.inPoint, this.focusTime);
  }

  focusedPlacement(): Placement | null {
    return this.focusId ? (this.placements.get(this.focusId) ?? null) : null;
  }

  placementById(id: string): Placement | undefined {
    return this.placements.get(id);
  }

  placementList(): Placement[] {
    return [...this.placements.values()];
  }

  // Where a comment dropped at a pane-relative point goes: the canvas point,
  // and the topmost clip there with the point's place on it.
  commentSpotAt(sx: number, sy: number): { x: number; y: number; placementId: string | null; px: number | null; py: number | null } {
    const [x, y] = this.camera.toWorld(sx, sy);
    const p = this.hitTest(sx, sy);
    if (!p) return { x, y, placementId: null, px: null, py: null };
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    return { x, y, placementId: p.id, px: clamp((x - p.x) / p.w), py: clamp((y - p.y) / p.h) };
  }
}

function noteIdOf(t: EventTarget | null): string | null {
  return (t instanceof Element && t.closest<HTMLElement>('[data-note]')?.dataset.note) || null;
}

function commentIdOf(t: EventTarget | null): string | null {
  return (t instanceof Element && t.closest<HTMLElement>('[data-comment]')?.dataset.comment) || null;
}

function corners(b: Rect): [number, number][] {
  return [
    [b.x, b.y],
    [b.x + b.w, b.y],
    [b.x + b.w, b.y + b.h],
    [b.x, b.y + b.h],
  ];
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
