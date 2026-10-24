// Checks for text box checklists and slash commands: run with `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatLines, parseLines, toggleLine } from '../../src/app/canvas/lines.ts';
import { exactCommand, matchCommands, slashQuery } from '../../src/app/canvas/slash.ts';

test('checklist lines round-trip through text', () => {
  const text = 'Shot list\n[ ] Wide\n[x] Close-up\n[ ] \nNotes';
  const lines = parseLines(text);
  assert.deepEqual(lines, [
    { check: null, text: 'Shot list' },
    { check: false, text: 'Wide' },
    { check: true, text: 'Close-up' },
    { check: false, text: '' },
    { check: null, text: 'Notes' },
  ]);
  assert.equal(formatLines(lines), text);
});

test('markers need their brackets at the start of the line', () => {
  assert.deepEqual(parseLines('[X] Done'), [{ check: true, text: 'Done' }]);
  assert.deepEqual(parseLines('[ ]'), [{ check: false, text: '' }]);
  assert.deepEqual(parseLines('see [ ] here'), [{ check: null, text: 'see [ ] here' }]);
  assert.deepEqual(parseLines('[ ]x'), [{ check: null, text: '[ ]x' }]);
});

test('toggling flips one item and leaves plain lines alone', () => {
  assert.equal(toggleLine('a\n[ ] b\n[x] c', 1), 'a\n[x] b\n[x] c');
  assert.equal(toggleLine('a\n[ ] b\n[x] c', 2), 'a\n[ ] b\n[ ] c');
  assert.equal(toggleLine('a\n[ ] b', 0), 'a\n[ ] b');
});

test('a slash opens a query only at the start of a word', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/che'), 'che');
  assert.equal(slashQuery('Shot list /todo'), 'todo');
  assert.equal(slashQuery('and/or'), null);
  assert.equal(slashQuery('/todo '), null);
  assert.equal(slashQuery('http://x'), null);
});

test('commands match by prefix, substring and letters in order', () => {
  for (const q of ['', 'che', 'CHECK', 'todo', 'tdo', 'list', 'task']) assert.equal(matchCommands(q)[0]?.id, 'checklist', q);
  assert.deepEqual(matchCommands('xyz'), []);
  assert.equal(exactCommand('todo')?.id, 'checklist');
  assert.equal(exactCommand('Checklist')?.id, 'checklist');
  assert.equal(exactCommand('che'), undefined);
});
