// The pill bar: the view pill (Collections and Feed toggles), then one tab
// per open collection, then global controls.

import { Crosshair, LayoutGrid, Monitor, Moon, Pause, Play, Sparkles, Sun, X } from 'lucide-react';
import { useState } from 'react';
import { IconButton } from '../ui/controls.tsx';
import { Menu, useMenu } from '../ui/popover.tsx';
import {
  activateTab,
  closeTab,
  setActiveTarget,
  setPaused,
  setTheme,
  togglePane,
  useStore,
} from './store.ts';
import { useResolvedTheme } from './theme.ts';

export function TopBar() {
  const panes = useStore((s) => s.panes);
  const tabs = useStore((s) => s.tabs);
  const paused = useStore((s) => s.paused);
  const user = useStore((s) => s.user);
  return (
    <header className="topbar">
      <div className="topbar-start" />
      <div className="topbar-center">
        <div className="view-pill" role="group" aria-label="Panes">
          <button type="button" aria-pressed={panes.collections} onClick={() => togglePane('collections')}>
            <LayoutGrid size={14} />
            Collections
          </button>
          <button type="button" aria-pressed={panes.feed} onClick={() => togglePane('feed')}>
            <Sparkles size={14} />
            Feed
          </button>
        </div>
        {tabs.length > 0 && (
          <nav className="tab-row" aria-label="Open collections">
            {tabs.map((id) => (
              <CollectionTab key={id} id={id} />
            ))}
          </nav>
        )}
      </div>
      <div className="topbar-end">
        <IconButton label={paused ? 'Play all (Space)' : 'Pause all (Space)'} onClick={() => setPaused(!paused)}>
          {paused ? <Play size={15} /> : <Pause size={15} />}
        </IconButton>
        <ThemeButton />
        <span className="avatar" style={{ background: user.color }} title={user.name}>
          {user.name.slice(0, 1)}
        </span>
      </div>
    </header>
  );
}

function CollectionTab({ id }: { id: string }) {
  const c = useStore((s) => s.collections[id]);
  const active = useStore((s) => s.activeTab === id);
  const target = useStore((s) => s.user.activeTargetId === id);
  const menu = useMenu();
  if (!c) return null;
  return (
    <>
      <div
        className={`tab ${active ? 'active' : ''}`}
        onMouseDown={(e) => {
          // Middle click closes, as in a browser.
          if (e.button === 1) {
            e.preventDefault();
            closeTab(id);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          menu.open({ x: e.clientX, y: e.clientY });
        }}
      >
        <button type="button" className="tab-main" aria-current={active ? 'page' : undefined} onClick={() => activateTab(id)}>
          {target && <span className="target-dot" title="Active target" />}
          <span className="tab-name">{c.name}</span>
        </button>
        <button type="button" className="tab-close" aria-label={`Close ${c.name}`} onClick={() => closeTab(id)}>
          <X size={13} strokeWidth={2.4} />
        </button>
      </div>
      {menu.anchor && (
        <Menu
          anchor={menu.anchor}
          onClose={menu.close}
          items={[
            {
              label: target ? 'Clear active target' : 'Set as active target',
              icon: <Crosshair size={15} />,
              onSelect: () => setActiveTarget(target ? null : id),
            },
            'separator',
            { label: 'Close tab', icon: <X size={15} />, onSelect: () => closeTab(id) },
          ]}
        />
      )}
    </>
  );
}

function ThemeButton() {
  const pref = useStore((s) => s.theme);
  const resolved = useResolvedTheme();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <IconButton label="Theme" onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}>
        {resolved === 'dark' ? <Moon size={15} /> : <Sun size={15} />}
      </IconButton>
      {anchor && (
        <Menu
          anchor={anchor}
          align="end"
          onClose={() => setAnchor(null)}
          items={[
            { label: 'Light', icon: <Sun size={15} />, checked: pref === 'light', onSelect: () => setTheme('light') },
            { label: 'Dark', icon: <Moon size={15} />, checked: pref === 'dark', onSelect: () => setTheme('dark') },
            { label: 'System', icon: <Monitor size={15} />, checked: pref === 'system', onSelect: () => setTheme('system') },
          ]}
        />
      )}
    </>
  );
}
