// The Canvas pane: the active collection's board. The BoardController does
// the interaction work; this component wires it to React chrome: header,
// toolbar, selection bar, focus bar and info panel, notes, menus and the HUD.

import {
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  Crosshair,
  Globe,
  Grid3x3,
  Hand,
  Heading1,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  LayoutGrid,
  Maximize,
  MousePointer2,
  Pencil,
  Pilcrow,
  Redo2,
  Rows3,
  ScanEye,
  Sparkles,
  Trash2,
  Type,
  Underline,
  Undo2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Note, TextSize } from '../../data/model.ts';
import type { CameraState } from '../../engine/protocol.ts';
import { Button, EmptyState, IconButton } from '../../ui/controls.tsx';
import { Menu, type MenuEntry } from '../../ui/popover.tsx';
import type { Rect } from '../camera.ts';
import { engine, useEngineView } from '../engine.ts';
import { plural } from '../format.ts';
import { ingestFiles } from '../ingest.ts';
import {
  deleteItems,
  formatNotes,
  notesOf,
  redo,
  renameCollection,
  setActiveTarget,
  setCover,
  toggleNoteFormat,
  togglePane,
  undo,
  updatePrefs,
  useStore,
} from '../store.ts';
import { useResolvedTheme } from '../theme.ts';
import { InfoPanel } from '../detail/InfoPanel.tsx';
import { INFO_MAX, INFO_SHARE, useDetail } from '../detail/state.ts';
import { BoardController, type Tool } from './BoardController.ts';
import { FocusBar } from './FocusBar.tsx';
import { Hud } from './Hud.tsx';
import { SharePopover } from '../SharePopover.tsx';
import { remoteEnabled } from '../../config.ts';
import { CommentsLayer, CommentToolButton, ViewerToolbar } from '../comments/CommentsLayer.tsx';
import { commentAt } from '../comments/state.ts';
import { NotesLayer } from './NotesLayer.tsx';
import { boardRegistry } from './registry.ts';

