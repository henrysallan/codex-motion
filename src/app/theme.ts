// Resolves the theme preference to light or dark, applies it to the page,
// and gives the GPU views matching colours (they can't read CSS).

import { useEffect, useSyncExternalStore } from 'react';
import type { FrameColor } from '../data/model.ts';
import type { RGB, ViewStyle } from '../engine/protocol.ts';
import { useStore } from './store.ts';

export type Resolved = 'light' | 'dark';
export type Surface = 'board' | 'panel';

const media = matchMedia('(prefers-color-scheme: dark)');

function subscribeSystem(cb: () => void) {
  media.addEventListener('change', cb);
  return () => media.removeEventListener('change', cb);
}

export function useResolvedTheme(): Resolved {
  const pref = useStore((s) => s.theme);
  const systemDark = useSyncExternalStore(subscribeSystem, () => media.matches);
  return pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
}

// Keeps <html data-theme> in sync, without animating every colour.
export function useApplyTheme(): Resolved {
  const theme = useResolvedTheme();
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add('theme-switching');
    root.dataset.theme = theme;
    const t = requestAnimationFrame(() => root.classList.remove('theme-switching'));
    return () => cancelAnimationFrame(t);
  }, [theme]);
  return theme;
}

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

// Mirrors --board-bg / --surface in tokens.css.
const styles: Record<Resolved, Record<Surface, ViewStyle>> = {
  light: {
    board: { background: hex('#f7f6f5'), grid: 1, gridColor: hex('#d3d1ce'), radius: 2, placeholder: hex('#e7e5e2') },
    panel: { background: hex('#ffffff'), grid: 0, gridColor: hex('#ffffff'), radius: 5, placeholder: hex('#efeeec') },
  },
  dark: {
    board: { background: hex('#131314'), grid: 1, gridColor: hex('#2d2d30'), radius: 2, placeholder: hex('#202022') },
    panel: { background: hex('#18181a'), grid: 0, gridColor: hex('#18181a'), radius: 5, placeholder: hex('#232326') },
  },
};

export function viewStyle(theme: Resolved, surface: Surface, radius?: number): ViewStyle {
  const s = styles[theme][surface];
  return radius === undefined ? s : { ...s, radius };
}

// Accent colours for GPU overlays (selection, marquee).
export const overlayColors = {
  light: { accent: [0.231, 0.482, 0.965] as RGB, handle: [1, 1, 1] as RGB },
  dark: { accent: [0.357, 0.573, 1] as RGB, handle: [0.094, 0.094, 0.102] as RGB },
};

// Board frame fills, soft tints of the board in each theme. The CSS hex is
// for swatches; the GPU gets the same colour.
export const frameColors: Record<Resolved, Record<FrameColor, string>> = {
  light: {
    default: '#ffffff',
    grey: '#ebe9e6',
    red: '#fbe2df',
    orange: '#fcead8',
    yellow: '#faf2cf',
    green: '#e1f1e2',
    blue: '#e0eafb',
    purple: '#ebe4fa',
    pink: '#fae2ee',
  },
  dark: {
    default: '#1f1f22',
    grey: '#2a2a2e',
    red: '#3b2224',
    orange: '#3a2b1e',
    yellow: '#36311c',
    green: '#1f3124',
    blue: '#1e2739',
    purple: '#2b2339',
    pink: '#3a2130',
  },
};

export function frameFill(theme: Resolved, color: FrameColor): RGB {
  return hex(frameColors[theme][color] ?? frameColors[theme].default);
}

// A frame's hairline edge, so a white frame still shows on a pale board.
export const frameStroke: Record<Resolved, [number, number, number, number]> = {
  light: [0, 0, 0, 0.09],
  dark: [1, 1, 1, 0.07],
};
