// The Feed's search: a bar of filter chips and free text with suggestions as
// you type, and a panel that opens below it with the fuzziness slider, sort
// and every facet with its counts.
//
// Typed text matches words; `studio:koto` or picking a suggestion turns into
// a chip (a hard filter). Fuzziness decides how loosely words match and how
// far results reach on looks alone.

import { Loader2, Search, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchQuery, SearchResult, SortMode, Suggestion } from '../../search/engine.ts';
import { COLORS, FACETS, type FacetKey, facetByAlias, facetDef, valueLabel } from '../../search/taxonomy.ts';
import { Segmented } from '../../ui/controls.tsx';
import { isTyping } from '../keys.ts';
import { setFeedQuery, updatePrefs, useStore } from '../store.ts';
import '../../styles/search.css';

const FUZZ_STOPS = [
  { at: 0, label: 'Exact', hint: 'Every word, as typed' },
  { at: 0.25, label: 'Close', hint: 'Every word, allowing typos and word starts' },
  { at: 0.5, label: 'Related', hint: 'Most words, plus clips that look strongly alike' },
  { at: 0.75, label: 'Loose', hint: 'Some words, plus clips that look alike' },
  { at: 1, label: 'Wide', hint: 'Anything with a resemblance' },
];

export const fuzzStop = (f: number) => FUZZ_STOPS.reduce((best, s) => (Math.abs(s.at - f) < Math.abs(best.at - f) ? s : best));

export const isSearching = (q: SearchQuery) => !!q.text.trim() || q.similar.length > 0 || Object.values(q.filters).some((v) => v?.length);

const filterCount = (q: SearchQuery) => Object.values(q.filters).reduce((n, v) => n + (v?.length ?? 0), 0);

function withFilter(q: SearchQuery, facet: FacetKey, value: string, on: boolean): Partial<SearchQuery> {
  const cur = q.filters[facet] ?? [];
  const next = on ? [...new Set([...cur, value])] : cur.filter((v) => v !== value);
  const filters = { ...q.filters, [facet]: next };
  if (!next.length) delete filters[facet];
  return { filters };
}

