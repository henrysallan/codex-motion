// Text boxes on the board. They're DOM (text editing for free) inside a
// layer the controller transforms with the camera; presses and double-clicks
// go to the controller so they select, move, marquee and edit like clips.
// Text wraps at the box's width, and the box grows to fit its text.
//
// Each line is a <div> (see lines.ts), so a line can be a checklist item.
// Typing "/" opens the slash command menu (see slash.ts).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Note } from '../../data/model.ts';
import { deleteItems, notesOf, saveNote, toggleNoteFormat, useStore } from '../store.ts';
import type { BoardController } from './BoardController.ts';
import {
  caretLine,
  checkboxAt,
  ensureCaretLine,
  formatLines,
  isCheckLine,
  parseLines,
  readLines,
  renderLines,
  setCheck,
  textBeforeCaret,
  toggleLine,
} from './lines.ts';
import { exactCommand, matchCommands, type SlashCommand, slashQuery } from './slash.ts';

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
            // Checkboxes tick without selecting the box or leaving the text.
            const box = checkboxAt(e);
            if (box && ctrl && !ctrl.readonly) {
              e.stopPropagation();
              if (editing === n.id) setCheck(box, box.dataset.check !== '1');
              else saveNote({ ...n, text: toggleLine(n.text, [...box.parentElement!.children].indexOf(box)) });
              return;
            }
            if (editing === n.id) {
              e.stopPropagation();
              return;
            }
            ctrl?.pointerDownOnNote(e, n.id);
          }}
          onToggle={(key) => toggleNoteFormat(collectionId, [n.id], key)}
          onResize={() => ctrl?.noteResized()}
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

interface Slash {
  query: string;
  matches: SlashCommand[];
  active: number;
  // Screen point under the caret.
  x: number;
  y: number;
}

