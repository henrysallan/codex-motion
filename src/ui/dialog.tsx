// A modal dialog over a dimmed backdrop, rendered in a portal. Closes on
// Escape, its close button or a press on the backdrop. Keys pressed in it
// stay in it, so the canvas's and the Feed's shortcuts don't fire behind it.

import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './controls.tsx';

export function Dialog({ title, onClose, children, width = 400 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return createPortal(
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ width }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
        }}
      >
        <header className="dialog-head">
          <h2>{title}</h2>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X size={14} />
          </IconButton>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