export function CanvasPane({ collectionId }: { collectionId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLDivElement>(null);
  const view = useEngineView(host, 'board');
  const theme = useResolvedTheme();
  const [ctrl, setCtrl] = useState<BoardController | null>(null);
  const [camera, setCamera] = useState<CameraState>({ x: 0, y: 0, zoom: 1 });
  const [selRect, setSelRect] = useState<Rect | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [menu, setMenu] = useState<{ x: number; y: number; hit: string | null } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  const collection = useStore((s) => s.collections[collectionId]);
  const placementCount = useStore((s) => {
    let n = 0;
    for (const p of Object.values(s.placements)) if (p.collectionId === collectionId) n++;
    return n;
  });
  const noteCount = useStore((s) => notesOf(collectionId, s.notes).length);
  const selection = useStore((s) => s.selection);
  const focus = useStore((s) => (s.focus?.collectionId === collectionId ? s.focus : null));
  const focusAsset = useStore((s) => {
    const p = focus && s.placements[focus.placementId];
    return p ? s.assets[p.assetId] : undefined;
  });
  const infoPanel = useDetail((s) => s.infoPanel);
  const hud = useStore((s) => s.hud);
  const feedOpen = useStore((s) => s.panes.feed);
  const readonly = useStore((s) => s.mode === 'public');
  const [shareAnchor, setShareAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!view || !host.current || !notesRef.current) return;
    const c = new BoardController(host.current, notesRef.current, view, collectionId, {
      onCamera: setCamera,
      onSelectionRect: (r) => setSelRect((prev) => (sameRect(prev, r) ? prev : r)),
      onTool: setTool,
      onContextMenu: (x, y, hit) => setMenu({ x, y, hit }),
      onEditNote: setEditing,
      ...(remoteEnabled ? { onComment: (sx: number, sy: number, x: number, y: number) => commentAt(collectionId, c.commentSpotAt(sx, sy), { x, y }) } : {}),
    }, readonly);
    setCtrl(c);
    boardRegistry.current = c;
    host.current.focus({ preventScroll: true });
    return () => {
      if (boardRegistry.current === c) boardRegistry.current = null;
      c.dispose();
      setCtrl(null);
    };
  }, [view, collectionId, readonly]);

  useEffect(() => ctrl?.setTheme(theme), [ctrl, theme]);

  useEffect(
    () =>
      engine.on((msg) => {
        if (msg.type === 'focusTime' && ctrl) ctrl.focusTime = msg.time;
      }),
    [ctrl],
  );

  // Files dropped from the desktop land where they're dropped.
  const onDragOver = (e: React.DragEvent) => {
    if (readonly || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setFileDrag(true);
  };
  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files') || !ctrl || !host.current) return;
    e.preventDefault();
    setFileDrag(false);
    const r = host.current.getBoundingClientRect();
    const [wx, wy] = ctrl.camera.toWorld(e.clientX - r.left, e.clientY - r.top);
    void ingestFiles([...e.dataTransfer.files], collectionId, { x: wx, y: wy });
  };

  const menuItems = useMemo((): MenuEntry[] => {
    if (!menu || !ctrl) return [];
    const placement = menu.hit ? ctrl.placementById(menu.hit) : undefined;
    if (menu.hit) {
      const multi = selection.length > 1;
      const notes = useStore.getState().notes;
      const noteIds = selection.filter((id) => notes[id]);
      return [
        ...(noteIds.length ? textMenu(collectionId, noteIds.map((id) => notes[id]), () => ctrl.editNote(noteIds[0])) : []),
        ...(placement
          ? [
              { label: 'Focus', icon: <ScanEye size={15} />, trail: 'Double-click', onSelect: () => ctrl.enterFocus(placement.id) },
              { label: 'Find similar', icon: <Sparkles size={15} />, trail: 'M2', disabled: true },
              { label: 'Use as cover', icon: <ImageIcon size={15} />, onSelect: () => setCover(collectionId, placement.assetId) },
              'separator' as const,
            ]
          : []),
        ...(multi
          ? [
              { label: 'Arrange as grid', icon: <LayoutGrid size={15} />, onSelect: () => ctrl.arrangeSelection('grid') },
              { label: 'Arrange in a row', icon: <Rows3 size={15} />, onSelect: () => ctrl.arrangeSelection('row') },
            ]
          : []),
        { label: 'Bring to front', icon: <ArrowUpToLine size={15} />, onSelect: () => ctrl.bringToFront() },
        { label: 'Send to back', icon: <ArrowDownToLine size={15} />, onSelect: () => ctrl.sendToBack() },
        'separator' as const,
        { label: multi ? `Delete ${selection.length} items` : 'Delete', icon: <Trash2 size={15} />, danger: true, trail: '⌫', onSelect: () => deleteItems(collectionId, selection) },
      ];
    }
    return [
      { label: 'Add text here', icon: <Type size={15} />, trail: 'T', onSelect: () => ctrl.placeNoteAtClient(menu.x, menu.y) },
      { label: 'Fit all', icon: <Maximize size={15} />, trail: 'F', onSelect: () => ctrl.fitAll() },
    ];
  }, [menu, ctrl, selection, collectionId]);

  const empty = placementCount === 0 && noteCount === 0;
  const target = useStore((s) => s.user.activeTargetId === collectionId);

  return (
    <div className={`board ${fileDrag ? 'file-drag' : ''}`} onDragOver={onDragOver} onDragLeave={() => setFileDrag(false)} onDrop={onDrop}>
      <div className="board-host" ref={host} tabIndex={0} data-tool={tool} data-readonly={readonly || undefined}>
        <div className="notes-layer" ref={notesRef}>
          <NotesLayer collectionId={collectionId} ctrl={ctrl} editing={readonly ? null : editing} setEditing={readonly ? () => {} : setEditing} />
          {remoteEnabled && <CommentsLayer collectionId={collectionId} tool={tool} />}
        </div>
      </div>

      {collection && !readonly && (
        <div className="board-head">
          <BoardTitle name={collection.name} onRename={(n) => renameCollection(collectionId, n)} />
          <span className="board-count">{plural(placementCount, 'clip')}</span>
          <IconButton label={target ? 'Clear active target' : 'Set as active target'} size="sm" pressed={target} onClick={() => setActiveTarget(target ? null : collectionId)}>
            <Crosshair size={14} />
          </IconButton>
          <IconButton label={collection.isPublic ? 'Published · share' : 'Share'} size="sm" pressed={collection.isPublic} onClick={(e) => setShareAnchor(shareAnchor ? null : e.currentTarget)}>
            <Globe size={14} />
          </IconButton>
        </div>
      )}
      {shareAnchor && <SharePopover collectionId={collectionId} anchor={shareAnchor} onClose={() => setShareAnchor(null)} />}

      <div className="board-corner">
        <ZoomMenu zoom={camera.zoom} ctrl={ctrl} />
      </div>

      {!focus && !readonly && (
        <BoardToolbar
          tool={tool}
          ctrl={ctrl}
          canUndo={useStore.getState().history[collectionId]?.undo.length !== 0}
          collectionId={collectionId}
        />
      )}
      {!focus && readonly && <ViewerToolbar tool={tool} ctrl={ctrl} />}

      {selRect && !focus && !readonly && selection.length > 0 && ctrl && <SelectionBar rect={selRect} count={selection.length} ctrl={ctrl} collectionId={collectionId} />}

      {focus && ctrl && <FocusBar ctrl={ctrl} focus={focus} />}
      {focus && infoPanel && focusAsset && (
        <div className="board-info" style={{ width: `min(${INFO_MAX}px, ${INFO_SHARE * 100}%)` }}>
          <InfoPanel asset={focusAsset} />
        </div>
      )}

      {empty && readonly && (
        <div className="board-empty">
          <EmptyState icon={<Upload size={22} />} title="Nothing here yet" />
        </div>
      )}
      {empty && !readonly && (
        <div className="board-empty">
          <EmptyState
            icon={<Upload size={22} />}
            title="Drop clips here"
            action={
              !feedOpen && (
                <Button variant="secondary" onClick={() => togglePane('feed')}>
                  <Sparkles size={15} />
                  Open the Feed
                </Button>
              )
            }
          >
            Drag videos, GIFs or images from your computer, or add clips from the Feed.
          </EmptyState>
        </div>
      )}

      {fileDrag && <div className="file-drop-hint">Drop to add to {collection?.name}</div>}
      {menu && <Menu anchor={{ x: menu.x, y: menu.y }} items={menuItems} onClose={() => setMenu(null)} />}
      {hud && ctrl && !readonly && <Hud ctrl={ctrl} onClose={() => updatePrefs({ hud: false })} />}
    </div>
  );
}

