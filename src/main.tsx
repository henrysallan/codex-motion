import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/shell.css';
import './styles/collections.css';
import './styles/feed.css';
import './styles/canvas.css';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { engine } from './app/engine.ts';
import { ingestFiles } from './app/ingest.ts';
import './app/keys.ts';
import { useStore } from './app/store.ts';

// Handles for poking at the app from the console in development.
if (import.meta.env.DEV) Object.assign(window, { trace: { store: useStore, engine, ingestFiles } });

function unsupported(): string | null {
  if (!('gpu' in navigator)) return 'WebGPU';
  if (typeof VideoDecoder === 'undefined') return 'WebCodecs';
  if (!('transferControlToOffscreen' in HTMLCanvasElement.prototype)) return 'OffscreenCanvas';
  return null;
}

const root = document.getElementById('root')!;
const missing = unsupported();
if (missing) {
  root.innerHTML = `<div class="empty-state"><h2>This browser can’t run codex-motion</h2><p>It needs ${missing}. Use a recent Chrome or Edge.</p></div>`;
} else {
  createRoot(root).render(<App />);
}
