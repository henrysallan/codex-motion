// Popovers and menus, rendered in a portal and positioned against an
// anchor element or a point (context menus). They close on Escape or a
// pointer press outside.

import { Check } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type Anchor = HTMLElement | { x: number; y: number };

export function Popover({
  anchor,
  onClose,
  children,
  align = 'start',
  width,
}: {
  anchor: Anchor;
  onClose: () => void;
  children: ReactNode;
  align?: 'start' | 'end';
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => {
      const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let left = align === 'end' ? r.right - w : r.left;
      let top = r.bottom + 6;
      if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
      left = Math.min(Math.max(8, left), innerWidth - w - 8);
      setPos({ left, top });
    };
    place();
    // Content that loads after opening can change the size.
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor, align]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const el = ref.current;
      if (!el || el.contains(e.target as Node)) return;
      if (anchor instanceof HTMLElement && anchor.contains(e.target as Node)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    // Capture so an outside press closes before it does anything else.
    addEventListener('pointerdown', down, true);
    addEventListener('keydown', key, true);
    return () => {
      removeEventListener('pointerdown', down, true);
      removeEventListener('keydown', key, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="popover"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  trail?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
}

// `content` is a custom row (a swatch picker); it stays open when used.
export type MenuEntry = MenuItem | 'separator' | { title: string } | { content: ReactNode };

export function Menu({ anchor, items, onClose, align, width }: { anchor: Anchor; items: MenuEntry[]; onClose: () => void; align?: 'start' | 'end'; width?: number }) {
  return (
    <Popover anchor={anchor} onClose={onClose} align={align} width={width}>
      <div role="menu">
        {items.map((item, i) => {
          if (item === 'separator') return <div key={i} className="menu-sep" />;
          if ('title' in item) return <div key={i} className="menu-title">{item.title}</div>;
          if ('content' in item) return <div key={i}>{item.content}</div>;
          return (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              className={`menu-item ${item.danger ? 'danger' : ''}`}
              onClick={() => {
                onClose();
                item.onSelect?.();
              }}
            >
              {item.icon && <span className="icon">{item.icon}</span>}
              <span className="label">{item.label}</span>
              {item.checked && (
                <span className="check">
                  <Check size={12} strokeWidth={3} />
                </span>
              )}
              {item.trail && <span className="trail">{item.trail}</span>}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

// State for a menu opened from a button or a right-click.
export function useMenu() {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  return {
    anchor,
    open: (a: Anchor) => setAnchor(a),
    close: () => setAnchor(null),
    toggle: (a: HTMLElement) => setAnchor((cur) => (cur ? null : a)),
  };
}
