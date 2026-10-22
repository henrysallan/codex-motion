// Transient confirmations ("Added 3 clips to Sample board"), with an
// optional action. Stacked bottom-centre, gone after a few seconds.

import { X } from 'lucide-react';
import { create } from 'zustand';

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}

const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));
let nextId = 1;

export function toast(text: string, action?: Toast['action']): void {
  const t = { id: nextId++, text, action };
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-2), t] }));
  setTimeout(() => dismiss(t.id), 4000);
}

function dismiss(id: number): void {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast">
          <span>{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
