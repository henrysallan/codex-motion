// What we know about a clip: the project it came from (as the site
// described it), what the tagger saw in it, and the file itself. Shown
// beside the Feed's details player and beside a clip in canvas focus mode.
// Clients, studios and tags are links into a Feed search.

import { ArrowUpRight, PanelRight, ScanSearch, Sparkles } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { AssetRecord } from '../../data/model.ts';
import { tagLabel, VOCABULARY } from '../../media/vocabulary.ts';
import { type FacetKey, splitStudios, VOCAB_FACETS } from '../../search/taxonomy.ts';
import { Button, IconButton } from '../../ui/controls.tsx';
import { searchFeed, useStore } from '../store.ts';
import { useAssetMeta } from './meta.ts';
import { closeDetail, setInfoPanel } from './state.ts';

const TAG_GROUPS: { key: string; label: string }[] = [
  { key: 'technique', label: 'Technique' },
  { key: 'camera', label: 'Camera' },
  { key: 'easing', label: 'Easing' },
  { key: 'pacing', label: 'Pacing' },
  { key: 'use', label: 'Use' },
  { key: 'visual', label: 'Visual' },
];

const PROVIDERS: Record<string, string> = { youtube: 'YouTube', vimeo: 'Vimeo', mux: 'Mux', wistia: 'Wistia', cloudflare: 'Cloudflare Stream' };

const ASPECTS = [[16, 9], [9, 16], [4, 3], [3, 4], [1, 1], [4, 5], [5, 4], [3, 2], [2, 3], [2, 1], [21, 9]];

// Scraped values are untrusted: only http(s) links get through.
const safeUrl = (u: string | undefined) => (u && /^https?:\/\//i.test(u) ? u : undefined);

function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : undefined;
  } catch {
    return undefined;
  }
}

function aspect(w: number, h: number): string {
  const r = w / h;
  const hit = ASPECTS.find(([a, b]) => Math.abs(a / b - r) < 0.012);
  return hit ? `${hit[0]}:${hit[1]}` : `${r.toFixed(2)}:1`;
}

