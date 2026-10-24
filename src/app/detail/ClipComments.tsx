// The info panel's comments tab: the clip's comments in timeline order,
// each with the timecode it was left at (click it to jump there), and a box
// at the bottom that comments at the player's current moment. Typing pauses
// the clip so the moment holds still.

import { ArrowUp, MessageCircle, Trash2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ClipComment } from '../../data/clipComments.ts';
import type { Author } from '../../data/comments.ts';
import type { AssetRecord } from '../../data/model.ts';
import { useAuth } from '../../data/supabase.ts';
import { IconButton } from '../../ui/controls.tsx';
import { Menu, Popover } from '../../ui/popover.tsx';
import { AuthorAvatar } from '../comments/CommentsLayer.tsx';
import { clock, timeAgo } from '../format.ts';
import { SignInForm } from '../SignInForm.tsx';
import { authorOf, commentsOf, jumpTo, type Playhead, postClipComment, removeClipComment, useClipComments } from './comments.ts';

const UNKNOWN: Author = { id: '', name: 'Someone', avatarUrl: null, color: '#a3a2a7' };

export function ClipComments({ asset, player }: { asset: AssetRecord; player?: Playhead }) {
  const all = useClipComments((s) => s.comments);
  const authors = useClipComments((s) => s.authors);
  const loaded = useClipComments((s) => !!s.loaded[asset.id]);
  const selected = useClipComments((s) => s.selected);
  const userId = useAuth().session?.user.id ?? null;
  const comments = useMemo(() => commentsOf(asset.id, all), [asset.id, all]);
  const list = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; id: string } | null>(null);
  const [signIn, setSignIn] = useState<HTMLElement | null>(null);
  const fps = asset.fps || 30;

  // The highlighted comment in view: one just posted, or jumped to from a
  // timeline marker.
  useEffect(() => {
    if (selected) list.current?.querySelector(`[data-id="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  return (
    <div className="clip-comments">
      <div className="clip-comment-list" ref={list}>
        {!loaded && comments.length === 0 ? (
          <div className="info-skeleton clip-comment-skeleton" aria-hidden>
            <span style={{ width: '80%' }} />
            <span style={{ width: '62%' }} />
            <span style={{ width: '72%' }} />
          </div>
        ) : comments.length === 0 ? (
          <div className="clip-comment-empty">
            <MessageCircle size={18} />
            <strong>No comments yet</strong>
            <p>Scrub to a moment and leave a note. It keeps the timecode.</p>
          </div>
        ) : (
          comments.map((c) => (
            <Item
              key={c.id}
              comment={c}
              author={authorOf(c, authors) ?? UNKNOWN}
              fps={fps}
              selected={c.id === selected}
              onJump={() => jumpTo(c, player)}
              onDelete={c.authorId === userId ? (anchor) => setMenu({ anchor, id: c.id }) : undefined}
            />
          ))
        )}
      </div>
      {userId ? (
        <Composer key={asset.id} assetId={asset.id} fps={fps} player={player} />
      ) : (
        <div className="clip-composer signed-out">
          <button type="button" className="btn secondary sm" onClick={(e) => setSignIn(e.currentTarget)}>
            Sign in to comment
          </button>
        </div>
      )}
      {menu && (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={[{ label: 'Delete comment', icon: <Trash2 size={15} />, danger: true, onSelect: () => void removeClipComment(menu.id) }]}
        />
      )}
      {signIn && (
        <Popover anchor={signIn} onClose={() => setSignIn(null)} width={260}>
          <div className="comment-signin">
            <SignInForm
              intro={
                <>
                  <strong>Sign in to comment</strong>
                  <p>Comments show your name and picture.</p>
                </>
              }
            />
          </div>
        </Popover>
      )}
    </div>
  );
}

function Item({
  comment,
  author,
  fps,
  selected,
  onJump,
  onDelete,
}: {
  comment: ClipComment;
  author: Author;
  fps: number;
  selected: boolean;
  onJump: () => void;
  onDelete?: (anchor: HTMLElement) => void;
}) {
  const stamp = clock(comment.time, fps);
  return (
    <div className={`clip-comment ${selected ? 'selected' : ''}`} data-id={comment.id}>
      <AuthorAvatar author={author} />
      <div className="comment-main">
        <div className="comment-meta">
          <strong>{author.name}</strong>
          <time dateTime={new Date(comment.createdAt).toISOString()} title={new Date(comment.createdAt).toLocaleString()}>
            {timeAgo(comment.createdAt)}
          </time>
          {onDelete && (
            <IconButton label="Delete comment" size="sm" className="comment-delete" onClick={(e) => onDelete(e.currentTarget)}>
              <Trash2 size={12} />
            </IconButton>
          )}
        </div>
        <p className="comment-body">
          <button type="button" className="clip-stamp" title={`Jump to ${stamp}`} onClick={onJump}>
            {stamp}
          </button>
          {comment.body}
        </p>
      </div>
    </div>
  );
}

function Composer({ assetId, fps, player }: { assetId: string; fps: number; player?: Playhead }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const stamp = useRef<HTMLSpanElement>(null);
  const playerRef = useRef(player);
  playerRef.current = player;

  // Grows with the text, up to a point.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
    // Chrome can leave a scrollbar behind on a box that no longer overflows.
    el.style.overflowY = el.scrollHeight > 140 ? 'auto' : 'hidden';
  }, [text]);

  // The moment a comment would be left at, live while the clip plays.
  useEffect(() => {
    let raf = requestAnimationFrame(function tick() {
      if (stamp.current) stamp.current.textContent = clock(playerRef.current?.time() ?? 0, fps);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [fps]);

  const send = async () => {
    const t = text;
    if (!t.trim()) return;
    setText('');
    if (!(await postClipComment(assetId, playerRef.current?.time() ?? 0, t))) setText((cur) => cur || t);
  };

  return (
    <form
      className="clip-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={text}
        maxLength={4000}
        placeholder="Leave a comment…"
        aria-label="Comment"
        onChange={(e) => {
          // Starting to write holds the clip on the moment being commented on.
          if (!text && e.target.value) playerRef.current?.pause();
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            e.currentTarget.blur();
          }
        }}
      />
      <div className="clip-composer-foot">
        <span className="clip-stamp live" title="The comment is left at this moment in the clip">
          <span ref={stamp}>{clock(player?.time() ?? 0, fps)}</span>
        </span>
        <button type="submit" className="comment-send" aria-label="Send" title="Send (Enter)" disabled={!text.trim()}>
          <ArrowUp size={14} strokeWidth={2.4} />
        </button>
      </div>
    </form>
  );
}

// A player timeline's comment markers. A click jumps there and shows the
// comment in the panel; a press doesn't start a scrub.
export function CommentMarkers({ asset, player }: { asset: AssetRecord; player?: Playhead }) {
  const all = useClipComments((s) => s.comments);
  const authors = useClipComments((s) => s.authors);
  const selected = useClipComments((s) => s.selected);
  const comments = useMemo(() => commentsOf(asset.id, all), [asset.id, all]);
  const duration = asset.duration || 1;
  const fps = asset.fps || 30;
  return comments.map((c) => {
    const who = (authorOf(c, authors) ?? UNKNOWN).name;
    const body = c.body.length > 120 ? `${c.body.slice(0, 119)}…` : c.body;
    return (
      <button
        key={c.id}
        type="button"
        className={`timeline-marker ${c.id === selected ? 'selected' : ''}`}
        style={{ left: `${Math.min(100, (c.time / duration) * 100)}%` }}
        title={`${clock(c.time, fps)} · ${who}: ${body}`}
        aria-label={`Comment by ${who} at ${clock(c.time, fps)}`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => jumpTo(c, player, { reveal: true })}
      />
    );
  });
}
