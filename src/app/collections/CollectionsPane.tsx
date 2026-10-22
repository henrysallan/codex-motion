// The Collections pane: every collection as a grid of animated covers or a
// list, with search and sort. Opening one adds (or focuses) its tab; any
// one can be the active target for clips added from the Feed.

import { ArrowUpDown, Crosshair, FolderOpen, ImageOff, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { Collection } from '../../data/model.ts';
import type { ViewItem } from '../../engine/protocol.ts';
import { Avatar, Button, EmptyState, IconButton, SearchField, UnderlineTabs } from '../../ui/controls.tsx';
import { Menu, useMenu } from '../../ui/popover.tsx';
import { engine } from '../engine.ts';
import { plural, timeAgo } from '../format.ts';
import { coverCrop, fractionAcross, ScrollSurface } from '../ScrollSurface.tsx';
import {
  type CollectionsSort,
  coverAssetOf,
  createCollection,
  deleteCollection,
  openCollection,
  renameCollection,
  setActiveTarget,
  updatePrefs,
  useStore,
} from '../store.ts';

const PAD = 16;
const GAP_X = 12;
const GAP_Y = 12;
const MIN_CARD = 160;
const COVER_ASPECT = 16 / 10;
const META_H = 44;
const ROW_H = 46;
const LIST_HEAD = 30;
const THUMB_W = 52;
const THUMB_H = 32;

interface Card {
  c: Collection;
  count: number;
  coverAssetId: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  // Cover box in content coordinates.
  cover: { x: number; y: number; w: number; h: number };
}

export function CollectionsPane() {
  const collections = useStore((s) => s.collections);
  const placements = useStore((s) => s.placements);
  const assets = useStore((s) => s.assets);
  const mode = useStore((s) => s.collectionsView);
  const sort = useStore((s) => s.collectionsSort);
  const user = useStore((s) => s.user);
  const activeTab = useStore((s) => s.activeTab);
  const [query, setQuery] = useState('');
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onResize = useCallback((w: number, h: number) => setSize((s) => (s.w === w && s.h === h ? s : { w, h })), []);
  const sortMenu = useMenu();
  const [renaming, setRenaming] = useState<string | null>(null);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of Object.values(placements)) m.set(p.collectionId, (m.get(p.collectionId) ?? 0) + 1);
    return m;
  }, [placements]);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const xs = Object.values(collections).filter((c) => !q || c.name.toLowerCase().includes(q));
    const by: Record<CollectionsSort, (a: Collection, b: Collection) => number> = {
      updated: (a, b) => b.updatedAt - a.updatedAt,
      name: (a, b) => a.name.localeCompare(b.name),
      items: (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0),
    };
    return xs.sort(by[sort]);
  }, [collections, query, sort, counts]);

  const { cards, height } = useMemo(() => {
    const out: Card[] = [];
    const inner = Math.max(0, size.w - PAD * 2);
    if (mode === 'grid') {
      const cols = Math.max(1, Math.floor((inner + GAP_X) / (MIN_CARD + GAP_X)));
      const w = (inner - GAP_X * (cols - 1)) / cols;
      const coverH = w / COVER_ASPECT;
      list.forEach((c, i) => {
        const x = PAD + (i % cols) * (w + GAP_X);
        const y = 2 + Math.floor(i / cols) * (coverH + META_H + GAP_Y);
        out.push({ c, count: counts.get(c.id) ?? 0, coverAssetId: coverAssetOf(c, placements), x, y, w, h: coverH + META_H, cover: { x, y, w, h: coverH } });
      });
      const rows = Math.ceil(list.length / cols);
      return { cards: out, height: 2 + rows * (coverH + META_H + GAP_Y) + PAD };
    }
    list.forEach((c, i) => {
      const y = LIST_HEAD + i * ROW_H;
      out.push({
        c,
        count: counts.get(c.id) ?? 0,
        coverAssetId: coverAssetOf(c, placements),
        x: PAD,
        y,
        w: inner,
        h: ROW_H,
        cover: { x: PAD + 4, y: y + (ROW_H - THUMB_H) / 2, w: THUMB_W, h: THUMB_H },
      });
    });
    return { cards: out, height: LIST_HEAD + list.length * ROW_H + PAD };
  }, [list, mode, size.w, counts, placements]);

  const items = useMemo<ViewItem[]>(() => {
    const out: ViewItem[] = [];
    cards.forEach((card, i) => {
      const a = card.coverAssetId ? assets[card.coverAssetId] : null;
      if (!a) return;
      const b = card.cover;
      out.push({ id: i + 1, assetId: a.id, x: b.x, y: b.y, w: b.w, h: b.h, z: i, crop: coverCrop(a.width / a.height, b.w / b.h) });
    });
    return out;
  }, [cards, assets]);

  return (
    <div className="collections">
      <header className="pane-head">
        <h1>
          Collections<span className="count">{Object.keys(collections).length}</span>
        </h1>
        <div className="actions">
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              const id = createCollection();
              setRenaming(id);
            }}
          >
            <Plus size={15} strokeWidth={2.4} />
            New
          </Button>
        </div>
      </header>
      <div className="pane-tabs">
        <UnderlineTabs
          value={mode}
          onChange={(v) => updatePrefs({ collectionsView: v })}
          options={[
            { value: 'grid', label: 'Grid view' },
            { value: 'list', label: 'List view' },
          ]}
        />
      </div>
      <div className="pane-toolbar">
        <SearchField value={query} onChange={setQuery} placeholder="Search collections" />
        <Button size="md" onClick={(e) => sortMenu.toggle(e.currentTarget)}>
          <ArrowUpDown size={15} />
          Sort
        </Button>
        {sortMenu.anchor && (
          <Menu
            anchor={sortMenu.anchor}
            align="end"
            onClose={sortMenu.close}
            items={[
              { title: 'Sort by' },
              { label: 'Last updated', checked: sort === 'updated', onSelect: () => updatePrefs({ collectionsSort: 'updated' }) },
              { label: 'Name', checked: sort === 'name', onSelect: () => updatePrefs({ collectionsSort: 'name' }) },
              { label: 'Item count', checked: sort === 'items', onSelect: () => updatePrefs({ collectionsSort: 'items' }) },
            ]}
          />
        )}
      </div>
      <ScrollSurface items={items} contentHeight={height} onResize={onResize}>
        {mode === 'list' && cards.length > 0 && (
          <div className="list-head" style={{ left: PAD, width: Math.max(0, size.w - PAD * 2) }}>
            <span className="col-name">Name</span>
            <span className="col-items">Items</span>
            <span className="col-owner">Owner</span>
            <span className="col-updated">Updated</span>
          </div>
        )}
        {cards.map((card) => (
          <CollectionEntry
            key={card.c.id}
            card={card}
            mode={mode}
            open={activeTab === card.c.id}
            target={user.activeTargetId === card.c.id}
            ownerName={user.name}
            ownerColor={user.color}
            renaming={renaming === card.c.id}
            onRenamed={() => setRenaming(null)}
            onRename={() => setRenaming(card.c.id)}
          />
        ))}
        {list.length === 0 && (
          <div className="surface-empty" style={{ height: Math.max(240, size.h) }}>
            {query ? (
              <EmptyState icon={<FolderOpen size={22} />} title="No matches">
                Nothing is called “{query}”.
              </EmptyState>
            ) : (
              <EmptyState icon={<FolderOpen size={22} />} title="No collections yet" action={<Button variant="primary" onClick={() => setRenaming(createCollection())}>New collection</Button>}>
                A collection is a board of reference for one project.
              </EmptyState>
            )}
          </div>
        )}
      </ScrollSurface>
    </div>
  );
}

