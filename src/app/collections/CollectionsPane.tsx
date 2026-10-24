// The Collections pane: folders and collections, as a grid of animated covers
// or a list, with search and sort. Folders nest, and the breadcrumb pills in
// the header show where you are. Drag a collection or folder onto a folder,
// or onto a pill, to file it there; double-click a folder to go in. Opening
// a collection adds (or focuses) its tab; any one can be the active target
// for clips added from the Feed.

import {
  ArrowUpDown,
  ChevronRight,
  Crosshair,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Globe,
  ImageOff,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import type { Collection, Folder } from '../../data/model.ts';
import type { ViewItem } from '../../engine/protocol.ts';
import { Avatar, Button, EmptyState, IconButton, SearchField, UnderlineTabs } from '../../ui/controls.tsx';
import { Menu, type MenuEntry, useMenu } from '../../ui/popover.tsx';
import { engine } from '../engine.ts';
import { plural, timeAgo } from '../format.ts';
import { coverCrop, fractionAcross, ScrollSurface, type SurfaceHandle } from '../ScrollSurface.tsx';
import { SharePopover } from '../SharePopover.tsx';
import {
  type CollectionsSort,
  coverAssetOf,
  createCollection,
  createFolder,
  deleteCollection,
  deleteFolder,
  folderPath,
  moveToFolder,
  openCollection,
  openFolder,
  renameCollection,
  renameFolder,
  setActiveTarget,
  updatePrefs,
  useStore,
} from '../store.ts';
import { toast } from '../toasts.tsx';

const PAD = 16;
const GAP_X = 12;
const GAP_Y = 12;
const MIN_CARD = 160;
const COVER_ASPECT = 16 / 10;
const META_H = 44;
const FOLDER_H = 36;
const FOLDER_GAP = 8;
const ROW_H = 46;
const LIST_HEAD = 30;
const THUMB_W = 52;
const THUMB_H = 32;
const DRAG_THRESHOLD = 5;
// The drop key for the top level; folders use their id.
const TOP = 'top';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CollectionCard extends Box {
  kind: 'collection';
  c: Collection;
  count: number;
  coverAssetId: string | null;
  // Cover box in content coordinates.
  cover: Box;
  // While searching: the folder it's in, when that isn't this one.
  where: string | null;
}

interface FolderCard extends Box {
  kind: 'folder';
  f: Folder;
  // Collections in it, all the way down.
  count: number;
  where: string | null;
}

type Card = CollectionCard | FolderCard;

// What a pointer-down on a card may start dragging.
interface Dragged {
  kind: 'collection' | 'folder';
  id: string;
  name: string;
}

export function CollectionsPane() {
  const collections = useStore((s) => s.collections);
  const folders = useStore((s) => s.folders);
  const placements = useStore((s) => s.placements);
  const assets = useStore((s) => s.assets);
  const mode = useStore((s) => s.collectionsView);
  const sort = useStore((s) => s.collectionsSort);
  const here = useStore((s) => s.collectionsFolder);
  const user = useStore((s) => s.user);
  const activeTab = useStore((s) => s.activeTab);
  const [query, setQuery] = useState('');
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onResize = useCallback((w: number, h: number) => setSize((s) => (s.w === w && s.h === h ? s : { w, h })), []);
  const sortMenu = useMenu();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The drop key under a drag, if it would take the drop.
  const [over, setOver] = useState<string | null>(null);
  const surface = useRef<SurfaceHandle>(null);
  // Set for a moment after a drag ends, so the click that follows doesn't open what was dragged.
  const justDragged = useRef(false);

  // A folder that's gone (deleted elsewhere) leaves the pane at the top.
  const current = here && folders[here] ? here : null;
  const path = useMemo(() => folderPath(current, folders), [current, folders]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of Object.values(placements)) m.set(p.collectionId, (m.get(p.collectionId) ?? 0) + 1);
    return m;
  }, [placements]);

  // The folder tree. Anything filed in a folder that no longer exists is at the top level.
  const tree = useMemo(() => {
    const parentOf = (id: string | null) => (id && folders[id] ? id : null);
    const kids = new Map<string | null, Folder[]>();
    for (const f of Object.values(folders)) {
      const p = parentOf(f.parentId);
      kids.set(p, [...(kids.get(p) ?? []), f]);
    }
    const filed = new Map<string | null, Collection[]>();
    for (const c of Object.values(collections)) {
      const p = parentOf(c.folderId);
      filed.set(p, [...(filed.get(p) ?? []), c]);
    }
    // A folder and every folder inside it.
    const subtree = (id: string): Set<string> => {
      const out = new Set<string>();
      const walk = (x: string) => {
        if (out.has(x)) return;
        out.add(x);
        for (const k of kids.get(x) ?? []) walk(k.id);
      };
      walk(id);
      return out;
    };
    const totals = new Map<string, number>();
    for (const f of Object.values(folders)) {
      let n = 0;
      for (const x of subtree(f.id)) n += filed.get(x)?.length ?? 0;
      totals.set(f.id, n);
    }
    return { parentOf, kids, filed, subtree, totals };
  }, [folders, collections]);

  // This folder's contents; while searching, matches anywhere inside it.
  const { shownFolders, shownCollections } = useMemo(() => {
    const q = query.trim().toLowerCase();
    let fs: Folder[];
    let cs: Collection[];
    if (!q) {
      fs = tree.kids.get(current) ?? [];
      cs = tree.filed.get(current) ?? [];
    } else {
      const scope = current ? tree.subtree(current) : null;
      const inScope = (id: string | null) => !scope || (id !== null && scope.has(id));
      fs = Object.values(folders).filter((f) => inScope(tree.parentOf(f.parentId)) && f.name.toLowerCase().includes(q));
      cs = Object.values(collections).filter((c) => inScope(tree.parentOf(c.folderId)) && c.name.toLowerCase().includes(q));
    }
    const by: Record<CollectionsSort, (a: Collection, b: Collection) => number> = {
      updated: (a, b) => b.updatedAt - a.updatedAt,
      name: (a, b) => a.name.localeCompare(b.name),
      items: (a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0),
    };
    const byFolder: Record<CollectionsSort, (a: Folder, b: Folder) => number> = {
      updated: (a, b) => b.updatedAt - a.updatedAt,
      name: (a, b) => a.name.localeCompare(b.name),
      items: (a, b) => (tree.totals.get(b.id) ?? 0) - (tree.totals.get(a.id) ?? 0),
    };
    return { shownFolders: [...fs].sort(byFolder[sort]), shownCollections: [...cs].sort(by[sort]) };
  }, [collections, folders, tree, current, query, sort, counts]);

  const whereOf = useCallback(
    (parentId: string | null) => {
      const p = tree.parentOf(parentId);
      return query.trim() && p !== current && p ? folders[p].name : null;
    },
    [tree, query, current, folders],
  );

  const { cards, height } = useMemo(() => {
    const out: Card[] = [];
    const inner = Math.max(0, size.w - PAD * 2);
    if (mode === 'grid') {
      const cols = Math.max(1, Math.floor((inner + GAP_X) / (MIN_CARD + GAP_X)));
      const w = (inner - GAP_X * (cols - 1)) / cols;
      const coverH = w / COVER_ASPECT;
      let top = 2;
      shownFolders.forEach((f, i) => {
        const x = PAD + (i % cols) * (w + GAP_X);
        const y = top + Math.floor(i / cols) * (FOLDER_H + FOLDER_GAP);
        out.push({ kind: 'folder', f, count: tree.totals.get(f.id) ?? 0, where: whereOf(f.parentId), x, y, w, h: FOLDER_H });
      });
      if (shownFolders.length) top += Math.ceil(shownFolders.length / cols) * (FOLDER_H + FOLDER_GAP) - FOLDER_GAP + 16;
      shownCollections.forEach((c, i) => {
        const x = PAD + (i % cols) * (w + GAP_X);
        const y = top + Math.floor(i / cols) * (coverH + META_H + GAP_Y);
        out.push({
          kind: 'collection', c, count: counts.get(c.id) ?? 0, coverAssetId: coverAssetOf(c, placements), where: whereOf(c.folderId),
          x, y, w, h: coverH + META_H, cover: { x, y, w, h: coverH },
        });
      });
      const rows = Math.ceil(shownCollections.length / cols);
      return { cards: out, height: top + rows * (coverH + META_H + GAP_Y) + PAD };
    }
    let y = LIST_HEAD;
    for (const f of shownFolders) {
      out.push({ kind: 'folder', f, count: tree.totals.get(f.id) ?? 0, where: whereOf(f.parentId), x: PAD, y, w: inner, h: ROW_H });
      y += ROW_H;
    }
    for (const c of shownCollections) {
      out.push({
        kind: 'collection', c, count: counts.get(c.id) ?? 0, coverAssetId: coverAssetOf(c, placements), where: whereOf(c.folderId),
        x: PAD, y, w: inner, h: ROW_H, cover: { x: PAD + 4, y: y + (ROW_H - THUMB_H) / 2, w: THUMB_W, h: THUMB_H },
      });
      y += ROW_H;
    }
    return { cards: out, height: y + PAD };
  }, [shownFolders, shownCollections, mode, size.w, counts, placements, tree, whereOf]);

  const items = useMemo<ViewItem[]>(() => {
    const out: ViewItem[] = [];
    cards.forEach((card, i) => {
      if (card.kind !== 'collection') return;
      const a = card.coverAssetId ? assets[card.coverAssetId] : null;
      if (!a) return;
      const b = card.cover;
      out.push({ id: i + 1, assetId: a.id, x: b.x, y: b.y, w: b.w, h: b.h, z: i, crop: coverCrop(a.width / a.height, b.w / b.h) });
    });
    return out;
  }, [cards, assets]);

  const go = (id: string | null) => {
    openFolder(id);
    setQuery('');
    setSelected(null);
    const s = surface.current;
    if (s?.scrollTop) s.scrollBy(-s.scrollTop);
  };

  const nameOfFolder = (id: string | null) => (id ? (folders[id]?.name ?? 'Collections') : 'Collections');

  const fileIn = (what: Dragged, dest: string | null) => {
    const s = useStore.getState();
    const from = what.kind === 'folder' ? (s.folders[what.id]?.parentId ?? null) : (s.collections[what.id]?.folderId ?? null);
    const ids = what.kind === 'folder' ? { folders: [what.id] } : { collections: [what.id] };
    if (!moveToFolder(ids, dest)) return;
    toast(`Moved “${what.name}” to ${nameOfFolder(dest)}`, { label: 'Undo', run: () => moveToFolder(ids, tree.parentOf(from)) });
  };

  // Drags a card onto a folder or a breadcrumb pill, anything marked data-drop.
  const startDrag = (e: React.PointerEvent, what: Dragged) => {
    if (e.button !== 0 || renaming === what.id) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const s = useStore.getState();
    const from = tree.parentOf(what.kind === 'folder' ? (s.folders[what.id]?.parentId ?? null) : (s.collections[what.id]?.folderId ?? null));
    // A folder can't go inside itself.
    const blocked = what.kind === 'folder' ? tree.subtree(what.id) : new Set<string>();
    let ghost: HTMLDivElement | null = null;
    let target: string | null = null;
    const move = (ev: PointerEvent) => {
      if (!ghost && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.textContent = what.name;
        document.body.append(ghost);
        document.body.classList.add('dragging-clips');
        engine.scrub(null);
      }
      ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-drop]');
      let key = el?.dataset.drop ?? null;
      const dest = key === TOP ? null : key;
      if (dest === from || (dest && blocked.has(dest))) key = null;
      if (key !== target) setOver((target = key));
    };
    const end = (ev: PointerEvent) => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', end);
      removeEventListener('pointercancel', end);
      if (!ghost) return;
      ghost.remove();
      document.body.classList.remove('dragging-clips');
      setOver(null);
      justDragged.current = true;
      setTimeout(() => (justDragged.current = false));
      if (ev.type === 'pointerup' && target !== null) fileIn(what, target === TOP ? null : target);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', end);
    addEventListener('pointercancel', end);
  };

  const newCollection = () => {
    setQuery('');
    setRenaming(createCollection(undefined, current));
  };
  const newFolder = () => {
    setQuery('');
    setRenaming(createFolder(current));
  };

  const folderMenu = (f: Folder, onRename: () => void): MenuEntry[] => {
    const parent = tree.parentOf(f.parentId);
    return [
      { label: 'Open', icon: <FolderOpen size={15} />, onSelect: () => go(f.id) },
      { label: 'Rename', icon: <Pencil size={15} />, onSelect: onRename },
      ...(parent ? [{ label: `Move out of “${folders[parent].name}”`, icon: <FolderUp size={15} />, onSelect: () => fileIn({ kind: 'folder', id: f.id, name: f.name }, tree.parentOf(folders[parent].parentId)) }] : []),
      'separator',
      {
        label: 'Delete folder',
        icon: <Trash2 size={15} />,
        danger: true,
        onSelect: () => confirm(`Delete “${f.name}”? What's in it moves to ${nameOfFolder(parent)}.`) && deleteFolder(f.id),
      },
    ];
  };

  const total = current ? (tree.totals.get(current) ?? 0) : Object.keys(collections).length;
  const empty = shownFolders.length + shownCollections.length === 0;

  return (
    <div className="collections">
      <header className="pane-head">
        <nav className="crumbs" aria-label="Folder">
          <Crumb dropKey={TOP} label="Collections" current={!current} count={!current ? total : null} over={over === TOP} onOpen={() => go(null)} />
          {path.map((f, i) => (
            <Fragment key={f.id}>
              <ChevronRight size={13} className="crumb-sep" aria-hidden />
              <Crumb
                dropKey={f.id}
                label={f.name}
                current={i === path.length - 1}
                count={i === path.length - 1 ? total : null}
                over={over === f.id}
                onOpen={() => go(f.id)}
                menu={(onRename) => folderMenu(f, onRename)}
                renaming={renaming === f.id}
                onRename={() => setRenaming(f.id)}
                onRenamed={(name) => {
                  renameFolder(f.id, name);
                  setRenaming(null);
                }}
              />
            </Fragment>
          ))}
        </nav>
        <div className="actions">
          <IconButton label="New folder" onClick={newFolder}>
            <FolderPlus size={15} />
          </IconButton>
          <Button variant="primary" size="sm" onClick={newCollection}>
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
        <SearchField value={query} onChange={setQuery} placeholder={current ? `Search in ${folders[current].name}` : 'Search collections'} />
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
      <ScrollSurface
        items={items}
        contentHeight={height}
        onResize={onResize}
        handle={surface}
        onPointerDown={(e) => !(e.target as Element).closest('.folder') && setSelected(null)}
      >
        {mode === 'list' && cards.length > 0 && (
          <div className="list-head" style={{ left: PAD, width: Math.max(0, size.w - PAD * 2) }}>
            <span className="col-name">Name</span>
            <span className="col-items">Items</span>
            <span className="col-owner">Owner</span>
            <span className="col-updated">Updated</span>
          </div>
        )}
        {cards.map((card) =>
          card.kind === 'folder' ? (
            <FolderEntry
              key={card.f.id}
              card={card}
              mode={mode}
              selected={selected === card.f.id}
              over={over === card.f.id}
              ownerName={user.name}
              ownerColor={user.color}
              menu={(onRename) => folderMenu(card.f, onRename)}
              renaming={renaming === card.f.id}
              onRename={() => setRenaming(card.f.id)}
              onRenamed={() => setRenaming(null)}
              onPointerDown={(e) => startDrag(e, { kind: 'folder', id: card.f.id, name: card.f.name })}
              onSelect={() => setSelected(card.f.id)}
              onOpen={() => go(card.f.id)}
            />
          ) : (
            <CollectionEntry
              key={card.c.id}
              card={card}
              mode={mode}
              open={activeTab === card.c.id}
              target={user.activeTargetId === card.c.id}
              ownerName={user.name}
              ownerColor={user.color}
              parent={tree.parentOf(card.c.folderId)}
              renaming={renaming === card.c.id}
              onRenamed={() => setRenaming(null)}
              onRename={() => setRenaming(card.c.id)}
              onPointerDown={(e) => startDrag(e, { kind: 'collection', id: card.c.id, name: card.c.name })}
              justDragged={justDragged}
              onMoveOut={(to) => fileIn({ kind: 'collection', id: card.c.id, name: card.c.name }, to)}
            />
          ),
        )}
        {empty && (
          <div className="surface-empty" style={{ height: Math.max(240, size.h) }}>
            {query ? (
              <EmptyState icon={<FolderOpen size={22} />} title="No matches">
                Nothing {current ? `in ${folders[current].name} ` : ''}is called “{query}”.
              </EmptyState>
            ) : current ? (
              <EmptyState icon={<FolderOpen size={22} />} title="This folder is empty" action={<Button variant="primary" onClick={newCollection}>New collection</Button>}>
                Make a collection here, or drag one onto this folder.
              </EmptyState>
            ) : (
              <EmptyState icon={<FolderOpen size={22} />} title="No collections yet" action={<Button variant="primary" onClick={newCollection}>New collection</Button>}>
                A collection is a board of reference for one project.
              </EmptyState>
            )}
          </div>
        )}
      </ScrollSurface>
    </div>
  );
}

