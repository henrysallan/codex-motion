// One clip in the Feed's database view. The engine draws its thumbnail at
// the left (the row's highlight leaves a hole for it); beside it is the
// clip's metadata in brief, as many lines as the row's height fits: title
// and length, who made it, then project type and technique tags, then the
// tagger's caption in tall rows.

import { Check } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import type { AssetRecord } from '../../data/model.ts';
import { clipInfo, useClipInfo } from '../../search/client.ts';
import { engine } from '../engine.ts';
import { fractionAcross } from '../ScrollSurface.tsx';
import { type FeedCell, ROW_INSET } from './layout.ts';

function length(s: number): string {
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}:${Math.round(s - m * 60).toString().padStart(2, '0')}`;
}

// Line heights in feed.css: title, meta, tags, caption.
const linesFor = (thumbH: number) => (thumbH >= 50 ? 3 : thumbH >= 30 ? 2 : 1);
const captionLines = (thumbH: number) => Math.min(4, Math.floor((thumbH - 52) / 14));

export function FeedRow({
  asset,
  cell,
  selected,
  collected,
  ...rest
}: { asset: AssetRecord; cell: FeedCell; selected: boolean; collected: boolean } & HTMLAttributes<HTMLDivElement>) {
  const info = useClipInfo(() => clipInfo(asset.id));
  const thumb = cell.media;
  const lines = linesFor(thumb.h);
  const caption = info?.caption && captionLines(thumb.h) > 0 ? captionLines(thumb.h) : 0;
  const title = info?.title ?? asset.sourceTitle ?? asset.name;
  const who = [info?.studios.length ? info.studios.slice(0, 2).join(', ') : info?.site, info?.client, info?.year].filter(Boolean).join(' · ');
  const format = `${asset.width}×${asset.height}`;
  const tags = info ? [...new Set([...info.projectTypes.slice(0, 2), ...info.tags.slice(0, 3)])] : [];

  return (
    <div
      className={`feed-row ${selected ? 'selected' : ''}`}
      style={{ left: cell.x, top: cell.y, width: cell.w, height: cell.h, '--tw': `${thumb.w}px`, '--th': `${thumb.h}px`, '--inset': `${ROW_INSET}px` } as React.CSSProperties}
      {...rest}
    >
      <div
        className="feed-row-thumb"
        style={{ width: thumb.w, height: thumb.h }}
        onPointerMove={(e) => engine.scrub(asset.id, fractionAcross(e))}
        onPointerLeave={() => engine.scrub(null)}
      >
        {collected && (
          <span className="added-mark" title="In a collection">
            <Check size={11} strokeWidth={3} />
          </span>
        )}
      </div>
      <div className="feed-row-text">
        <div className="feed-row-title">
          <span className="t" title={title}>
            {title}
          </span>
          <span className="len">{length(asset.duration)}</span>
        </div>
        {lines >= 2 && <div className="feed-row-meta">{who || (info === undefined ? ' ' : format)}</div>}
        {lines >= 3 && (
          <div className="feed-row-tags">
            {tags.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))}
            {who && <span className="fmt">{format}</span>}
          </div>
        )}
        {caption > 0 && (
          <p className="feed-row-caption" style={{ WebkitLineClamp: caption }}>
            {info?.caption}
          </p>
        )}
      </div>
    </div>
  );
}
