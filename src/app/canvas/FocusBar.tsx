// Focus mode controls: play/pause, frame step, speed, a timeline with
// in/out points, the quality being shown and the info panel toggle. The
// playhead updates every frame from the engine, so it's moved through refs,
// not React state.

import { ChevronLeft, ChevronRight, Pause, Play, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { IconButton, Segmented } from '../../ui/controls.tsx';
import { engine } from '../engine.ts';
import { InfoToggle } from '../detail/InfoPanel.tsx';
import { useDetail } from '../detail/state.ts';
import { clock } from '../format.ts';
import { type FocusTarget, setFocus, useStore } from '../store.ts';
import type { BoardController } from './BoardController.ts';

const SPEEDS = [0.25, 0.5, 1, 2];

export function FocusBar({ ctrl, focus }: { ctrl: BoardController; focus: FocusTarget }) {
  const placement = useStore((s) => s.placements[focus.placementId]);
  const asset = useStore((s) => (placement ? s.assets[placement.assetId] : undefined));
  const infoPanel = useDetail((s) => s.infoPanel);
  const track = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const duration = asset?.duration ?? 1;
  const fps = asset?.fps || 30;
  const inPoint = placement?.inPoint ?? 0;
  const outPoint = placement?.outPoint ?? duration;

  useEffect(
    () =>
      engine.on((msg) => {
        if (msg.type !== 'focusTime') return;
        const pct = (msg.time / duration) * 100;
        if (head.current) head.current.style.left = `${pct}%`;
        if (time.current) time.current.textContent = clock(msg.time, fps);
      }),
    [duration, fps],
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

  const quality = asset.original ? 'Original' : asset.l2 ? `${asset.l2.height}p` : `${asset.l1.height}p`;
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
      <span className="badge neutral" title="Quality shown">
        {quality}
      </span>
      <span className="sep" />
      <InfoToggle on={infoPanel} />
      <IconButton label="Exit focus (Esc)" size="sm" onClick={() => ctrl.exitFocus()}>
        <X size={14} />
      </IconButton>
    </div>
  );
}
