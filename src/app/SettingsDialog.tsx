// Settings, from the account menu: appearance, board behaviour and, for
// admins, dev tools (devtools.ts). Everything here applies at once and is
// kept per browser.

import '../styles/settings.css';
import type { ReactNode } from 'react';
import { Segmented, Switch } from '../ui/controls.tsx';
import { Dialog } from '../ui/dialog.tsx';
import { setDevTools, useDevTools } from './devtools.ts';
import { setTheme, type Theme, updatePrefs, useStore } from './store.ts';

function Setting({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="setting-text">
        <div className="setting-title">{title}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const theme = useStore((s) => s.theme);
  const snap = useStore((s) => s.snap);
  const scrub = useStore((s) => s.scrubOnHover);
  const hud = useStore((s) => s.hud);
  const admin = useDevTools((s) => s.admin);
  const dev = useDevTools((s) => s.enabled);
  return (
    <Dialog title="Settings" onClose={onClose}>
      <section className="settings-section">
        <h3>Appearance</h3>
        <Setting title="Theme">
          <Segmented<Theme>
            label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        </Setting>
      </section>
      <section className="settings-section">
        <h3>Boards</h3>
        <Setting title="Snap to grid">
          <Switch label="Snap to grid" checked={snap} onChange={(v) => updatePrefs({ snap: v })} />
        </Setting>
        <Setting title="Scrub on hover" hint="Moving the pointer across a clip scrubs through it.">
          <Switch label="Scrub on hover" checked={scrub} onChange={(v) => updatePrefs({ scrubOnHover: v })} />
        </Setting>
        <Setting title="Performance overlay" hint="Renderer stats and the benchmark, over the board. Toggle with `.">
          <Switch label="Performance overlay" checked={hud} onChange={(v) => updatePrefs({ hud: v })} />
        </Setting>
      </section>
      {admin && (
        <section className="settings-section">
          <h3>Developer</h3>
          <Setting title="Dev tools" hint="Right-click clips in the Feed to delete them from the database, for everyone, files included.">
            <Switch label="Dev tools" checked={dev} onChange={setDevTools} />
          </Setting>
        </section>
      )}
    </Dialog>
  );
}