function CollectionEntry({
  card,
  mode,
  open,
  target,
  ownerName,
  ownerColor,
  renaming,
  onRename,
  onRenamed,
}: {
  card: Card;
  mode: 'grid' | 'list';
  open: boolean;
  target: boolean;
  ownerName: string;
  ownerColor: string;
  renaming: boolean;
  onRename: () => void;
  onRenamed: () => void;
}) {
  const { c, count, cover } = card;
  const menu = useMenu();
  const scrub = (e: React.PointerEvent<HTMLElement>) => card.coverAssetId && engine.scrub(card.coverAssetId, fractionAcross(e));
  const unscrub = () => engine.scrub(null);
  const name = renaming ? (
    <input
      className="rename"
      autoFocus
      defaultValue={c.name}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        renameCollection(c.id, e.currentTarget.value);
        onRenamed();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = c.name;
          e.currentTarget.blur();
        }
      }}
    />
  ) : (
    <span className="name" onDoubleClick={(e) => (e.stopPropagation(), onRename())}>
      {c.name}
    </span>
  );
  const menuItems = [
    { label: 'Open', icon: <FolderOpen size={15} />, onSelect: () => openCollection(c.id) },
    { label: target ? 'Clear active target' : 'Set as active target', icon: <Crosshair size={15} />, onSelect: () => setActiveTarget(target ? null : c.id) },
    { label: 'Rename', icon: <Pencil size={15} />, onSelect: onRename },
    'separator' as const,
    { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onSelect: () => confirm(`Delete “${c.name}”? Its clips stay in the library.`) && deleteCollection(c.id) },
  ];
  const more = (
    <IconButton
      label="More"
      size="sm"
      className="more"
      onClick={(e) => {
        e.stopPropagation();
        menu.toggle(e.currentTarget);
      }}
    >
      <MoreHorizontal size={14} />
    </IconButton>
  );

  return (
    <>
    <div
      className={`collection ${mode} ${open ? 'open' : ''}`}
      style={{ left: card.x, top: card.y, width: card.w, height: card.h }}
      onClick={() => !renaming && openCollection(c.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        menu.open({ x: e.clientX, y: e.clientY });
      }}
    >
      {mode === 'grid' ? (
        <>
          <div className="cover" style={{ height: cover.h }} onPointerMove={scrub} onPointerLeave={unscrub}>
            {!card.coverAssetId && <ImageOff size={22} className="cover-empty" />}
            {target && (
              <span className="badge green target-badge">
                <Crosshair size={12} strokeWidth={2.4} />
                Active target
              </span>
            )}
          </div>
          <div className="meta">
            <div className="title-row">
              {name}
              {more}
            </div>
            <span className="sub">
              {plural(count, 'clip')} · {timeAgo(c.updatedAt)}
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="thumb" style={{ left: cover.x - card.x, width: cover.w, height: cover.h }} onPointerMove={scrub} onPointerLeave={unscrub}>
            {!card.coverAssetId && <ImageOff size={14} className="cover-empty" />}
          </div>
          <div className="col-name">
            {name}
            {target && <span className="target-dot" title="Active target" />}
          </div>
          <span className="col-items">{count}</span>
          <span className="col-owner">
            <Avatar name={ownerName} color={ownerColor} size="sm" />
            {ownerName}
          </span>
          <span className="col-updated">{timeAgo(c.updatedAt)}</span>
          {more}
        </>
      )}
    </div>
    {/* Outside the card: React bubbles portal clicks to the card otherwise. */}
    {menu.anchor && <Menu anchor={menu.anchor} onClose={menu.close} items={menuItems} />}
    </>
  );
}