// `alias:value` tokens the engine resolved, moved out of the text into chips.
function promoteParsed(q: SearchQuery, result: SearchResult | null): Partial<SearchQuery> | null {
  if (!result?.parsed.length) return null;
  let filters = q.filters;
  for (const { facet, value } of result.parsed) filters = withFilter({ ...q, filters }, facet, value, true).filters!;
  const text = q.text.replace(/(^|\s)-?([a-z]+):("[^"]*"?|\S+)/gi, (m, lead: string, alias: string) => (facetByAlias(alias) ? lead : m)).replace(/\s+/g, ' ').trimStart();
  return { filters, text };
}

function Swatch({ value }: { value: string }) {
  const c = COLORS.find((x) => x.value === value);
  return <span className="fs-swatch" style={{ background: c?.swatch }} />;
}

// ---- the bar ---------------------------------------------------------------------

export function SearchBar({ result, count, names }: { result: SearchResult | null; count: number; names: (id: string) => string }) {
  const query = useStore((s) => s.feedQuery);
  const open = useStore((s) => s.feedSearchOpen);
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [dismissed, setDismissed] = useState(false);

  const suggestions = focused && !dismissed && query.text.trim() ? (result?.suggestions ?? []) : [];
  const chips = useMemo(() => FACETS.flatMap((def) => (query.filters[def.key] ?? []).map((value) => ({ facet: def.key, value }))), [query.filters]);
  const active = isSearching(query);

  useEffect(() => setHighlight(-1), [query.text]);

  // "/" jumps to the search from anywhere outside a text field.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || isTyping(e.target)) return;
      e.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);

  const apply = (s: Suggestion) => {
    const words = query.text.trimEnd().split(/\s+/);
    const text = s.replace === 'all' ? '' : `${words.slice(0, -1).join(' ')} `.trimStart();
    setFeedQuery({ ...withFilter(query, s.facet, s.value, true), text });
    setHighlight(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && suggestions.length) {
      e.preventDefault();
      setDismissed(false);
      setHighlight((h) => (h + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && suggestions.length) {
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? suggestions.length - 1 : h - 1));
    } else if ((e.key === 'Enter' || e.key === 'Tab') && highlight >= 0 && suggestions[highlight]) {
      e.preventDefault();
      apply(suggestions[highlight]);
    } else if (e.key === 'Enter') {
      const promoted = promoteParsed(query, result);
      if (promoted) setFeedQuery(promoted);
      setDismissed(true);
    } else if (e.key === 'Escape') {
      if (suggestions.length) setDismissed(true);
      else if (query.text) setFeedQuery({ text: '' });
      else input.current?.blur();
    } else if (e.key === 'Backspace' && !query.text && input.current?.selectionStart === 0) {
      if (query.similar.length) setFeedQuery({ similar: [] });
      else if (chips.length) {
        const last = chips[chips.length - 1];
        setFeedQuery(withFilter(query, last.facet, last.value, false));
      }
    } else if (e.key === ' ' && result?.parsed.length) {
      // A finished `client:nike` becomes a chip.
      const promoted = promoteParsed(query, result);
      if (promoted) {
        e.preventDefault();
        setFeedQuery(promoted);
      }
    }
  };

  const nFilters = filterCount(query);
  return (
    <div className={`fs ${focused ? 'focused' : ''}`}>
      <div className="fs-bar" onPointerDown={(e) => e.target === e.currentTarget && (e.preventDefault(), input.current?.focus())}>
        <Search size={14} className="fs-icon" />
        {query.similar.length > 0 && (
          <span className="fs-chip similar" title={query.similar.map(names).join('\n')}>
            <Sparkles size={11} />
            <span className="v">
              Like {names(query.similar[0])}
              {query.similar.length > 1 ? ` +${query.similar.length - 1}` : ''}
            </span>
            <button type="button" aria-label="Remove" onClick={() => setFeedQuery({ similar: [] })}>
              <X size={11} strokeWidth={2.5} />
            </button>
          </span>
        )}
        {chips.map(({ facet, value }) => (
          <span key={`${facet}:${value}`} className="fs-chip">
            {facet === 'color' && <Swatch value={value} />}
            <span className="k">{facetDef(facet).label}</span>
            <span className="v">{valueLabel(facet, value)}</span>
            <button type="button" aria-label={`Remove ${valueLabel(facet, value)}`} onClick={() => setFeedQuery(withFilter(query, facet, value, false))}>
              <X size={11} strokeWidth={2.5} />
            </button>
          </span>
        ))}
        <input
          ref={input}
          value={query.text}
          placeholder={chips.length || query.similar.length ? 'Refine…' : 'Search clips, studios, clients, techniques…'}
          spellCheck={false}
          aria-label="Search the Feed"
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          onChange={(e) => {
            setDismissed(false);
            setFeedQuery({ text: e.target.value });
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {result?.semantic === 'pending' && <Loader2 size={13} className="fs-pending" aria-label="Matching by look…" />}
        <span className="fs-count" title={active ? `${count} of ${result?.total ?? count} clips` : undefined}>
          {count.toLocaleString()}
        </span>
        {active && (
          <button type="button" className="fs-clear" aria-label="Clear search" title="Clear search" onClick={() => setFeedQuery({ text: '', filters: {}, similar: [] })}>
            <X size={13} strokeWidth={2.4} />
          </button>
        )}
        <button
          type="button"
          className="fs-toggle"
          aria-pressed={open}
          aria-label="Filters"
          title="Filters and fuzziness"
          onClick={() => updatePrefs({ feedSearchOpen: !open })}
        >
          <SlidersHorizontal size={14} />
          {nFilters > 0 && <span className="fs-badge">{nFilters}</span>}
        </button>
      </div>
      {suggestions.length > 0 && (
        <div className="fs-suggest" role="listbox">
          {suggestions.map((s, i) => (
            <button
              key={`${s.facet}:${s.value}`}
              type="button"
              role="option"
              aria-selected={i === highlight}
              className="fs-option"
              onPointerDown={(e) => e.preventDefault()}
              onPointerEnter={() => setHighlight(i)}
              onClick={() => apply(s)}
            >
              <span className="k">{facetDef(s.facet).label}</span>
              {s.facet === 'color' && <Swatch value={s.value} />}
              <span className="v">{s.label}</span>
              <span className="n">{s.count.toLocaleString()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- the panel -------------------------------------------------------------------

const SHOWN = 10;

export function SearchPanel({ result }: { result: SearchResult | null }) {
  const query = useStore((s) => s.feedQuery);
  const [expanded, setExpanded] = useState<Partial<Record<FacetKey, boolean>>>({});
  const ranked = !!query.text.trim() || query.similar.length > 0;
  const stop = fuzzStop(query.fuzziness);
  const looks = result ? result.ids.length - result.textMatches : 0;

  return (
    <div className="fs-panel">
      <div className="fs-controls">
        <label className={`fs-fuzz ${ranked ? '' : 'idle'}`} title={ranked ? stop.hint : 'Fuzziness applies to typed text and “Similar” searches'}>
          <span className="fs-label">Fuzziness</span>
          <span className="fs-end">Exact</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={query.fuzziness}
            style={{ '--fill': `${query.fuzziness * 100}%` } as React.CSSProperties}
            onChange={(e) => setFeedQuery({ fuzziness: Number(e.target.value) })}
          />
          <span className="fs-end">Wide</span>
          <span className="fs-stop">{stop.label}</span>
        </label>
        <Segmented<SortMode>
          label="Order"
          value={query.sort}
          options={[
            { value: 'relevance', label: 'Best match' },
            { value: 'shuffle', label: 'Shuffle' },
            { value: 'newest', label: 'Newest' },
          ]}
          onChange={(sort) => setFeedQuery({ sort })}
        />
      </div>
      {ranked && result && (
        <div className="fs-summary">
          {result.textMatches > 0 && <span>{result.textMatches.toLocaleString()} match the words</span>}
          {looks > 0 && <span>{looks.toLocaleString()} look related</span>}
          {result.semantic === 'off' && query.text.trim() && <span className="muted">visual matching unavailable</span>}
        </div>
      )}
      <div className="fs-facets">
        {FACETS.map((def) => {
          const values = result?.facets[def.key] ?? [];
          if (!values.length) return null;
          const selected = new Set(query.filters[def.key] ?? []);
          const isOpen = expanded[def.key] || values.length <= SHOWN + 2;
          const shown = isOpen ? values : values.filter(([v], i) => i < SHOWN || selected.has(v));
          return (
            <section key={def.key} className={`fs-facet ${def.key}`}>
              <h3>
                {def.label}
                {selected.size > 0 && (
                  <button type="button" className="fs-reset" onClick={() => setFeedQuery({ filters: Object.fromEntries(Object.entries(query.filters).filter(([k]) => k !== def.key)) })}>
                    Clear
                  </button>
                )}
              </h3>
              <div className={`fs-values ${isOpen && values.length > 40 ? 'long' : ''}`}>
                {shown.map(([value, n]) => (
                  <button
                    key={value}
                    type="button"
                    className="fs-value"
                    aria-pressed={selected.has(value)}
                    disabled={!n && !selected.has(value)}
                    title={def.key === 'color' ? valueLabel(def.key, value) : undefined}
                    onClick={() => setFeedQuery(withFilter(query, def.key, value, !selected.has(value)))}
                  >
                    {def.key === 'color' && <Swatch value={value} />}
                    <span className="v">{valueLabel(def.key, value)}</span>
                    <span className="n">{n.toLocaleString()}</span>
                  </button>
                ))}
                {values.length > SHOWN + 2 && (
                  <button type="button" className="fs-more" onClick={() => setExpanded((x) => ({ ...x, [def.key]: !isOpen }))}>
                    {isOpen ? 'Fewer' : `${values.length - SHOWN} more`}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
