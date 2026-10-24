// Focus mode controls: play/pause, frame step, speed, a timeline with
// in/out points and comment markers, the quality being shown and the info
// panel toggle. The playhead and quality update every frame from the
// engine, so they're set through refs, not React state.

import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { AssetRecord } from '../../data/model.ts';
import { IconButton, Segmented } from '../../ui/controls.tsx';
import { engine } from '../engine.ts';
import { CommentMarkers } from '../detail/ClipComments.tsx';
import { focusPlayhead, useWatchClipComments } from '../detail/comments.ts';
import { InfoToggle } from '../detail/InfoPanel.tsx';
import { useDetail } from '../detail/state.ts';
import { clock } from '../format.ts';
import { type FocusTarget, setFocus, useStore } from '../store.ts';
import type { BoardController } from './BoardController.ts';

const SPEEDS = [0.25, 0.5, 1, 2];

// The badge's name for an engine tier.
function tierLabel(a: AssetRecord, tier: number): string {
  if (tier >= 3 && a.original) return 'Original';
  if (tier >= 2 && a.l2) return `${a.l2.height}p`;
  return tier >= 1 ? `${a.l1.height}p` : 'Preview';
}

// What's on screen, and what it's moving up to while that loads.
const qualityText = (a: AssetRecord, tier: number, target: number) =>
  tier < target ? `${tierLabel(a, tier)} → ${tierLabel(a, target)}` : tierLabel(a, tier);

export function FocusBar({ ctrl, focus }: { ctrl: BoardController; focus: FocusTarget }) {
  const placement = useStore((s) => s.placements[focus.placementId]);
  const asset = useStore((s) => (placement ? s.assets[placement.assetId] : undefined));
  const infoPanel = useDetail((s) => s.infoPanel);
  const track = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const quality = useRef<HTMLSpanElement>(null);
  const duration = asset?.duration ?? 1;
  const fps = asset?.fps || 30;
  const inPoint = placement?.inPoint ?? 0;
  const outPoint = placement?.outPoint ?? duration;
  const player = useMemo(() => focusPlayhead(ctrl), [ctrl]);
  useWatchClipComments(asset?.id);

  useEffect(
    () =>
      engine.on((msg) => {
        if (msg.type !== 'focusTime') return;
        const pct = (msg.time / duration) * 100;
        if (head.current) head.current.style.left = `${pct}%`;
        if (time.current) time.current.textContent = clock(msg.time, fps);
        const text = asset ? qualityText(asset, msg.tier, msg.target) : '';
        if (quality.current && quality.current.textContent !== text) quality.current.textContent = text;
      }),
    [duration, fps, asset],
  );

  if (!placement || !asset) return null;

  const timeAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * duration;
  };

  const scrub = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const go = (x: number) => ctrl.seekFocus(Math.min(outPoint - 1 / fps, Math.max(inPoint, timeAt(x))));
    go(e.clientX);
    const move = (ev: PointerEvent) => go(ev.clientX);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const dragHandle = (which: 'in' | 'out') => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const preview = el;
    let t = which === 'in' ? inPoint : outPoint;
    const move = (ev: PointerEvent) => {
      t = timeAt(ev.clientX);
      t = which === 'in' ? Math.min(t, outPoint - 2 / fps) : Math.max(t, inPoint + 2 / fps);
      preview.style.left = `${(t / duration) * 100}%`;
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (which === 'in') ctrl.setRange(t, placement.outPoint);
      else ctrl.setRange(placement.inPoint, t);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const best = asset.original ? 3 : asset.l2 ? 2 : 1;
  const ranged = placement.inPoint !== null || placement.outPoint !== null;

  return (
    <div className={`focus-bar float-bar ${infoPanel ? 'with-info' : ''}`}>
      <IconButton label={focus.playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => setFocus({ ...focus, playing: !focus.playing })}>
        {focus.playing ? <Pause size={15} /> : <Play size={15} />}
      </IconButton>
      <IconButton label="Previous frame (,)" size="sm" onClick={() => ctrl.stepFocus(-1)}>
        <ChevronLeft size={15} />
      </IconButton>
      <IconButton label="Next frame (.)" size="sm" onClick={() => ctrl.stepFocus(1)}>
        <ChevronRight size={15} />
      </IconButton>
      <span ref={time} className="focus-time">
        {clock(inPoint, fps)}
      </span>
      <div className="timeline" ref={track} onPointerDown={scrub}>
        <div className="timeline-range" style={{ left: `${(inPoint / duration) * 100}%`, width: `${((outPoint - inPoint) / duration) * 100}%` }} />
        <div className="timeline-handle in" title="In point (I)" style={{ left: `${(inPoint / duration) * 100}%` }} onPointerDown={dragHandle('in')} />
        <div className="timeline-handle out" title="Out point (O)" style={{ left: `${(outPoint / duration) * 100}%` }} onPointerDown={dragHandle('out')} />
        <CommentMarkers asset={asset} player={player} />
        <div className="timeline-head" ref={head} />
      </div>
      <span className="focus-duration">{clock(duration, fps)}</span>
      {ranged && (
        <button type="button" className="btn ghost sm" onClick={() => ctrl.setRange(null, null)}>
          Clear range
        </button>
      )}
      <Segmented
        label="Speed"
        value={focus.speed}
        onChange={(speed) => setFocus({ ...focus, speed })}
        options={SPEEDS.map((s) => ({ value: s, label: s === 0.25 ? '¼×' : s === 0.5 ? '½×' : `${s}×` }))}
      />
      <span ref={quality} className="badge neutral" title="Quality on screen">
        {qualityText(asset, 0, best)}
      </span>
      <span className="sep" />
      <InfoToggle on={infoPanel} />
      <IconButton label="Exit focus (Esc)" size="sm" onClick={() => ctrl.exitFocus()}>
        <X size={14} />
      </IconButton>
    </div>
  );
}
