import { useEffect } from 'react';
import { ingestFiles } from './ingest.ts';
import { resumeIngests } from './ingest.ts';
import { isTyping } from './keys.ts';
import { boardRegistry } from './canvas/registry.ts';
import { loadApp, useStore } from './store.ts';
import { useApplyTheme } from './theme.ts';
import { Toasts } from './toasts.tsx';
import { TopBar } from './TopBar.tsx';
import { Workspace } from './Workspace.tsx';

export function App() {
  useApplyTheme();
  const loaded = useStore((s) => s.loaded);

  useEffect(() => {
    void loadApp().then(resumeIngests);
  }, []);

  // Pasted files land in the middle of the open board.
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const files = [...(e.clipboardData?.files ?? [])];
      const board = boardRegistry.current;
      const collectionId = useStore.getState().activeTab;
      if (!files.length || !board || !collectionId) return;
      e.preventDefault();
      const { w, h } = board.viewSize;
      const [x, y] = board.camera.toWorld(w / 2, h / 2);
      void ingestFiles(files, collectionId, { x, y });
    };
    addEventListener('paste', paste);
    return () => removeEventListener('paste', paste);
  }, []);

  return (
    <div className="app">
      <TopBar />
      {loaded ? <Workspace /> : <div className="loading-screen">Loading…</div>}
      <Toasts />
    </div>
  );
}
