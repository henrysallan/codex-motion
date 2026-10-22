// Up to three panes side by side, always in the order Collections, Feed,
// Canvas. The rightmost pane flexes; the others have widths the user drags
// and that persist. With nothing toggled and no tab open, an empty state.

import { LayoutGrid } from 'lucide-react';
import { Fragment, useRef } from 'react';
import { EmptyState } from '../ui/controls.tsx';
import { CanvasPane } from './canvas/CanvasPane.tsx';
import { CollectionsPane } from './collections/CollectionsPane.tsx';
import { FeedPane } from './feed/FeedPane.tsx';
import { setPaneWidth, useStore } from './store.ts';

type PaneKey = 'collections' | 'feed' | 'canvas';
const MIN_WIDTH = 300;

export function Workspace() {
  const panes = useStore((s) => s.panes);
  const activeTab = useStore((s) => s.activeTab);
  const widths = useStore((s) => s.widths);
  const ref = useRef<HTMLDivElement>(null);

  const order: PaneKey[] = [];
  if (panes.collections) order.push('collections');
  if (panes.feed) order.push('feed');
  if (activeTab) order.push('canvas');

  if (order.length === 0) {
    return (
      <main className="workspace empty">
        <EmptyState icon={<LayoutGrid size={22} />} title="Nothing open">
          Turn on Collections or Feed in the pill above, or open a collection.
        </EmptyState>
      </main>
    );
  }

  const startResize = (pane: 'collections' | 'feed', e: React.PointerEvent) => {
    const el = ref.current;
    const paneEl = el?.querySelector<HTMLElement>(`[data-pane="${pane}"]`);
    if (!el || !paneEl) return;
    e.preventDefault();
    const startX = e.clientX;
    const startW = paneEl.getBoundingClientRect().width;
    // Leave every pane to the right at least its minimum.
    const right = order.length - order.indexOf(pane) - 1;
    const others = order.filter((p) => p !== pane && p !== order[order.length - 1]).reduce((s, p) => s + (p === 'canvas' ? 0 : widths[p]), 0);
    const max = el.clientWidth - others - right * MIN_WIDTH;
    const move = (ev: PointerEvent) => setPaneWidth(pane, Math.max(MIN_WIDTH, Math.min(max, startW + ev.clientX - startX)));
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    document.body.classList.add('resizing');
  };

  return (
    <main className="workspace" ref={ref}>
      {order.map((p, i) => {
        const last = i === order.length - 1;
        // Fixed panes keep their dragged width but give way (down to a
        // minimum) when the window is too narrow for everything.
        const style = last || p === 'canvas' ? { flex: '1 1 0', minWidth: 260 } : { flex: `0 1 ${widths[p]}px`, minWidth: 220 };
        return (
          <Fragment key={p}>
            <section className={`pane pane-${p}`} data-pane={p} style={style}>
              {p === 'collections' && <CollectionsPane />}
              {p === 'feed' && <FeedPane />}
              {p === 'canvas' && <CanvasPane key={activeTab} collectionId={activeTab!} />}
            </section>
            {!last && (
              <div
                className="divider"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={(e) => startResize(p as 'collections' | 'feed', e)}
              />
            )}
          </Fragment>
        );
      })}
    </main>
  );
}