const SIZES: { size: TextSize; label: string; icon: React.ReactNode }[] = [
  { size: 'h1', label: 'Heading 1', icon: <Heading1 size={15} /> },
  { size: 'h2', label: 'Heading 2', icon: <Heading2 size={15} /> },
  { size: 'h3', label: 'Heading 3', icon: <Heading3 size={15} /> },
  { size: 'body', label: 'Body', icon: <Pilcrow size={15} /> },
];

// Formatting for the selected text boxes; it applies to each whole box.
function textMenu(collectionId: string, notes: Note[], edit: () => void): MenuEntry[] {
  const ids = notes.map((n) => n.id);
  const all = (f: (n: Note) => boolean) => notes.every(f);
  return [
    ...(notes.length === 1 ? [{ label: 'Edit text', icon: <Pencil size={15} />, trail: '↵', onSelect: edit }, 'separator' as const] : []),
    ...SIZES.map(({ size, label, icon }) => ({ label, icon, checked: all((n) => n.size === size), onSelect: () => formatNotes(collectionId, ids, { size }) })),
    'separator',
    { label: 'Bold', icon: <Bold size={15} />, trail: '⌘B', checked: all((n) => n.bold), onSelect: () => toggleNoteFormat(collectionId, ids, 'bold') },
    { label: 'Italic', icon: <Italic size={15} />, trail: '⌘I', checked: all((n) => n.italic), onSelect: () => toggleNoteFormat(collectionId, ids, 'italic') },
    { label: 'Underline', icon: <Underline size={15} />, trail: '⌘U', checked: all((n) => n.underline), onSelect: () => toggleNoteFormat(collectionId, ids, 'underline') },
    'separator',
  ];
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
}

function BoardTitle({ name, onRename }: { name: string; onRename: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        className="rename board-rename"
        autoFocus
        defaultValue={name}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => {
          onRename(e.currentTarget.value);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') {
            e.currentTarget.value = name;
            e.currentTarget.blur();
          }
        }}
      />
    );
  }
  return (
    <h2 className="board-title" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
      {name}
    </h2>
  );
}