// A breadcrumb pill: goes to its folder, and takes drops.
function Crumb({
  dropKey,
  label,
  current,
  count,
  over,
  onOpen,
  menu,
  renaming,
  onRename,
  onRenamed,
}: {
  dropKey: string;
  label: string;
  current: boolean;
  count: number | null;
  over: boolean;
  onOpen: () => void;
  menu?: (onRename: () => void) => MenuEntry[];
  renaming?: boolean;
  onRename?: () => void;
  onRenamed?: (name: string) => void;
}) {
  const m = useMenu();
  if (renaming && onRenamed) {
    return (
      <span className="crumb current renaming">
        <RenameInput value={label} onDone={onRenamed} />
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className={`crumb ${current ? 'current' : ''} ${over ? 'drop' : ''}`}
        data-drop={dropKey}
        aria-current={current ? 'location' : undefined}
        title={label}
        onClick={() => !current && onOpen()}
        onDoubleClick={() => current && onRename?.()}
        onContextMenu={(e) => {
          if (!menu) return;
          e.preventDefault();
          m.open({ x: e.clientX, y: e.clientY });
        }}
      >
        <span className="crumb-name">{label}</span>
        {count !== null && <span className="count">{count}</span>}
      </button>
      {m.anchor && menu && <Menu anchor={m.anchor} onClose={m.close} items={menu(() => onRename?.())} />}
    </>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone: (name: string) => void }) {
  return (
    <input
      className="rename"
      autoFocus
      defaultValue={value}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function MoreButton({ onOpen }: { onOpen: (el: HTMLElement) => void }) {
  return (
    <IconButton
      label="More"
      size="sm"
      className="more"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(e.currentTarget);
      }}
    >
      <MoreHorizontal size={14} />
    </IconButton>
  );
}

function FolderEntry({
  card,
  mode,
  selected,
  over,
  ownerName,
  ownerColor,
  menu,
  renaming,
  onRename,
  onRenamed,
  onPointerDown,
  onSelect,
  onOpen,
}: {
  card: FolderCard;
  mode: 'grid' | 'list';
  selected: boolean;
  over: boolean;
  ownerName: string;
  ownerColor: string;
  menu: (onRename: () => void) => MenuEntry[];
  renaming: boolean;
  onRename: () => void;
  onRenamed: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const { f, count, where } = card;
  const m = useMenu();
  const name = renaming ? (
    <RenameInput
      value={f.name}
      onDone={(v) => {
        renameFolder(f.id, v);
        onRenamed();
      }}
    />
  ) : (
    <span className="name">{f.name}</span>
  );
  const sub = where ? `in ${where}` : String(count);
  return (
    <>
      <div
        className={`folder ${mode} ${selected ? 'selected' : ''} ${over ? 'drop' : ''}`}
        style={{ left: card.x, top: card.y, width: card.w, height: card.h }}
        data-drop={f.id}
        title={`${f.name} · ${plural(count, 'collection')}`}
        onPointerDown={onPointerDown}
        onClick={onSelect}
        onDoubleClick={() => !renaming && onOpen()}
        onContextMenu={(e) => {
          e.preventDefault();
          onSelect();
          m.open({ x: e.clientX, y: e.clientY });
        }}
      >
        {mode === 'grid' ? (
          <>
            <FolderIcon size={15} className="folder-glyph" />
            {name}
            <span className="sub">{sub}</span>
            <MoreButton onOpen={(el) => m.toggle(el)} />
          </>
        ) : (
          <>
            <div className="thumb folder-thumb" style={{ left: 4, width: THUMB_W, height: THUMB_H }}>
              <FolderIcon size={15} className="folder-glyph" />
            </div>
            <div className="col-name">
              {name}
              {where && <span className="where">in {where}</span>}
            </div>
            <span className="col-items">{count}</span>
            <span className="col-owner">
              <Avatar name={ownerName} color={ownerColor} size="sm" />
              {ownerName}
            </span>
            <span className="col-updated">{timeAgo(f.updatedAt)}</span>
            <MoreButton onOpen={(el) => m.toggle(el)} />
          </>
        )}
      </div>
      {m.anchor && <Menu anchor={m.anchor} onClose={m.close} items={menu(onRename)} />}
    </>
  );
}

function CollectionEntry({
  card,
  mode,
  open,
  target,
  ownerName,
  ownerColor,
  parent,
  renaming,
  onRename,
  onRenamed,
  onPointerDown,
  justDragged,
  onMoveOut,
}: {
  card: CollectionCard;
  mode: 'grid' | 'list';
  open: boolean;
  target: boolean;
  ownerName: string;
  ownerColor: string;
  // The folder it's in.
  parent: string | null;
  renaming: boolean;
  onRename: () => void;
  onRenamed: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  justDragged: React.RefObject<boolean>;
  onMoveOut: (to: string | null) => void;
}) {
  const { c, count, cover, where } = card;
  const folders = useStore((s) => s.folders);
  const menu = useMenu();
  const [share, setShare] = useState<{ x: number; y: number } | null>(null);
  const scrub = (e: React.PointerEvent<HTMLElement>) => card.coverAssetId && !document.body.classList.contains('dragging-clips') && engine.scrub(card.coverAssetId, fractionAcross(e));
  const unscrub = () => engine.scrub(null);
  const name = renaming ? (
    <RenameInput
      value={c.name}
      onDone={(v) => {
        renameCollection(c.id, v);
        onRenamed();
      }}
    />
  ) : (
    <span className="name" onDoubleClick={(e) => (e.stopPropagation(), onRename())}>
      {c.name}
    </span>
  );
  const up = parent ? folders[parent] : null;
  const menuItems: MenuEntry[] = [
    { label: 'Open', icon: <FolderOpen size={15} />, onSelect: () => openCollection(c.id) },
    { label: target ? 'Clear active target' : 'Set as active target', icon: <Crosshair size={15} />, onSelect: () => setActiveTarget(target ? null : c.id) },
    { label: 'Rename', icon: <Pencil size={15} />, onSelect: onRename },
    ...(up ? [{ label: `Move out of “${up.name}”`, icon: <FolderUp size={15} />, onSelect: () => onMoveOut(up.parentId && folders[up.parentId] ? up.parentId : null) }] : []),
    {
      label: c.isPublic ? 'Published…' : 'Share…',
      icon: <Globe size={15} />,
      onSelect: () => {
        const a = menu.anchor;
        const r = a instanceof HTMLElement ? a.getBoundingClientRect() : null;
        setShare(r ? { x: r.left, y: r.bottom } : (a as { x: number; y: number } | null) ?? { x: innerWidth / 2, y: 120 });
      },
    },
    'separator',
    { label: 'Delete', icon: <Trash2 size={15} />, danger: true, onSelect: () => confirm(`Delete “${c.name}”? Its clips stay in the library.`) && deleteCollection(c.id) },
  ];
  const more = <MoreButton onOpen={(el) => menu.toggle(el)} />;

  return (
    <>
    <div
      className={`collection ${mode} ${open ? 'open' : ''}`}
      style={{ left: card.x, top: card.y, width: card.w, height: card.h }}
      onPointerDown={onPointerDown}
      onClick={() => !renaming && !justDragged.current && openCollection(c.id)}
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
            {c.isPublic && (
              <span className="badge blue public-badge" title={`/c/${c.slug}`}>
                <Globe size={11} strokeWidth={2.4} />
                Public
              </span>
            )}
          </div>
          <div className="meta">
            <div className="title-row">
              {name}
              {more}
            </div>
            <span className="sub">
              {plural(count, 'clip')} · {where ? `in ${where}` : timeAgo(c.updatedAt)}
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
            {where && <span className="where">in {where}</span>}
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
    {share && <SharePopover collectionId={c.id} anchor={share} onClose={() => setShare(null)} />}
    </>
  );
}
