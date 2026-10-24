// The Feed's details view: double-click a tile and it opens over the
// workspace, playing at the best quality on hand in a plain <video>, with
// the info panel on the right. Arrows step through the Feed's order; Esc,
// the close button or a double-click on the video closes it.

import { Check, ChevronLeft, ChevronRight, Crosshair, Pause, Play, Plus, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AssetRecord } from '../../data/model.ts';
import { mediaUrl } from '../../data/media.ts';
import type { VideoRendition } from '../../media/library.ts';
import { Button, IconButton, Segmented } from '../../ui/controls.tsx';
import { addAssets } from '../actions.ts';
import { AddToPopover } from '../feed/FeedPane.tsx';
import { clock } from '../format.ts';
import { isTyping, spaceTap } from '../keys.ts';
import { useStore } from '../store.ts';
import { CommentMarkers } from './ClipComments.tsx';
import { type Playhead, useWatchClipComments, videoPlayhead } from './comments.ts';
import { InfoPanel, InfoToggle } from './InfoPanel.tsx';
import { closeDetail, stepDetail, useDetail } from './state.ts';

const SPEEDS = [0.25, 0.5, 1, 2];

// The sharpest rendition a <video> can play here: OPFS paths can't be.
function best(a: AssetRecord): VideoRendition {
  for (const r of [a.original, a.l2, a.l1]) if (r?.url && !r.url.startsWith('opfs:')) return r;
  return a.l1;
}

export function DetailView() {
  const open = useDetail((s) => s.open);
  const asset = useStore((s) => (open ? s.assets[open.assetId] : undefined));
  if (!open || !asset) return null;
  return <Detail asset={asset} index={open.ids.indexOf(asset.id)} count={open.ids.length} />;
}

