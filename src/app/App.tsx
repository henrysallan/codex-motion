import { useEffect, useState } from 'react';
import { remoteEnabled } from '../config.ts';
import { useAuth } from '../data/supabase.ts';
import { boardRegistry } from './canvas/registry.ts';
import { DetailView } from './detail/DetailView.tsx';
import { purgeDeleted } from './deleteUpload.ts';
import { ingestFiles, resumeIngests, uploadPending } from './ingest.ts';
import { isTyping } from './keys.ts';
import { SignInForm } from './SignInForm.tsx';
import { loadApp, loadPublic, loadRemote, useStore } from './store.ts';
import { useApplyTheme } from './theme.ts';
import { Toasts } from './toasts.tsx';
import { TopBar } from './TopBar.tsx';
import { Workspace } from './Workspace.tsx';

// /c/<slug> is a published collection; everything else is the app.
const publicSlug = location.pathname.match(/^\/c\/([a-z0-9-]+)\/?$/)?.[1] ?? null;

export function App() {
  useApplyTheme();
  if (publicSlug) return <PublicApp slug={publicSlug} />;
  if (remoteEnabled) return <RemoteApp />;
  return <LocalApp />;
}

function Shell() {
  const loaded = useStore((s) => s.loaded);
  return (
    <div className="app">
      <TopBar />
      {loaded ? <Workspace /> : <div className="loading-screen">Loading…</div>}
      {loaded && <DetailView />}
      <Toasts />
    </div>
  );
}

function usePasteToBoard() {
  // Pasted files land in the middle of the open board.
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      if (isTyping(e.target)) return;
      const files = [...(e.clipboardData?.files ?? [])];
      const board = boardRegistry.current;
      const collectionId = useStore.getState().activeTab;
      if (!files.length || !board || !collectionId || board.readonly) return;
      e.preventDefault();
      const { w, h } = board.viewSize;
      const [x, y] = board.camera.toWorld(w / 2, h / 2);
      void ingestFiles(files, collectionId, { x, y });
    };
    addEventListener('paste', paste);
    return () => removeEventListener('paste', paste);
  }, []);
}

function LocalApp() {
  usePasteToBoard();
  useEffect(() => {
    void loadApp().then(resumeIngests);
  }, []);
  return <Shell />;
}

function RemoteApp() {
  const { session, ready } = useAuth();
  const userId = session?.user.id ?? null;
  usePasteToBoard();
  useEffect(() => {
    if (!userId) return;
    loadRemote(userId)
      .then(() => {
        resumeIngests();
        void uploadPending();
        void purgeDeleted();
      })
      .catch((e: unknown) => {
        console.error(e);
        useStore.setState({ loaded: true });
      });
  }, [userId]);
  if (!ready) return <div className="loading-screen">Loading…</div>;
  if (!session) return <SignIn />;
  return <Shell />;
}

function PublicApp({ slug }: { slug: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  useEffect(() => {
    loadPublic(slug).then(
      (found) => setState(found ? 'ready' : 'missing'),
      () => setState('missing'),
    );
  }, [slug]);
  if (state === 'missing') {
    return (
      <div className="signin">
        <div className="signin-card">
          <h1>Nothing at this link</h1>
          <p>This collection isn’t published, or the link has changed.</p>
          <a className="btn secondary" href="/">
            Go to codex-motion
          </a>
        </div>
      </div>
    );
  }
  return <Shell />;
}

function SignIn() {
  return (
    <div className="signin">
      <div className="signin-card">
        <h1>codex-motion</h1>
        <SignInForm intro={<p>A reference canvas where every clip plays at once.</p>} />
      </div>
    </div>
  );
}
