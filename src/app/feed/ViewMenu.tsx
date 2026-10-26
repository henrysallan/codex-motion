// The Feed's view options, from the button at the end of its header: grid or
// database list, tile size, and the grid's gutter or the list's columns.
// Changes apply as the sliders move; double-click a slider to reset it.

import { LayoutGrid, Rows3 } from 'lucide-react';
import { IconButton, Segmented } from '../../ui/controls.tsx';
import { Popover, useMenu } from '../../ui/popover.tsx';
import { defaultFeedLayout, type FeedLayout, type FeedView, SIZE_MAX, SIZE_MIN } from './layout.ts';

const percent = (v: number) => `${Math.round(v * 100)}%`;

export function ViewMenu({ layout, onChange }: { layout: FeedLayout; onChange: (patch: Partial<FeedLayout>) => void }) {
  const menu = useMenu();
  const list = layout.view === 'list';
  const sizeKey = list ? 'listSize' : 'gridSize';
  const size = layout[sizeKey];
  const setSize = (v: number) => onChange(list ? { listSize: v } : { gridSize: v });
  const changed = size !== defaultFeedLayout[sizeKey] || (list ? layout.columns !== defaultFeedLayout.columns : layout.gutter !== defaultFeedLayout.gutter);

  return (
    <>
      <IconButton label="View options" pressed={!!menu.anchor} onClick={(e) => menu.toggle(e.currentTarget)}>
        {list ? <Rows3 size={15} /> : <LayoutGrid size={15} />}
      </IconButton>
      {menu.anchor && (
        <Popover anchor={menu.anchor} onClose={menu.close} align="end" width={250}>
          <div className="view-menu">
            <Segmented<FeedView>
              label="View"
              value={layout.view}
              onChange={(view) => onChange({ view })}
              options={[
                {
                  value: 'grid',
                  label: (
                    <>
                      <LayoutGrid size={12} />
                      Grid
                    </>
                  ),
                },
                {
                  value: 'list',
                  label: (
                    <>
                      <Rows3 size={12} />
                      Database
                    </>
                  ),
                },
              ]}
            />
            {/* Log scale, so halving and doubling are the same distance; catches on 100%. */}
            <Slider
              label="Size"
              min={Math.log2(SIZE_MIN)}
              max={Math.log2(SIZE_MAX)}
              step="any"
              value={Math.log2(size)}
              text={percent(size)}
              onChange={(v) => setSize(Math.abs(v) < 0.04 ? 1 : 2 ** v)}
              onReset={() => setSize(1)}
            />
            {list ? (
              <div className="vm-row">
                <span className="vm-label">Columns</span>
                <Segmented<1 | 2>
                  label="Columns"
                  value={layout.columns}
                  onChange={(columns) => onChange({ columns })}
                  options={[
                    { value: 1, label: '1' },
                    { value: 2, label: '2' },
                  ]}
                />
              </div>
            ) : (
              <Slider
                label="Gutter"
                min={0}
                max={1}
                step={0.01}
                value={layout.gutter}
                text={percent(layout.gutter)}
                // Catches on the default on the way past.
                onChange={(g) => onChange({ gutter: Math.abs(g - defaultFeedLayout.gutter) < 0.015 ? defaultFeedLayout.gutter : g })}
                onReset={() => onChange({ gutter: defaultFeedLayout.gutter })}
              />
            )}
            {changed && (
              <button
                type="button"
                className="vm-reset"
                onClick={() =>
                  onChange(list ? { listSize: defaultFeedLayout.listSize, columns: defaultFeedLayout.columns } : { gridSize: defaultFeedLayout.gridSize, gutter: defaultFeedLayout.gutter })
                }
              >
                Reset
              </button>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  text,
  onChange,
  onReset,
}: {
  label: string;
  min: number;
  max: number;
  step: number | 'any';
  value: number;
  text: string;
  onChange: (v: number) => void;
  onReset: () => void;
}) {
  return (
    <label className="vm-row" onDoubleClick={onReset}>
      <span className="vm-label">{label}</span>
      <input
        type="range"
        className="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="vm-value">{text}</span>
    </label>
  );
}