function Detail({ asset, index, count }: { asset: AssetRecord; index: number; count: number }) {
  const infoPanel = useDetail((s) => s.infoPanel);
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const player = useMemo(() => (video ? videoPlayhead(video) : undefined), [video]);
  useWatchClipComments(asset.id);

  useEffect(() => root.current?.focus({ preventScroll: true }), []);

  // Opening a collection or changing panes means looking elsewhere.
  const activeTab = useStore((s) => s.activeTab);
  const panes = useStore((s) => s.panes);
  const opened = useRef({ activeTab, panes });
  useEffect(() => {
    if (activeTab !== opened.current.activeTab || panes !== opened.current.panes) closeDetail();
  }, [activeTab, panes]);

  // The video keeps the clip's aspect, as large as the stage allows.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const aspect = asset.width / asset.height || 16 / 9;
      const w = Math.min(el.clientWidth, el.clientHeight * aspect);
      setBox({ w: Math.floor(w), h: Math.floor(w / aspect) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [asset.width, asset.height]);

  const togglePlay = () => {
    if (!video) return;
    if (video.paused) void video.play();
    else video.pause();
  };

  const step = (frames: number) => {
    if (!video) return;
    video.pause();
    video.currentTime = Math.min(asset.duration, Math.max(0, video.currentTime + frames / (asset.fps || 30)));
  };

  // Space taps play and pause the clip here rather than the whole app.
  const toggleRef = useRef(togglePlay);
  toggleRef.current = togglePlay;
  useEffect(() => {
    const prev = spaceTap.focus;
    const mine = () => toggleRef.current();
    spaceTap.focus = mine;
    return () => {
      if (spaceTap.focus === mine) spaceTap.focus = prev;
    };
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') closeDetail();
      else if (e.key === 'ArrowLeft') stepDetail(-1);
      else if (e.key === 'ArrowRight') stepDetail(1);
      else if (e.key === ',' || e.key === '.') step(e.key === ',' ? -1 : 1);
      else return;
      e.preventDefault();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });

  const r = best(asset);

  return (
    <div className="detail" ref={root} tabIndex={-1} role="dialog" aria-label={asset.name}>
      <div className="detail-stage">
        <div className="detail-top">
          <IconButton label="Close (Esc)" raised onClick={closeDetail}>
            <X size={15} />
          </IconButton>
          {count > 1 && index >= 0 && (
            <span className="detail-count">
              {(index + 1).toLocaleString()} / {count.toLocaleString()}
            </span>
          )}
        </div>
        {count > 1 && (
          <>
            <IconButton label="Previous clip (←)" raised className="detail-nav prev" onClick={() => stepDetail(-1)}>
              <ChevronLeft size={16} />
            </IconButton>
            <IconButton label="Next clip (→)" raised className="detail-nav next" onClick={() => stepDetail(1)}>
              <ChevronRight size={16} />
            </IconButton>
          </>
        )}
        <div className="detail-frame" ref={frame}>
          <video
            key={asset.id}
            ref={setVideo}
            className="detail-video"
            src={mediaUrl(r.url)}
            style={{ width: box.w, height: box.h }}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            onClick={togglePlay}
            onDoubleClick={closeDetail}
          />
        </div>
        {video && player && <VideoBar video={video} player={player} asset={asset} rendition={r} infoPanel={infoPanel} />}
      </div>
      {infoPanel && <DetailInfo asset={asset} player={player} />}
    </div>
  );
}

// Play/pause, frame step, a scrubbable timeline with comment markers, speed,
// quality, and the info panel toggle. The playhead moves every frame,
// through refs.
function VideoBar({
  video,
  player,
  asset,
  rendition,
  infoPanel,
}: {
  video: HTMLVideoElement;
  player: Playhead;
  asset: AssetRecord;
  rendition: VideoRendition;
  infoPanel: boolean;
}) {
  const [playing, setPlaying] = useState(!video.paused);
  const [speed, setSpeed] = useState(video.playbackRate);
  const track = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const fps = asset.fps || 30;
  const duration = asset.duration || 1;

  useEffect(() => {
    const sync = () => {
      setPlaying(!video.paused);
      setSpeed(video.playbackRate);
    };
    sync();
    video.addEventListener('play', sync);
    video.addEventListener('pause', sync);
    video.addEventListener('ratechange', sync);
    let raf = requestAnimationFrame(function tick() {
      const t = video.currentTime;
      if (head.current) head.current.style.left = `${Math.min(100, (t / duration) * 100)}%`;
      if (time.current) time.current.textContent = clock(t, fps);
      raf = requestAnimationFrame(tick);
    });
    return () => {
      video.removeEventListener('play', sync);
      video.removeEventListener('pause', sync);
      video.removeEventListener('ratechange', sync);
      cancelAnimationFrame(raf);
    };
  }, [video, duration, fps]);

  const scrub = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const go = (x: number) => {
      const b = track.current!.getBoundingClientRect();
      video.currentTime = Math.min(1, Math.max(0, (x - b.left) / b.width)) * duration;
    };
    go(e.clientX);
    const move = (ev: PointerEvent) => go(ev.clientX);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const stepFrames = (n: number) => {
    video.pause();
    video.currentTime = Math.min(duration, Math.max(0, video.currentTime + n / fps));
  };

  return (
    <div className="focus-bar float-bar detail-bar">
      <IconButton label={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={() => (video.paused ? void video.play() : video.pause())}>
        {playing ? <Pause size={15} /> : <Play size={15} />}
      </IconButton>
      <IconButton label="Previous frame (,)" size="sm" onClick={() => stepFrames(-1)}>
        <ChevronLeft size={15} />
      </IconButton>
      <IconButton label="Next frame (.)" size="sm" onClick={() => stepFrames(1)}>
        <ChevronRight size={15} />
      </IconButton>
      <span ref={time} className="focus-time">
        {clock(0, fps)}
      </span>
      <div className="timeline" ref={track} onPointerDown={scrub}>
        <CommentMarkers asset={asset} player={player} />
        <div className="timeline-head" ref={head} />
      </div>
      <span className="focus-duration">{clock(duration, fps)}</span>
      <Segmented
        label="Speed"
        value={speed}
        onChange={(s) => (video.playbackRate = s)}
        options={SPEEDS.map((s) => ({ value: s, label: s === 0.25 ? '¼×' : s === 0.5 ? '½×' : `${s}×` }))}
      />
      <span className="badge neutral" title="Quality shown">
        {rendition === asset.original ? 'Original' : `${rendition.height}p`}
      </span>
      <span className="sep" />
      <InfoToggle on={infoPanel} />
    </div>
  );
}

// The info panel with "Add to" for the Feed.
function DetailInfo({ asset, player }: { asset: AssetRecord; player?: Playhead }) {
  const target = useStore((s) => (s.user.activeTargetId ? s.collections[s.user.activeTargetId] : null));
  const readonly = useStore((s) => s.mode === 'public');
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [added, setAdded] = useState<{ id: string; to?: string } | null>(null);
  const done = added?.id === asset.id;

  const add = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!target) return setAnchor(e.currentTarget);
    addAssets(target.id, [asset.id]);
    setAdded({ id: asset.id, to: target.name });
  };

  const actions = readonly ? null : (
    <Button variant={done ? 'secondary' : 'primary'} size="sm" onClick={add}>
      {done ? <Check size={14} strokeWidth={2.4} /> : target ? <Crosshair size={14} strokeWidth={2.4} /> : <Plus size={15} strokeWidth={2.4} />}
      <span className="info-add-label">{done ? (added?.to ? `Added to ${added.to}` : 'Added') : target ? `Add to ${target.name}` : 'Add to…'}</span>
    </Button>
  );

  return (
    <>
      <InfoPanel asset={asset} actions={actions} player={player} />
      {anchor && (
        <AddToPopover
          anchor={anchor}
          assetIds={[asset.id]}
          onClose={() => setAnchor(null)}
          onAdded={() => setAdded({ id: asset.id })}
        />
      )}
    </>
  );
}
