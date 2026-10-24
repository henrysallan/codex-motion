// A text box's lines. Text is stored plain, one line per "\n"; a checklist
// item starts with "[ ] " or "[x] " (as in Markdown task lists), so boxes
// sync and diff as text.
//
// While editing, the box is a contentEditable with one <div> per line; a
// checklist line carries data-check="0|1" and CSS draws its checkbox in the
// left padding, so the editable content stays plain text.

export interface Line {
  // null: a plain line.
  check: boolean | null;
  text: string;
}

const MARKER = /^\[( |x|X)\](?: |$)/;

export function parseLines(text: string): Line[] {
  return text.split('\n').map((l) => {
    const m = MARKER.exec(l);
    return m ? { check: m[1] !== ' ', text: l.slice(m[0].length) } : { check: null, text: l };
  });
}

export function formatLines(lines: Line[]): string {
  return lines.map((l) => (l.check === null ? '' : l.check ? '[x] ' : '[ ] ') + l.text).join('\n');
}

// The text with line `index`'s checkbox flipped.
export function toggleLine(text: string, index: number): string {
  const lines = parseLines(text);
  const l = lines[index];
  if (l && l.check !== null) l.check = !l.check;
  return formatLines(lines);
}

// ---- the editor's DOM ----------------------------------------------------------

export function renderLines(root: HTMLElement, text: string): void {
  root.replaceChildren(...parseLines(text).map(lineElement));
  root.toggleAttribute('data-empty', text === '');
}

function lineElement(l: Line): HTMLDivElement {
  const div = document.createElement('div');
  setCheck(div, l.check);
  if (l.text) div.textContent = l.text;
  else div.append(document.createElement('br'));
  return div;
}

export function setCheck(line: HTMLElement, check: boolean | null): void {
  if (check === null) delete line.dataset.check;
  else line.dataset.check = check ? '1' : '0';
}

export function isCheckLine(line: HTMLElement | null): boolean {
  return line?.dataset.check !== undefined;
}

// Reads the lines back, tolerating what editing leaves behind: text and
// <br>s directly in the root, and blocks nested in blocks.
export function readLines(root: HTMLElement): Line[] {
  const lines: Line[] = [];
  let loose: Line | null = null;
  for (const node of root.childNodes) {
    if (node instanceof HTMLBRElement) {
      lines.push(loose ?? { check: null, text: '' });
      loose = null;
    } else if (node instanceof HTMLElement && isBlock(node)) {
      if (loose) lines.push(loose);
      loose = null;
      if ([...node.children].some(isBlock)) lines.push(...readLines(node));
      else lines.push({ check: isCheckLine(node) ? node.dataset.check === '1' : null, text: clean(node.textContent ?? '') });
    } else {
      loose ??= { check: null, text: '' };
      loose.text += clean(node.textContent ?? '');
    }
  }
  if (loose) lines.push(loose);
  return lines.length ? lines : [{ check: null, text: '' }];
}

function isBlock(el: Element): boolean {
  return el.tagName === 'DIV' || el.tagName === 'P';
}

function clean(s: string): string {
  return s.replace(/ /g, ' ').replace(/\n/g, '');
}

// The line (a direct child of the root) holding the caret, if the caret is
// in one.
export function caretLine(root: HTMLElement): HTMLElement | null {
  const node = getSelection()?.anchorNode;
  if (!node || !root.contains(node)) return null;
  let el: Node | null = node;
  while (el && el.parentNode !== root) el = el.parentNode;
  return el instanceof HTMLElement && isBlock(el) ? el : null;
}

// Text from the start of the caret's line (or of the root) to the caret.
export function textBeforeCaret(root: HTMLElement): string | null {
  const sel = getSelection();
  if (!sel || !sel.isCollapsed || !sel.anchorNode || !root.contains(sel.anchorNode)) return null;
  const range = document.createRange();
  range.selectNodeContents(caretLine(root) ?? root);
  range.setEnd(sel.anchorNode, sel.anchorOffset);
  return clean(range.toString());
}

// Makes sure the caret sits in a line <div>, wrapping loose root text.
export function ensureCaretLine(root: HTMLElement): HTMLElement | null {
  const line = caretLine(root);
  if (line) return line;
  document.execCommand('formatBlock', false, 'div');
  return caretLine(root);
}

// The checkbox under a pointer: the left padding of a checklist line's
// first row.
export function checkboxAt(e: { target: EventTarget | null; clientX: number; clientY: number }): HTMLElement | null {
  const line = e.target instanceof Element ? e.target.closest<HTMLElement>('.note-text > [data-check]') : null;
  if (!line) return null;
  const r = line.getBoundingClientRect();
  // The notes layer is scaled with the camera.
  const scale = r.width / (line.offsetWidth || 1);
  const cs = getComputedStyle(line);
  const pad = parseFloat(cs.paddingLeft) * scale;
  const row = (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4) * scale;
  return e.clientX - r.left < pad && e.clientY - r.top < row ? line : null;
}