function ZoomMenu({ zoom, ctrl }: { zoom: number; ctrl: BoardController | null }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const hud = useStore((s) => s.hud);
  return (
    <>
      <div className="float-bar small">
        <button type="button" className="zoom-btn" onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
          {Math.round(zoom * 100)}%
        </button>
      </div>
      {anchor && ctrl && (
        <Menu
          anchor={anchor}
          align="end"
          onClose={() => setAnchor(null)}
          items={[
            { label: 'Zoom to fit', trail: 'F', onSelect: () => ctrl.fitAll() },
            { label: 'Zoom in', trail: '+', onSelect: () => ctrl.zoomBy(1.25) },
            { label: 'Zoom out', trail: '−', onSelect: () => ctrl.zoomBy(0.8) },
            'separator',
            { label: '50%', onSelect: () => ctrl.zoomTo(0.5) },
            { label: '100%', trail: '1', onSelect: () => ctrl.zoomTo(1) },
            { label: '200%', onSelect: () => ctrl.zoomTo(2) },
            'separator',
            { label: 'Performance overlay', trail: '`', checked: hud, onSelect: () => updatePrefs({ hud: !hud }) },
          ]}
        />
      )}
    </>
  );
}

function BoardToolbar({ tool, ctrl, collectionId }: { tool: Tool; ctrl: BoardController | null; canUndo: boolean; collectionId: string }) {
  const snap = useStore((s) => s.snap);
  const scrub = useStore((s) => s.scrubOnHover);
  const history = useStore((s) => s.history[collectionId]);
  const set = useCallback((t: Tool) => ctrl?.setTool(t), [ctrl]);
  return (
    <div className="board-toolbar float-bar">
      <IconButton label="Select (V)" pressed={tool === 'select'} onClick={() => set('select')}>
        <MousePointer2 size={15} />
      </IconButton>
      <IconButton label="Hand (H, or hold Space)" pressed={tool === 'hand'} onClick={() => set('hand')}>
        <Hand size={15} />
      </IconButton>
      <IconButton label="Text (T)" pressed={tool === 'note'} onClick={() => set('note')}>
        <Type size={15} />
      </IconButton>
      <CommentToolButton tool={tool} ctrl={ctrl} />
      <span className="sep optional" />
      <IconButton label="Snap to grid" className="optional" pressed={snap} onClick={() => updatePrefs({ snap: !snap })}>
        <Grid3x3 size={15} />
      </IconButton>
      <IconButton label="Scrub on hover" className="optional" pressed={scrub} onClick={() => updatePrefs({ scrubOnHover: !scrub })}>
        <ScanEye size={15} />
      </IconButton>
      <span className="sep" />
      <IconButton label="Undo (⌘Z)" disabled={!history?.undo.length} onClick={() => undo(collectionId)}>
        <Undo2 size={15} />
      </IconButton>
      <IconButton label="Redo (⇧⌘Z)" disabled={!history?.redo.length} onClick={() => redo(collectionId)}>
        <Redo2 size={15} />
      </IconButton>
      <span className="sep" />
      <IconButton label="Fit all (F)" onClick={() => ctrl?.fitAll()}>
        <Maximize size={15} />
      </IconButton>
    </div>
  );
}

function SelectionBar({ rect, count, ctrl, collectionId }: { rect: Rect; count: number; ctrl: BoardController; collectionId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    const pane = el?.parentElement;
    if (!el || !pane) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(Math.max(12, rect.x + rect.w / 2 - w / 2), pane.clientWidth - w - 12);
    let top = rect.y - h - 14;
    if (top < 64) top = Math.min(rect.y + rect.h + 14, pane.clientHeight - h - 76);
    setPos({ left, top });
  }, [rect]);
  const hasMany = count > 1;
  return (
    <div ref={ref} className="selection-bar float-bar" style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}>
      <span className="selection-label">{count} selected</span>
      {hasMany && (
        <>
          <span className="sep" />
          <IconButton label="Arrange as grid" size="sm" onClick={() => ctrl.arrangeSelection('grid')}>
            <LayoutGrid size={15} />
          </IconButton>
          <IconButton label="Arrange in a row" size="sm" onClick={() => ctrl.arrangeSelection('row')}>
            <Rows3 size={15} />
          </IconButton>
        </>
      )}
      <IconButton label="Bring to front" size="sm" onClick={() => ctrl.bringToFront()}>
        <ArrowUpToLine size={15} />
      </IconButton>
      <span className="sep" />
      <IconButton label="Delete" size="sm" onClick={() => deleteItems(collectionId, useStore.getState().selection)}>
        <Trash2 size={15} />
      </IconButton>
    </div>
  );
}