function NoteCard({
  note,
  selected,
  editing,
  onPointerDown,
  onToggle,
  onResize,
  onDone,
}: {
  note: Note;
  selected: boolean;
  editing: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onToggle: (key: 'bold' | 'italic' | 'underline') => void;
  onResize: () => void;
  onDone: (text: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const resized = useRef(onResize);
  resized.current = onResize;
  useEffect(() => {
    const ro = new ResizeObserver(() => resized.current());
    ro.observe(box.current!);
    return () => ro.disconnect();
  }, []);
  const [slash, setSlash] = useState<Slash | null>(null);
  // The "/" the user closed the menu on (its line and offset), so the menu
  // stays shut while they keep typing after it.
  const dismissed = useRef<{ line: HTMLElement | null; at: number } | null>(null);

  // The "/query" at the caret, if the menu should be open for it. Read from
  // the DOM so keys typed faster than React renders still see it.
  const readSlash = (el: HTMLElement) => {
    const before = textBeforeCaret(el);
    const query = before === null ? null : slashQuery(before);
    if (before === null || query === null) {
      dismissed.current = null;
      return null;
    }
    const line = caretLine(el);
    const at = before.length - query.length - 1;
    if (dismissed.current && dismissed.current.line === line && dismissed.current.at === at) return null;
    const matches = matchCommands(query);
    return matches.length ? { query, matches, line, at } : null;
  };

  // Outside editing, the lines follow the saved text. While editing, the
  // DOM is the draft; it's read back on blur.
  useLayoutEffect(() => {
    const el = text.current;
    if (el && (!editing || !el.firstChild)) renderLines(el, note.text);
  }, [note.text, editing]);

  useEffect(() => {
    const el = text.current;
    if (!editing || !el) return;
    document.execCommand('defaultParagraphSeparator', false, 'div');
    el.focus();
    // Caret at the end.
    const range = document.createRange();
    range.selectNodeContents(el.lastChild ?? el);
    range.collapse(false);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    // Opens, filters and closes the slash menu as the caret moves.
    const update = () => {
      const cur = readSlash(el);
      if (!cur) {
        setSlash(null);
        return;
      }
      const { x, y } = caretPoint(el);
      setSlash((prev) => ({ query: cur.query, matches: cur.matches, active: prev?.query === cur.query ? Math.min(prev.active, cur.matches.length - 1) : 0, x, y }));
    };
    const beforeInput = (e: InputEvent) => {
      // No rich formatting or dropped markup: lines hold plain text.
      if (e.inputType.startsWith('format') || e.inputType === 'insertFromDrop') e.preventDefault();
      // A space after a command's full name runs it. Here rather than on
      // keydown so typing that skips key events (IME, dictation) works too.
      if (e.inputType === 'insertText' && e.data === ' ') {
        const cur = readSlash(el);
        const exact = cur && exactCommand(cur.query);
        if (exact) {
          e.preventDefault();
          runRef.current(exact, cur.query);
        }
      }
    };
    document.addEventListener('selectionchange', update);
    el.addEventListener('beforeinput', beforeInput);
    return () => {
      document.removeEventListener('selectionchange', update);
      el.removeEventListener('beforeinput', beforeInput);
      dismissed.current = null;
      setSlash(null);
    };
  }, [editing]);

  const syncEmpty = () => {
    const el = text.current;
    if (el) el.toggleAttribute('data-empty', formatLines(readLines(el)) === '');
  };

  const run = (cmd: SlashCommand, query: string) => {
    const el = text.current;
    const sel = getSelection();
    if (!el || !sel) return;
    // Remove "/query", then run where it was.
    for (let i = 0; i <= query.length; i++) sel.modify('extend', 'backward', 'character');
    document.execCommand('delete');
    cmd.run(el);
    dismissed.current = null;
    setSlash(null);
    syncEmpty();
  };
  const runRef = useRef(run);
  runRef.current = run;

  const classes = ['note', `size-${note.size}`];
  if (note.bold) classes.push('bold');
  if (note.italic) classes.push('italic');
  if (note.underline) classes.push('underline');
  if (selected) classes.push('selected');
  if (editing) classes.push('editing');
  return (
    <div
      ref={box}
      className={classes.join(' ')}
      data-note={note.id}
      style={{ left: note.x, top: note.y, width: note.w, minHeight: note.h ?? undefined, zIndex: note.z }}
      onPointerDown={onPointerDown}
      // Keep the caret where it is when a checkbox is clicked mid-edit.
      onMouseDown={(e) => checkboxAt(e) && e.preventDefault()}
    >
      <div
        ref={text}
        className="note-text"
        contentEditable={editing}
        suppressContentEditableWarning
        data-placeholder="Type something, or / for commands"
        onBlur={(e) => editing && onDone(formatLines(readLines(e.currentTarget)))}
        onInput={syncEmpty}
        onPaste={(e) => {
          e.preventDefault();
          pasteLines(e.currentTarget, e.clipboardData.getData('text/plain'));
          syncEmpty();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          const el = e.currentTarget;
          const meta = e.metaKey || e.ctrlKey;
          const cur = readSlash(el);
          if (cur) {
            const n = cur.matches.length;
            // The highlight survives only while the query is unchanged.
            const active = slash?.query === cur.query ? Math.min(slash.active, n - 1) : 0;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (slash) setSlash({ ...slash, active: (active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              run(cur.matches[active], cur.query);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              dismissed.current = { line: cur.line, at: cur.at };
              setSlash(null);
              return;
            }
          }
          const toggle = meta && !e.shiftKey && !e.altKey && TOGGLE_KEYS[e.key.toLowerCase() as keyof typeof TOGGLE_KEYS];
          if (toggle) {
            e.preventDefault();
            onToggle(toggle);
          } else if (e.key === 'Escape' || (e.key === 'Enter' && meta)) {
            el.blur();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            newLine(el, true);
            syncEmpty();
          } else if (e.key === 'Backspace' && getSelection()?.isCollapsed && textBeforeCaret(el) === '' && isCheckLine(caretLine(el))) {
            // Backspace at the start of an item drops its checkbox first.
            e.preventDefault();
            setCheck(caretLine(el)!, null);
          }
        }}
      />
      {slash && (
        <SlashMenu
          slash={slash}
          onHover={(i) => setSlash({ ...slash, active: i })}
          onPick={(c) => run(c, slash.query)}
        />
      )}
    </div>
  );
}

// Splits the line at the caret. A new line under a checklist item is an
// unticked item; with `endList`, Enter on an empty item ends the list.
function newLine(root: HTMLElement, endList: boolean): void {
  const from = caretLine(root);
  const check = isCheckLine(from);
  if (check && endList && from && !from.textContent?.trim()) {
    setCheck(from, null);
    return;
  }
  const atStart = textBeforeCaret(root) === '';
  const ticked = from?.dataset.check === '1';
  document.execCommand('insertParagraph');
  const line = caretLine(root);
  if (!line) return;
  const above = line.previousElementSibling instanceof HTMLElement ? line.previousElementSibling : null;
  if (!check) setCheck(line, null);
  else if (atStart && above) {
    // Enter at the start of an item pushes it down under a new empty one.
    setCheck(above, false);
    setCheck(line, ticked);
  } else setCheck(line, false);
}

// Pastes plain text line by line. If any line is marked "[ ] " or "[x] ",
// the markers say which lines are items; if none is, pasted lines take after
// the line they land in (so a plain list pasted into a checklist is items).
function pasteLines(root: HTMLElement, text: string): void {
  const lines = parseLines(text.replace(/\r\n?/g, '\n'));
  const marked = lines.some((l) => l.check !== null);
  lines.forEach((l, i) => {
    if (i) newLine(root, false);
    if (marked && (i > 0 || l.check !== null)) {
      const line = ensureCaretLine(root);
      if (line) setCheck(line, l.check);
    }
    if (l.text) document.execCommand('insertText', false, l.text);
  });
}

// Screen point just below the caret.
function caretPoint(root: HTMLElement): { x: number; y: number } {
  const sel = getSelection();
  const r = sel && sel.rangeCount ? sel.getRangeAt(0).getClientRects()[0] : undefined;
  if (r) return { x: r.left, y: r.bottom };
  const line = (caretLine(root) ?? root).getBoundingClientRect();
  return { x: line.left, y: line.bottom };
}

function SlashMenu({ slash, onHover, onPick }: { slash: Slash; onHover: (i: number) => void; onPick: (c: SlashCommand) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: slash.x, top: slash.y + 6 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Below the caret, or above it when there's no room; inside the window.
    const top = slash.y + 6 + el.offsetHeight > innerHeight - 8 ? slash.y - el.offsetHeight - 30 : slash.y + 6;
    setPos({ left: Math.min(Math.max(8, slash.x), innerWidth - el.offsetWidth - 8), top: Math.max(8, top) });
  }, [slash.x, slash.y, slash.matches.length]);
  return createPortal(
    <div
      ref={ref}
      className="popover slash-menu"
      role="listbox"
      style={pos}
      // Clicks here mustn't take focus from the text.
      onMouseDown={(e) => e.preventDefault()}
    >
      {slash.matches.map((c, i) => (
        <button
          key={c.id}
          type="button"
          role="option"
          aria-selected={i === slash.active}
          className="menu-item"
          data-active={i === slash.active}
          title={c.hint}
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(c)}
        >
          <span className="icon">
            <c.icon size={15} />
          </span>
          <span className="label">{c.label}</span>
          <span className="trail">/{c.names[0]}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
