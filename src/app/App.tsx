import { useEffect, useState } from 'react';
import { remoteEnabled } from '../config.ts';
import { enabledProviders, signInWithEmail, signInWithGoogle, useAuth } from '../data/supabase.ts';
import { Button } from '../ui/controls.tsx';
import { boardRegistry } from './canvas/registry.ts';
import { ingestFiles, resumeIngests, uploadPending } from './ingest.ts';
import { isTyping } from './keys.ts';
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
  const [providers, setProviders] = useState<{ google: boolean; email: boolean } | null>(null);
  const [email, setEmail] = useState('');
  const [state, setState] = useState<{ busy?: boolean; sent?: string; error?: string }>({});
  useEffect(() => {
    void enabledProviders().then(setProviders);
  }, []);

  const sendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    const address = email.trim();
    if (!address) return;
    setState({ busy: true });
    try {
      await signInWithEmail(address);
      setState({ sent: address });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ error: /rate limit/i.test(message) ? 'Too many sign-in emails for now. Try again in a little while.' : message });
    }
  };

  return (
    <div className="signin">
      <div className="signin-card">
        <h1>codex-motion</h1>
        {state.sent ? (
          <>
            <p>
              Check <strong>{state.sent}</strong> for a sign-in link. Open it in this browser.
            </p>
            <button type="button" className="btn ghost sm" onClick={() => setState({})}>
              Use a different email
            </button>
          </>
        ) : (
          <>
            <p>A reference canvas where every clip plays at once.</p>
            {providers?.google && (
              <Button variant="primary" onClick={() => void signInWithGoogle()}>
                <GoogleMark />
                Continue with Google
              </Button>
            )}
            {providers?.google && providers.email && <span className="signin-or">or</span>}
            {(providers?.email ?? true) && (
              <form className="signin-email" onSubmit={sendLink}>
                <input
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-label="Email"
                />
                <Button type="submit" variant={providers?.google ? 'secondary' : 'primary'} disabled={state.busy}>
                  Email me a sign-in link
                </Button>
              </form>
            )}
            {state.error && <p className="signin-error">{state.error}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function GoogleMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
