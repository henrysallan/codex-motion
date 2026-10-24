// The Feed: the shared library as a grid of autoplaying tiles in a seeded
// shuffle (scrolling back shows the same order; reshuffle draws a new one).
// Select clips (click, shift-click, cmd-click, marquee) and add them to the
// active target, pick a collection, or drag them onto the open canvas.
// Double-click a tile for its details (src/app/detail). The search bar at
// the top narrows and reorders the tiles (FeedSearch.tsx, src/search).
// With dev tools on (src/app/devtools.ts), right-clicking a selection can
// delete it from the database.
//
// The library runs to thousands of clips, so only tiles near the viewport
// are mounted, and the engine gets items for a wider band: it loads sprites
// two viewports either side of the visible area, and needs the items to.

import { Check, Copy, Crosshair, EyeOff, FolderPlus, Plus, Search, SearchX, Shuffle, Sparkles, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssetRecord } from '../../data/model.ts';
import type { OverlayRect, ViewItem } from '../../engine/protocol.ts';
import { useFeedSearch, useSearch } from '../../search/client.ts';
import { uploadDoc } from '../../search/docs.ts';
import type { PoolItem } from '../../search/engine.ts';
import { Button, IconButton } from '../../ui/controls.tsx';
import { Menu, Popover, useMenu } from '../../ui/popover.tsx';
import { engine } from '../engine.ts';
import { addAssets } from '../actions.ts';
import { removeFromLibrary, useDevToolsOn } from '../devtools.ts';
import { type DropTarget, dropTargets } from '../events.ts';
import { plural } from '../format.ts';
import { justifiedRows } from '../layout/arrange.ts';
import { fractionAcross, rowsInBand, ScrollSurface, type ScrollWindow, type SurfaceHandle } from '../ScrollSurface.tsx';
import {
  collectedAssetIds,
  createCollection,
  openCollection,
  setFeedQuery,
  setFeedSelection,
  shuffled,
  updatePrefs,
  useStore,
} from '../store.ts';
import { useResolvedTheme } from '../theme.ts';
import { overlayColors } from '../theme.ts';
import { openDetail } from '../detail/state.ts';
import { toast } from '../toasts.tsx';
import { fuzzStop, isSearching, SearchBar, SearchPanel } from './FeedSearch.tsx';

const PAD = 12;
const GAP = 6;
const ROW_H = 120;
const DRAG_THRESHOLD = 5;
// Viewports beyond the visible band to mount tiles for, and to send the
// engine items for (at least its sprite residency, RESIDENT_VIEWPORTS).
const DOM_OVERSCAN = 0.5;
const ENGINE_OVERSCAN = 2.5;

interface Tile {
  asset: AssetRecord;
  x: number;
  y: number;
  w: number;
  h: number;
}

// Tiles [start, end) within `overscan` viewports of the visible band.
function nearViewport(tiles: Tile[], win: ScrollWindow | null, overscan: number): [number, number] {
  return win ? rowsInBand(tiles, win.top - overscan * win.height, win.bottom + overscan * win.height) : [0, 0];
}