function length(s: number): string {
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}:${Math.round(s - m * 60).toString().padStart(2, '0')}`;
}

const megabytes = (b: number) => `${(b / 1e6).toFixed(b < 10e6 ? 1 : 0)} MB`;

function day(at: string | number | undefined): string | undefined {
  const d = at === undefined ? NaN : new Date(at).getTime();
  return Number.isFinite(d) && d > 0 ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : undefined;
}

// "claude-haiku-5-5" -> "Haiku 5.5".
function modelLabel(model: string): string {
  const m = model.match(/^claude-([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : model;
}

type Search = Parameters<typeof searchFeed>[0];
// Null where there's no Feed to search (a published collection).
type Find = ((q: Search) => void) | null;

// Shows the Feed narrowed to a search, leaving the details view that would
// cover it.
function find(q: Search): void {
  searchFeed(q);
  closeDetail();
}

const facet = (key: FacetKey, value: string): Search => ({ filters: { [key]: [value] } as Partial<Record<FacetKey, string[]>> });

function definition(tag: string): string | undefined {
  const group = tag.split(':', 1)[0] as keyof typeof VOCABULARY;
  const defs = VOCABULARY[group] as Record<string, string> | undefined;
  return defs?.[tagLabel(tag)];
}

export function InfoPanel({ asset, actions }: { asset: AssetRecord; actions?: ReactNode }) {
  const { source, analysis, loading } = useAssetMeta(asset);
  const pageUrl = safeUrl(source?.pageUrl ?? asset.sourceUrl);
  const site = source?.site ?? hostOf(pageUrl);
  const clipTitle = source?.title ?? asset.name;
  const title = source?.pageTitle ?? asset.sourceTitle ?? clipTitle;
  const mediaUrl = safeUrl(source?.mediaUrl);
  const scraped = asset.origin === 'scraper' || !!source;
  const onFind: Find = useStore((s) => s.mode !== 'public') ? find : null;
  // As the search index names them: the agency's parts and the site's studio.
  const studios = [...splitStudios(source?.agency), ...(source?.siteName ? [source.siteName] : [])].filter(
    (v, i, all) => all.findIndex((w) => w.toLowerCase() === v.toLowerCase()) === i,
  );

  return (
    <aside className="info-panel" aria-label="Clip details">
      <header className="info-head">
        {site && <div className="info-site">{site}</div>}
        <h2 className="info-title">{title}</h2>
        {clipTitle !== title && <div className="info-clip">{clipTitle}</div>}
        {(pageUrl || actions || onFind) && (
          <div className="info-actions">
            {actions}
            {onFind && (
              <Button size="sm" title="Clips that look like this one, in the Feed" onClick={() => onFind({ similar: [asset.id] })}>
                <ScanSearch size={13} />
                Similar
              </Button>
            )}
            {pageUrl && (
              <a className="btn secondary sm" href={pageUrl} target="_blank" rel="noreferrer noopener" title={pageUrl}>
                Project page
                <ArrowUpRight size={13} />
              </a>
            )}
          </div>
        )}
      </header>

      <div className="info-body">
        {scraped && (
          <Section title="Project">
            {loading ? (
              <Skeleton lines={4} />
            ) : source ? (
              <>
                <Fields
                  rows={[
                    ['Client', source.client && <Value label={source.client} q={facet('client', source.client.trim())} onFind={onFind} />],
                    [
                      studios.length > 1 ? 'Studios' : 'Studio',
                      studios.length > 0 &&
                        studios.map((st, i) => (
                          <span key={st}>
                            {i > 0 && ', '}
                            <Value label={st} q={facet('studio', st)} onFind={onFind} />
                          </span>
                        )),
                    ],
                    ['Year', source.year],
                    [
                      'Source',
                      mediaUrl && (
                        <a href={mediaUrl} target="_blank" rel="noreferrer noopener" title={mediaUrl}>
                          {source.provider ? (PROVIDERS[source.provider] ?? source.provider) : hostOf(mediaUrl)}
                          <ArrowUpRight size={11} />
                        </a>
                      ),
                    ],
                  ]}
                />
                {source.description && <Description text={source.description} />}
                {source.credits && source.credits.length > 0 && (
                  <div className="info-group">
                    <div className="info-label">Credits</div>
                    <ul className="info-credits">
                      {source.credits.map((c, i) => (
                        <li key={i}>
                          <span>{c.role}</span>
                          {c.name}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {source.tags && source.tags.length > 0 && (
                  <div className="info-group">
                    <div className="info-label">Tags</div>
                    <Chips tags={source.tags.map((t) => ({ label: t, q: { text: t } }))} onFind={onFind} />
                  </div>
                )}
              </>
            ) : (
              <p className="info-empty">No project details for this clip yet.</p>
            )}
          </Section>
        )}

        <Section
          title={
            <>
              <Sparkles size={12} />
              AI tags
            </>
          }
          aside={analysis && `${modelLabel(analysis.model)}${day(analysis.at) ? ` · ${day(analysis.at)}` : ''}`}
        >
          {loading ? <Skeleton lines={3} /> : analysis ? <Analysis analysis={analysis} onFind={onFind} /> : <p className="info-empty">Not tagged yet.</p>}
        </Section>

        <Section title="File">
          <Fields
            rows={[
              ['Length', length(asset.duration)],
              ['Size', `${asset.width} × ${asset.height} · ${aspect(asset.width, asset.height)}`],
              ['Frame rate', asset.fps ? `${Math.round(asset.fps * 100) / 100} fps` : undefined],
              ['Proxies', [asset.l1, asset.l2].filter((r): r is NonNullable<typeof r> => !!r).map((r) => `${r.height}p ${r.bytes ? megabytes(r.bytes) : ''}`.trim()).join(' · ')],
              ['Original', asset.original ? `${asset.original.height}p${asset.original.bytes ? ` ${megabytes(asset.original.bytes)}` : ''}` : undefined],
              [scraped ? 'Scraped' : 'Added', day(source?.scrapedAt ?? (asset.addedAt || undefined))],
            ]}
          />
        </Section>
      </div>
    </aside>
  );
}

// Shows or hides the panel; lives in the player bars.
export function InfoToggle({ on }: { on: boolean }) {
  return (
    <IconButton label={on ? 'Hide info' : 'Show info'} size="sm" pressed={on} onClick={() => setInfoPanel(!on)}>
      <PanelRight size={14} />
    </IconButton>
  );
}

function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="info-section">
      <h3>
        {title}
        {aside && <span className="info-aside">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

function Fields({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (shown.length === 0) return null;
  return (
    <dl className="info-fields">
      {shown.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 240;
  return (
    <div className="info-group">
      <p className={`info-description ${long && !open ? 'clamped' : ''}`}>{text}</p>
      {long && (
        <button type="button" className="info-more" onClick={() => setOpen(!open)}>
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}

function Analysis({ analysis, onFind }: { analysis: NonNullable<AssetRecord['analysis']>; onFind: Find }) {
  const groups = new Map<string, string[]>();
  for (const t of analysis.tags) {
    const g = t.split(':', 1)[0];
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  const order = [...TAG_GROUPS, ...[...groups.keys()].filter((k) => !TAG_GROUPS.some((g) => g.key === k)).map((k) => ({ key: k, label: k }))];
  return (
    <>
      {analysis.caption && <p className="info-caption">{analysis.caption}</p>}
      <dl className="info-fields info-tags">
        {order
          .filter((g) => groups.has(g.key))
          .map((g) => (
            <div key={g.key}>
              <dt>{g.label}</dt>
              <dd>
                <Chips
                  tags={groups.get(g.key)!.map((t) => {
                    const label = tagLabel(t).replace(/-/g, ' ');
                    const value = t.slice(g.key.length + 1);
                    // Vocabulary tags are facets; free visual tags search as text.
                    const q = (VOCAB_FACETS as readonly string[]).includes(g.key) ? facet(g.key as FacetKey, value) : { text: label };
                    return { label, title: definition(t), q };
                  })}
                  tone={g.key === 'visual' ? 'plain' : 'vocab'}
                  onFind={onFind}
                />
              </dd>
            </div>
          ))}
      </dl>
    </>
  );
}

// A value that searches the Feed for itself when clicked.
function Value({ label, q, onFind }: { label: string; q: Search; onFind: Find }) {
  if (!onFind) return <>{label}</>;
  return (
    <button type="button" className="info-value" title={`Show “${label}” in the Feed`} onClick={() => onFind(q)}>
      {label}
    </button>
  );
}

function Chips({ tags, tone = 'plain', onFind }: { tags: { label: string; title?: string; q?: Search }[]; tone?: 'plain' | 'vocab'; onFind: Find }) {
  return (
    <div className="info-chips">
      {tags.map((t, i) =>
        onFind && t.q ? (
          <button
            type="button"
            key={`${t.label}-${i}`}
            className={`info-chip ${tone}`}
            title={t.title ? `${t.title}. Click to show in the Feed.` : `Show “${t.label}” in the Feed`}
            onClick={() => onFind(t.q!)}
          >
            {t.label}
          </button>
        ) : (
          <span key={`${t.label}-${i}`} className={`info-chip ${tone}`} title={t.title}>
            {t.label}
          </span>
        ),
      )}
    </div>
  );
}

function Skeleton({ lines }: { lines: number }) {
  return (
    <div className="info-skeleton" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <span key={i} style={{ width: `${88 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}
