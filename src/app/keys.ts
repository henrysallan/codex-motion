// Space is shared: tap it to pause or play the whole board (or the focused
// clip), hold it to pan the canvas. The canvas marks a hold as "used" when
// it pans, so releasing doesn't also toggle playback.

import { setPaused, useStore } from './store.ts';

export const space = { down: false, used: false, at: 0 };

// Handlers for a Space tap while a clip is focused; set by the canvas.
export const spaceTap = { focus: null as null | (() => void) };

const typing = (t: EventTarget | null) =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);

addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || typing(e.target)) return;
  e.preventDefault();
  if (!space.down) Object.assign(space, { down: true, used: false, at: performance.now() });
  document.body.classList.add('space-held');
});

addEventListener('keyup', (e) => {
  if (e.code !== 'Space' || !space.down) return;
  space.down = false;
  document.body.classList.remove('space-held');
  if (space.used || performance.now() - space.at > 350) return;
  if (spaceTap.focus) spaceTap.focus();
  else setPaused(!useStore.getState().paused);
});

addEventListener('blur', () => {
  space.down = false;
  document.body.classList.remove('space-held');
});

export { typing as isTyping };