export function FeedPane() {
  const assets = useStore((s) => s.assets);
  const placements = useStore((s) => s.placements);
  const seed = useStore((s) => s.feedSeed);
  const hideAdded = useStore((s) => s.feedHideAdded);
  const selection = useStore((s) => s.feedSelection);
  const target = useStore((s) => (s.user.activeTargetId ? s.collections[s.user.activeTargetId] : null));
  const theme = useResolvedTheme();
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onResize = useCallback((w: number, h: number) => setSize((s) => (s.w === w && s.h === h ? s : { w, h })), []);
  const [win, setWin] = useState<ScrollWindow | null>(null);
  const surface = useRef<SurfaceHandle | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const anchorRef = useRef<number | null>(null);
  const devTools = useDevToolsOn();
  const devMenu = useMenu();
  const [devIds, setDevIds] = useState<string[]>([]);

  const collected = useMemo(() => collectedAssetIds(placements), [placements]);
  // Uploads only once their uploader shares them.
  const order = useMemo(() => shuffled(Object.values(assets).filter((a) => a.status === 'ready' && (a.origin !== 'upload' || a.inFeed)), seed), [assets, seed]);

  // Search runs in a worker over the shuffled pool. With no search (and the
  // default order) the Feed doesn't wait for it.
  const query = useStore((s) => s.feedQuery);
  const searchOpen = useStore((s) => s.feedSearchOpen);
  const pool = useMemo<PoolItem[]>(
    () =>
      order.map((a) => {
        const added = Math.round(a.addedAt / 1000);
        const name = a.sourceTitle ?? a.name;
        // The index bundle covers the library; shared uploads bring their own doc.
        return { id: a.id, name, width: a.width, height: a.height, duration: a.duration, added, ...(a.origin === 'upload' ? { extra: uploadDoc(a, added, a.name) } : {}) };
      }),
    [order],
  );
  const exclude = useMemo(() => (hideAdded ? [...collected] : null), [hideAdded, collected]);
  useFeedSearch(pool, query, exclude);
  const result = useSearch((s) => s.result);
  const searching = isSearching(query);
  const visible = useMemo(() => {
    if ((searching || query.sort === 'newest') && result) return result.ids.map((id) => assets[id]).filter((a): a is AssetRecord => !!a);
    return hideAdded ? order.filter((a) => !collected.has(a.id)) : order;
  }, [searching, query.sort, result, assets, order, hideAdded, collected]);

  const { tiles, height } = useMemo(() => {
    const width = Math.max(0, size.w - PAD * 2);
    if (width <= 0) return { tiles: [] as Tile[], height: 0 };
    const boxes = justifiedRows(visible.map((a) => a.width / a.height), width, ROW_H, GAP);
    const tiles = boxes.map((b, i) => ({ asset: visible[i], x: b.x + PAD, y: b.y + 2, w: b.w, h: b.h }));
    const last = boxes[boxes.length - 1];
    return { tiles, height: last ? last.y + last.h + 2 + PAD : 0 };
  }, [visible, size.w]);

  const [domStart, domEnd] = useMemo(() => nearViewport(tiles, win, DOM_OVERSCAN), [tiles, win]);
  const items = useMemo<ViewItem[]>(() => {
    const [start, end] = nearViewport(tiles, win, ENGINE_OVERSCAN);
    const out: ViewItem[] = [];
    for (let i = start; i < end; i++) {
      const t = tiles[i];
      out.push({ id: i + 1, assetId: t.asset.id, x: t.x, y: t.y, w: t.w, h: t.h, z: i });
    }
    return out;
  }, [tiles, win]);

  const selected = useMemo(() => new Set(selection), [selection]);
  const overlay = useMemo<OverlayRect[]>(() => {
    const accent = overlayColors[theme].accent;
    const rects: OverlayRect[] = [];
    if (marquee) {
      rects.push({
        x: Math.min(marquee.x0, marquee.x1),
        y: Math.min(marquee.y0, marquee.y1),
        w: Math.abs(marquee.x1 - marquee.x0),
        h: Math.abs(marquee.y1 - marquee.y0),
        space: 'world',
        fill: [...accent, 0.08],
        stroke: [...accent, 0.7],
        strokeWidth: 1,
        radius: 2,
      });
    }
    return rects;
  }, [marquee, theme]);

  const select = (ids: string[]) => setFeedSelection(ids);

  // A new search starts at the top.
  useEffect(() => {
    const s = surface.current;
    if (s?.scrollTop) s.scrollBy(-s.scrollTop);
  }, [query]);

  const nameOf = useCallback((id: string) => assets[id]?.sourceTitle ?? assets[id]?.name ?? 'clip', [assets]);

  const onTileDown = (e: React.PointerEvent<HTMLDivElement>, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const id = tiles[index].asset.id;
    let next = selection;
    if (e.shiftKey && anchorRef.current !== null) {
      const [a, b] = [anchorRef.current, index].sort((x, y) => x - y);
      next = [...new Set([...selection, ...tiles.slice(a, b + 1).map((t) => t.asset.id)])];
    } else if (e.metaKey || e.ctrlKey) {
      next = selected.has(id) ? selection.filter((x) => x !== id) : [...selection, id];
      anchorRef.current = index;
    } else if (!selected.has(id)) {
      next = [id];
      anchorRef.current = index;
    }
    select(next);

    // Dragging a selection out of the Feed carries it onto the canvas.
    const startX = e.clientX;
    const startY = e.clientY;
    let ghost: HTMLDivElement | null = null;
    let over: DropTarget | null = null;
    const ids = next.includes(id) ? next : [id];
    const move = (ev: PointerEvent) => {
      if (!ghost && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.textContent = plural(ids.length, 'clip');
        document.body.append(ghost);
        document.body.classList.add('dragging-clips');
        engine.scrub(null);
      }
      ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
      const hit = [...dropTargets].find((t) => t.accepts(ev.clientX, ev.clientY)) ?? null;
      if (over && over !== hit) over.hover?.(ev.clientX, ev.clientY, false);
      over = hit;
      over?.hover?.(ev.clientX, ev.clientY, true);
    };
    const up = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (!ghost) {
        // A plain click on an already-selected tile selects just it.
        if (!e.shiftKey && !e.metaKey && !e.ctrlKey && selected.has(id) && selection.length > 1) select([id]);
        return;
      }
      ghost.remove();
      document.body.classList.remove('dragging-clips');
      over?.hover?.(ev.clientX, ev.clientY, false);
      over?.drop(ids, ev.clientX, ev.clientY);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  // Marquee on the gaps between tiles.
  const onBackgroundDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !surface.current) return;
    const s = surface.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const x0 = e.clientX - rect.left;
    const y0 = s.toContentY(e.clientY);
    const base = e.shiftKey || e.metaKey ? selection : [];
    setMarquee({ x0, y0, x1: x0, y1: y0 });
    if (!e.shiftKey && !e.metaKey) select([]);
    const move = (ev: PointerEvent) => {
      const x1 = ev.clientX - rect.left;
      const y1 = s.toContentY(ev.clientY);
      setMarquee({ x0, y0, x1, y1 });
      const [l, r] = [Math.min(x0, x1), Math.max(x0, x1)];
      const [t, b] = [Math.min(y0, y1), Math.max(y0, y1)];
      const hit = tiles.filter((tile) => tile.x < r && tile.x + tile.w > l && tile.y < b && tile.y + tile.h > t).map((tile) => tile.asset.id);
      select([...new Set([...base, ...hit])]);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      setMarquee(null);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  // Right-clicking a clip outside the selection acts on that clip alone.
  const onTileMenu = (e: React.MouseEvent, index: number) => {
    if (!devTools) return;
    e.preventDefault();
    const id = tiles[index].asset.id;
    const ids = selected.has(id) ? selection : [id];
    if (!selected.has(id)) {
      select(ids);
      anchorRef.current = index;
    }
    setDevIds(ids);
    devMenu.open({ x: e.clientX, y: e.clientY });
  };

  const copyIds = (ids: string[]) =>
    navigator.clipboard.writeText(ids.join('\n')).then(
      () => toast(`Copied ${ids.length === 1 ? 'its ID' : `${ids.length} IDs`}`),
      () => toast('Couldn’t copy to the clipboard'),
    );

  const removeClips = async (ids: string[]) => {
    const one = ids.length === 1;
    const what = one ? `“${nameOf(ids[0])}”` : plural(ids.length, 'clip');
    if (!confirm(`Delete ${what} from the database? ${one ? 'It comes' : 'They come'} out of the Feed and off every board that has ${one ? 'it' : 'them'}, for everyone, and ${one ? 'its' : 'their'} files are deleted. This can’t be undone.`)) return;
    try {
      const r = await removeFromLibrary(ids);
      const missed = ids.length - r.removed;
      toast(`Deleted ${plural(r.removed, 'clip')}${r.boards ? ` (off ${plural(r.boards, 'board')})` : ''}${missed ? `; ${missed} ${missed === 1 ? 'wasn’t' : 'weren’t'} in the database` : ''}`);
    } catch (e) {
      toast(`Couldn’t delete: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const addSelection = (anchor: HTMLElement) => {
    if (target) {
      addAssets(target.id, selection);
      select([]);
    } else setAddAnchor(anchor);
  };

  return (
    <div className="feed">
      <header className="pane-head feed-head">
        <SearchBar result={result} count={visible.length} names={nameOf} />
        <div className="actions">
          <IconButton label="Hide clips already in a collection" pressed={hideAdded} onClick={() => updatePrefs({ feedHideAdded: !hideAdded })}>
            <EyeOff size={15} />
          </IconButton>
          <IconButton label="Reshuffle" onClick={() => updatePrefs({ feedSeed: Math.floor(Math.random() * 1e9) })}>
            <Shuffle size={15} />
          </IconButton>
        </div>
      </header>
      {searchOpen && <SearchPanel result={result} />}
      <div className="pane-toolbar feed-toolbar">
        {selection.length > 0 ? (
          <>
            <span className="selection-count">{plural(selection.length, 'clip')} selected</span>
            <IconButton label="Clear selection" size="sm" onClick={() => select([])}>
              <X size={15} />
            </IconButton>
            <Button size="sm" variant="ghost" title="Find clips that look like these" onClick={() => setFeedQuery({ similar: selection.slice(0, 12) })}>
              <Sparkles size={13} />
              Similar
            </Button>
            <Button variant="primary" size="sm" className="add-btn" onClick={(e) => addSelection(e.currentTarget)}>
              {target ? <Crosshair size={14} strokeWidth={2.4} /> : <Plus size={15} strokeWidth={2.4} />}
              {target ? `Add to ${target.name}` : 'Add to…'}
            </Button>
          </>
        ) : (
          <span className="hint">
            {target ? (
              <>
                Adding to <strong>{target.name}</strong> · select clips or drag them onto the canvas
              </>
            ) : (
              'Select clips to add them to a collection, or drag them onto the canvas'
            )}
          </span>
        )}
      </div>
      {searching && result && visible.length === 0 && (
        <div className="feed-empty">
          <SearchX size={18} />
          <p>No clips match{query.fuzziness < 1 ? ` at “${fuzzStop(query.fuzziness).label}”` : ''}.</p>
          <div className="row">
            {query.fuzziness < 1 && (query.text.trim() || query.similar.length > 0) && (
              <Button size="sm" onClick={() => setFeedQuery({ fuzziness: Math.min(1, query.fuzziness + 0.25) })}>
                Loosen
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setFeedQuery({ text: '', filters: {}, similar: [] })}>
              Clear search
            </Button>
          </div>
        </div>
      )}
      <ScrollSurface items={items} overlay={overlay} contentHeight={height} onResize={onResize} onWindow={setWin} handle={surface} onPointerDown={onBackgroundDown}>
        {tiles.slice(domStart, domEnd).map((t, k) => {
          const i = domStart + k;
          return (
            <div
              key={t.asset.id}
              className={`feed-tile ${selected.has(t.asset.id) ? 'selected' : ''}`}
              style={{ left: t.x, top: t.y, width: t.w, height: t.h }}
              onPointerDown={(e) => onTileDown(e, i)}
              onContextMenu={(e) => onTileMenu(e, i)}
              onPointerMove={(e) => engine.scrub(t.asset.id, fractionAcross(e))}
              onPointerLeave={() => engine.scrub(null)}
              onDoubleClick={() => openDetail(t.asset.id, tiles.map((x) => x.asset.id))}
            >
              {collected.has(t.asset.id) && (
                <span className="added-mark" title="In a collection">
                  <Check size={11} strokeWidth={3} />
                </span>
              )}
              <span className="tile-name">{t.asset.name}</span>
            </div>
          );
        })}
      </ScrollSurface>
      {addAnchor && <AddToPopover anchor={addAnchor} assetIds={selection} onClose={() => setAddAnchor(null)} onAdded={() => select([])} />}
      {devMenu.anchor && (
        <Menu
          anchor={devMenu.anchor}
          onClose={devMenu.close}
          items={[
            { title: `Dev tools · ${plural(devIds.length, 'clip')}` },
            { label: devIds.length === 1 ? 'Copy ID' : 'Copy IDs', icon: <Copy size={14} />, onSelect: () => void copyIds(devIds) },
            'separator',
            { label: 'Delete from database…', icon: <Trash2 size={14} />, danger: true, onSelect: () => void removeClips(devIds) },
          ]}
        />
      )}
    </div>
  );
}

// "Add to": suggested collections (most recently touched first), search,
// and New collection.
export function AddToPopover({ anchor, assetIds, onClose, onAdded }: { anchor: HTMLElement; assetIds: string[]; onClose: () => void; onAdded: () => void }) {
  const collections = useStore((s) => s.collections);
  const [q, setQ] = useState('');
  const list = Object.values(collections)
    .filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8);
  const add = (id: string) => {
    addAssets(id, assetIds);
    onAdded();
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} align="end" width={280}>
      <label className="search popover-search">
        <Search size={15} />
        <input autoFocus placeholder="Find a collection" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && list[0] && add(list[0].id)} />
      </label>
      <div className="menu-title">{q ? 'Matches' : 'Suggested'}</div>
      {list.map((c) => (
        <button key={c.id} type="button" className="menu-item" onClick={() => add(c.id)}>
          <span className="label">{c.name}</span>
        </button>
      ))}
      <div className="menu-sep" />
      <button
        type="button"
        className="menu-item"
        onClick={() => {
          const id = createCollection(q.trim() || 'Untitled collection');
          add(id);
          openCollection(id);
        }}
      >
        <span className="icon">
          <FolderPlus size={15} />
        </span>
        <span className="label">{q.trim() ? `New collection “${q.trim()}”` : 'New collection'}</span>
      </button>
    </Popover>
  );
}
