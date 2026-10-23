// The app's one render worker, and the glue that keeps it fed: asset
// metadata, the global pause, and a hook that gives a pane its own view.

import { useEffect, useRef, useState } from 'react';
import { EngineClient, type EngineView } from '../engine/client.ts';
import { defaultSettings, type EngineStats, type GpuInfo } from '../engine/protocol.ts';
import { useStore } from './store.ts';
import { type Surface, useResolvedTheme, viewStyle } from './theme.ts';

export const engine = new EngineClient(defaultSettings);

// Latest worker stats and errors, for the HUD.
export const engineState: { stats: EngineStats | null; gpu: GpuInfo | null; error: string | null } = { stats: null, gpu: null, error: null };
engine.on((msg) => {
  if (msg.type === 'stats') engineState.stats = msg.stats;
  else if (msg.type === 'ready') engineState.gpu = msg.info;
  else if (msg.type === 'error') {
    engineState.error = msg.message;
    console.error(msg.message);
  }
});

// Push asset metadata to the worker whenever it changes.
let sentAssets = useStore.getState().assets;
engine.setAssets(Object.values(sentAssets));
useStore.subscribe((s) => {
  if (s.assets === sentAssets) return;
  const changed = Object.values(s.assets).filter((a) => sentAssets[a.id] !== a);
  sentAssets = s.assets;
  if (changed.length) engine.setAssets(changed);
});

let sentPaused = useStore.getState().paused;
useStore.subscribe((s) => {
  if (s.paused === sentPaused) return;
  sentPaused = s.paused;
  engine.setPaused(s.paused);
});

// Gives a pane a GPU view: creates a canvas inside `host` (a fresh one per
// mount, since a canvas can only be handed to the worker once), keeps its
// colours in step with the theme, and tears it down on unmount. A board
// keeps every clip's sprite loaded; a panel scrolls, and loads sprites only
// near its viewport.
export function useEngineView(host: React.RefObject<HTMLElement | null>, surface: Surface, radius?: number): EngineView | null {
  const theme = useResolvedTheme();
  const [view, setView] = useState<EngineView | null>(null);
  const styleRef = useRef({ theme, surface, radius });
  styleRef.current = { theme, surface, radius };

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'gpu-canvas';
    el.prepend(canvas);
    const s = styleRef.current;
    const v = engine.createView(canvas, s.surface === 'board' ? 'board' : 'scroll', viewStyle(s.theme, s.surface, s.radius));
    setView(v);
    return () => {
      v.destroy();
      canvas.remove();
      setView(null);
    };
  }, [host]);

  useEffect(() => {
    view?.setStyle(viewStyle(theme, surface, radius));
  }, [view, theme, surface, radius]);

  return view;
}
