// Slash commands in text boxes: type "/" at the start of a word, then a
// command. The menu fuzzy-filters as you type; Enter or Tab runs the
// highlighted command, and a space after a command's full name runs it.

import { type LucideIcon, ListChecks } from 'lucide-react';
import { ensureCaretLine, setCheck } from './lines.ts';

export interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  // Names it answers to; the first is the one shown.
  names: string[];
  icon: LucideIcon;
  // Runs with the command's text already removed and the caret where it was.
  run(root: HTMLElement): void;
}

export const COMMANDS: SlashCommand[] = [
  {
    id: 'checklist',
    label: 'Checklist',
    hint: 'Each line gets a checkbox',
    names: ['checklist', 'todo', 'task', 'checkbox'],
    icon: ListChecks,
    run(root) {
      const line = ensureCaretLine(root);
      if (line) setCheck(line, false);
    },
  },
];

// A "/" at the start of a word, and what's been typed after it.
const TOKEN = /(?:^|\s)\/([\w-]*)$/;

export function slashQuery(before: string): string | null {
  return TOKEN.exec(before)?.[1] ?? null;
}

// Commands matching a query, best first.
export function matchCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return COMMANDS.map((c) => ({ c, s: Math.max(...[c.label.toLowerCase(), ...c.names].map((n) => score(q, n))) }))
    .filter((m) => m.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((m) => m.c);
}

// The command whose name is exactly the query, for space-to-run.
export function exactCommand(query: string): SlashCommand | undefined {
  const q = query.toLowerCase();
  return COMMANDS.find((c) => c.names.includes(q));
}

// Prefix beats substring beats the query's letters in order; within each,
// earlier and tighter matches win.
function score(q: string, name: string): number {
  if (!q) return 1;
  if (name.startsWith(q)) return 300 - name.length;
  const at = name.indexOf(q);
  if (at >= 0) return 200 - at;
  let from = 0;
  let gaps = 0;
  for (const ch of q) {
    const i = name.indexOf(ch, from);
    if (i < 0) return 0;
    gaps += i - from;
    from = i + 1;
  }
  return Math.max(1, 100 - gaps);
}
