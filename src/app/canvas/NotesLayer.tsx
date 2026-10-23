// Text boxes on the board. They're DOM (text editing for free) inside a
// layer the controller transforms with the camera; presses and double-clicks
// go to the controller so they select, move, marquee and edit like clips.
// Text wraps at the box's width, and the box grows to fit its text.

import { useEffect, useMemo, useRef } from 'react';
import type { Note } from '../../data/model.ts';
import { deleteItems, notesOf, saveNote, toggleNoteFormat, useStore } from '../store.ts';
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
          onToggle={(key) => toggleNoteFormat(collectionId, [n.id], key)}
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

const TOGGLE_KEYS = { b: 'bold', i: 'italic', u: 'underline' } as const;

function NoteCard({
  note,
  selected,
  editing,
  onPointerDown,
  onToggle,
  onDone,
}: {
  note: Note;
  selected: boolean;
  editing: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onToggle: (key: 'bold' | 'italic' | 'underline') => void;
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
  const classes = ['note', `size-${note.size}`];
  if (note.bold) classes.push('bold');
  if (note.italic) classes.push('italic');
  if (note.underline) classes.push('underline');
  if (selected) classes.push('selected');
  if (editing) classes.push('editing');
  return (
    <div
      className={classes.join(' ')}
      data-note={note.id}
      style={{ left: note.x, top: note.y, width: note.w, minHeight: note.h ?? undefined, zIndex: note.z }}
      onPointerDown={onPointerDown}
    >
      <div
        ref={text}
        className="note-text"
        contentEditable={editing ? 'plaintext-only' : false}
        suppressContentEditableWarning
        data-placeholder="Type something"
        onBlur={(e) => editing && onDone(e.currentTarget.innerText)}
        onKeyDown={(e) => {
          const toggle = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && TOGGLE_KEYS[e.key.toLowerCase() as keyof typeof TOGGLE_KEYS];
          if (toggle) {
            e.preventDefault();
            onToggle(toggle);
          }
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) e.currentTarget.blur();
          e.stopPropagation();
        }}
      >
        {note.text}
      </div>
    </div>
  );
}
