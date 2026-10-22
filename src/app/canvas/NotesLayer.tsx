// Text notes on the board. They're DOM (text editing for free) inside a
// layer the controller transforms with the camera; presses go to the
// controller so notes select, move and marquee like clips.

import { useEffect, useMemo, useRef } from 'react';
import type { Note } from '../../data/model.ts';
import { deleteItems, notesOf, saveNote, useStore } from '../store.ts';
import type { BoardController } from './BoardController.ts';

export function NotesLayer({
  collectionId,
  ctrl,
  editing,
  setEditing,
}: {
  collectionId: string;
  ctrl: BoardController | null;
  editing: string | null;
  setEditing: (id: string | null) => void;
}) {
  const all = useStore((s) => s.notes);
  const selection = useStore((s) => s.selection);
  const notes = useMemo(() => notesOf(collectionId, all), [all, collectionId]);
  const selected = useMemo(() => new Set(selection), [selection]);
  return (
    <>
      {notes.map((n) => (
        <NoteCard
          key={n.id}
          note={n}
          selected={selected.has(n.id)}
          editing={editing === n.id}
          onPointerDown={(e) => {
            if (editing === n.id) {
              e.stopPropagation();
              return;
            }
            ctrl?.pointerDownOnNote(e, n.id);
          }}
          onEdit={() => setEditing(n.id)}
          onDone={(text) => {
            setEditing(null);
            if (!text.trim()) deleteItems(collectionId, [n.id]);
            else saveNote({ ...n, text });
          }}
        />
      ))}
    </>
  );
}

function NoteCard({
  note,
  selected,
  editing,
  onPointerDown,
  onEdit,
  onDone,
}: {
  note: Note;
  selected: boolean;
  editing: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onEdit: () => void;
  onDone: (text: string) => void;
}) {
  const text = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = text.current;
    if (!editing || !el) return;
    el.focus();
    // Caret at the end.
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [editing]);
  return (
    <div
      className={`note ${selected ? 'selected' : ''} ${editing ? 'editing' : ''}`}
      data-note={note.id}
      style={{ left: note.x, top: note.y, width: note.w, zIndex: note.z }}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onEdit();
      }}
    >
      <div
        ref={text}
        className="note-text"
        contentEditable={editing ? 'plaintext-only' : false}
        suppressContentEditableWarning
        data-placeholder="Write a note"
        onBlur={(e) => editing && onDone(e.currentTarget.innerText)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) e.currentTarget.blur();
          e.stopPropagation();
        }}
      >
        {note.text}
      </div>
    </div>
  );
}
