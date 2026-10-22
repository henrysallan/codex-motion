// A vertically scrolling pane whose clips are drawn by the GPU and whose
// chrome (names, menus, selection rings) is DOM laid over them.
//
// Scrolling is virtual: wheel input moves one number, which both translates
// the DOM content and becomes the GPU view's camera, in the same frame. A
// native scroll container would scroll the DOM on the compositor while the
// GPU view followed a frame or two later, so covers would swim under their
// labels.

import { type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { OverlayRect, ViewItem } from '../engine/protocol.ts';
import { useEngineView } from './engine.ts';

export interface SurfaceHandle {
  scrollTop: number;
  // Content-space y of a client y.
  toContentY(clientY: number): number;
  scrollBy(dy: number): void;
}

export function ScrollSurface({
  items,
  contentHeight,
  overlay,
  onResize,
  handle,
  children,
  className = '',
  onPointerDown,
}: {
  items: ViewItem[];
  contentHeight: number;
  overlay?: OverlayRect[];
  onResize: (width: number, height: number) => void;
  handle?: RefObject<SurfaceHandle | null>;
  children: ReactNode;
  className?: string;
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const scroll = useRef(0);
  const viewport = useRef(0);
  const view = useEngineView(host, 'panel');
  const contentHeightRef = useRef(contentHeight);
  contentHeightRef.current = contentHeight;

  const apply = useCallback(() => {
    const h = viewport.current;
    const total = contentHeightRef.current;
    const max = Math.max(0, total - h);
    scroll.current = Math.min(max, Math.max(0, scroll.current));
    if (content.current) content.current.style.transform = `translate3d(0, ${-scroll.current}px, 0)`;
    view?.setCamera({ x: 0, y: scroll.current, zoom: 1 });
    const t = thumb.current;
    if (t) {
      const size = max > 0 ? Math.max(32, (h / total) * (h - 8)) : 0;
      t.style.height = `${size}px`;
      t.style.transform = `translateY(${max > 0 ? (scroll.current / max) * (h - 8 - size) : 0}px)`;
      t.hidden = max <= 0;
    }
  }, [view]);

  useLayoutEffect(apply, [apply, contentHeight]);

  useEffect(() => {
    view?.setItems(items);
  }, [view, items]);

  useEffect(() => {
    view?.setOverlay(overlay ?? []);
  }, [view, overlay]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      viewport.current = entry.contentRect.height;
      onResize(entry.contentRect.width, entry.contentRect.height);
      apply();
    });
    ro.observe(el);
    // React's wheel listener is passive, so it can't stop the page scrolling.
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      scroll.current += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      apply();
      thumb.current?.classList.add('active');
      clearTimeout(fade);
      fade = setTimeout(() => thumb.current?.classList.remove('active'), 700);
    };
    let fade: ReturnType<typeof setTimeout>;
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('wheel', wheel);
    };
  }, [apply, onResize]);

  useEffect(() => {
    if (!handle) return;
    handle.current = {
      get scrollTop() {
        return scroll.current;
      },
      toContentY: (clientY: number) => clientY - (host.current?.getBoundingClientRect().top ?? 0) + scroll.current,
      scrollBy: (dy: number) => {
        scroll.current += dy;
        apply();
      },
    };
  }, [handle, apply]);

  return (
    <div className={`surface ${className}`} ref={host} onPointerDown={onPointerDown}>
      <div className="surface-content" ref={content} style={{ height: contentHeight }}>
        {children}
      </div>
      <div className="scrollbar" ref={thumb} />
    </div>
  );
}

// Crop that makes a clip of `aspect` fill a box of `boxAspect` (CSS
// object-fit: cover).
export function coverCrop(aspect: number, boxAspect: number): [number, number, number, number] {
  if (aspect > boxAspect) {
    const w = boxAspect / aspect;
    return [(1 - w) / 2, 0, (1 + w) / 2, 1];
  }
  const h = aspect / boxAspect;
  return [0, (1 - h) / 2, 1, (1 + h) / 2];
}

// Hover scrub helper: the fraction across an element under the pointer.
export function fractionAcross(e: React.PointerEvent<HTMLElement>): number {
  const r = e.currentTarget.getBoundingClientRect();
  return Math.min(0.9999, Math.max(0, (e.clientX - r.left) / r.width));
}
