// Comment pins on the board, the pin being written, and the open thread.
// They sit in the notes layer, which the controller moves with the camera,
// and scale back by the zoom so they stay one size on screen. A pin on a
// clip follows it, mid-drag too (the controller moves [data-anchor] pins).

import { ArrowUp, Hand, Maximize, MessageCircle, Trash2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { remoteEnabled } from '../../config.ts';
import type { Author, Comment } from '../../data/comments.ts';
import type { Placement } from '../../data/model.ts';
import { useAuth } from '../../data/supabase.ts';
import { IconButton } from '../../ui/controls.tsx';
import { Menu, Popover } from '../../ui/popover.tsx';
import type { BoardController, Tool } from '../canvas/BoardController.ts';
import { timeAgo } from '../format.ts';
import { SignInForm } from '../SignInForm.tsx';
import { useStore } from '../store.ts';
import {
  askToSignIn,
  canDelete,
  cancelDraft,
  dismissComments,
  openThread,
  pinPoint,
  removeComment,
  reply,
  sendDraft,
  setDraftText,
  type Spot,
  type Thread,
  threadsOf,
  useComments,
  watchComments,
} from './state.ts';

const UNKNOWN: Author = { id: '', name: 'Someone', avatarUrl: null, color: '#a3a2a7' };

export function CommentsLayer({ collectionId, tool }: { collectionId: string; tool: Tool }) {
  const comments = useComments((s) => s.comments);
  const authors = useComments((s) => s.authors);
  const open = useComments((s) => s.open);
  const draft = useComments((s) => (s.draft?.collectionId === collectionId ? s.draft : null));
  const signIn = useComments((s) => s.signIn);
  const placements = useStore((s) => s.placements);
  const userId = useAuth().session?.user.id ?? null;
  const threads = useMemo(() => threadsOf(collectionId, comments), [collectionId, comments]);

  useEffect(() => {
    const unwatch = watchComments(collectionId);
    return () => {
      unwatch();
      dismissComments();
    };
  }, [collectionId]);

  useEffect(() => {
    if (tool !== 'comment') cancelDraft();
  }, [tool]);

  // A press elsewhere or Escape closes the open thread (the comment tool's
  // own clicks on the board decide for themselves, in commentAt).
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target;
      if (!(t instanceof Element) || t.closest('[data-comment], .popover')) return;
      if (tool === 'comment' && t.closest('.board-host')) return;
      dismissComments({ keepDraft: true });
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.popover')) return;
      if (dismissComments()) e.stopPropagation();
    };
    addEventListener('pointerdown', down, true);
    addEventListener('keydown', key, true);
    return () => {
      removeEventListener('pointerdown', down, true);
      removeEventListener('keydown', key, true);
    };
  }, [tool]);

  return (
    <div className="comments-layer">
      {threads.map((t) => (
        <Pin key={t.root.id} thread={t} author={authors[t.root.authorId] ?? UNKNOWN} open={open === t.root.id} userId={userId} placements={placements} />
      ))}
      {draft && <DraftPin spot={draft.spot} text={draft.text} placements={placements} />}
      {signIn && (
        <Popover anchor={signIn} onClose={() => askToSignIn(null)} width={260}>
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

function spotAttrs(c: Pick<Spot, 'placementId' | 'px' | 'py'>) {
  return c.placementId ? { 'data-anchor': c.placementId, 'data-px': c.px ?? 0, 'data-py': c.py ?? 0 } : {};
}

function Pin({ thread, author, open, userId, placements }: { thread: Thread; author: Author; open: boolean; userId: string | null; placements: Record<string, Placement> }) {
  const { root, replies } = thread;
  const at = pinPoint(root, placements);
  return (
    <div className={`comment-spot ${open ? 'open' : ''}`} data-comment={root.id} {...spotAttrs(root)} style={{ left: at.x, top: at.y }}>
      <button type="button" className="comment-pin" aria-label={`Comment by ${author.name}`} aria-expanded={open} onClick={() => openThread(open ? null : root.id)}>
        <AuthorAvatar author={author} />
        <span className="comment-peek">
          <span className="comment-meta">
            <strong>{author.name}</strong>
            <time>{timeAgo(root.createdAt)}</time>
          </span>
          <span className="comment-peek-body">{root.body}</span>
          {replies.length > 0 && <span className="comment-replies">{replies.length === 1 ? '1 reply' : `${replies.length} replies`}</span>}
        </span>
      </button>
      {open && <ThreadCard thread={thread} userId={userId} />}
    </div>
  );
}

function DraftPin({ spot, text, placements }: { spot: Spot; text: string; placements: Record<string, Placement> }) {
  const me = useComments((s) => s.me);
  const card = useRef<HTMLDivElement>(null);
  const at = pinPoint(spot, placements);
  useCardFit(card, at.x, at.y);
  return (
    <div className="comment-spot draft open" data-comment="draft" {...spotAttrs(spot)} style={{ left: at.x, top: at.y }}>
      <span className="comment-pin">{me && <AuthorAvatar author={me} />}</span>
      <div className="comment-card compose" ref={card}>
        <Composer autoFocus value={text} onChange={setDraftText} onSend={() => void sendDraft()} placeholder="Add a comment" />
      </div>
    </div>
  );
}

function ThreadCard({ thread, userId }: { thread: Thread; userId: string | null }) {
  const authors = useComments((s) => s.authors);
  const card = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [menu, setMenu] = useState<{ anchor: HTMLElement; comment: Comment } | null>(null);
  const { root, replies } = thread;
  useCardFit(card, replies.length);

  // The newest reply in view.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [replies.length]);

  const send = async () => {
    const t = text;
    setText('');
    if (!(await reply(root, t))) setText((cur) => cur || t);
  };

  return (
    <div className="comment-card" ref={card}>
      <header className="comment-card-head">
        <span>Comment</span>
        {canDelete(root, userId) && (
          <IconButton label="Delete thread" size="sm" onClick={(e) => setMenu({ anchor: e.currentTarget, comment: root })}>
            <Trash2 size={13} />
          </IconButton>
        )}
        <IconButton label="Close" size="sm" onClick={() => openThread(null)}>
          <X size={14} />
        </IconButton>
      </header>
      <div className="comment-list" ref={list}>
        {[root, ...replies].map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            author={authors[c.authorId] ?? UNKNOWN}
            onDelete={c.parentId && canDelete(c, userId) ? (anchor) => setMenu({ anchor, comment: c }) : undefined}
          />
        ))}
      </div>
      {userId ? (
        <Composer value={text} onChange={setText} onSend={() => void send()} placeholder="Reply" />
      ) : (
        <button type="button" className="btn secondary sm comment-signin-btn" onClick={(e) => askToSignIn(e.currentTarget)}>
          Sign in to reply
        </button>
      )}
      {menu && (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          items={[
            {
              label: menu.comment.parentId ? 'Delete reply' : replies.length ? 'Delete thread and replies' : 'Delete comment',
              icon: <Trash2 size={15} />,
              danger: true,
              onSelect: () => void removeComment(menu.comment.id),
            },
          ]}
        />
      )}
    </div>
  );
}

function CommentItem({ comment, author, onDelete }: { comment: Comment; author: Author; onDelete?: (anchor: HTMLElement) => void }) {
  return (
    <div className="comment-item">
      <AuthorAvatar author={author} />
      <div className="comment-main">
        <div className="comment-meta">
          <strong>{author.name}</strong>
          <time dateTime={new Date(comment.createdAt).toISOString()} title={new Date(comment.createdAt).toLocaleString()}>
            {timeAgo(comment.createdAt)}
          </time>
          {onDelete && (
            <IconButton label="Delete reply" size="sm" className="comment-delete" onClick={(e) => onDelete(e.currentTarget)}>
              <Trash2 size={12} />
            </IconButton>
          )}
        </div>
        <p className="comment-body">{comment.body}</p>
      </div>
    </div>
  );
}

function Composer({
  value,
  onChange,
  onSend,
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  placeholder: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Grows with the text, up to a point.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [value]);
  useEffect(() => {
    // Without preventScroll the board would scroll to it.
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  return (
    <form
      className="comment-composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <textarea
        ref={ref}
        rows={1}
        value={value}
        maxLength={4000}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      <button type="submit" className="comment-send" aria-label="Send" title="Send (Enter)" disabled={!value.trim()}>
        <ArrowUp size={14} strokeWidth={2.4} />
      </button>
    </form>
  );
}

export function AuthorAvatar({ author }: { author: Author }) {
  if (author.avatarUrl) return <img className="avatar comment-avatar" src={author.avatarUrl} alt="" referrerPolicy="no-referrer" draggable={false} />;
  return (
    <span className="avatar comment-avatar" style={{ background: author.color }} aria-hidden>
      {author.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

// Keeps an open card inside the board: it opens to the pin's left near the
// right edge, and moves up near the bottom. Measured when it opens or grows,
// not while panning.
function useCardFit(ref: React.RefObject<HTMLDivElement | null>, ...deps: unknown[]) {
  useLayoutEffect(() => {
    const el = ref.current;
    const board = el?.closest('.board-host');
    if (!el || !board) return;
    el.classList.remove('flip');
    el.style.translate = '';
    const b = board.getBoundingClientRect();
    let r = el.getBoundingClientRect();
    if (r.right > b.right - 8) {
      el.classList.add('flip');
      r = el.getBoundingClientRect();
    }
    const over = r.bottom - (b.bottom - 60);
    if (over > 0) el.style.translate = `0 ${-Math.min(over, r.top - b.top - 8)}px`;
  }, deps);

  // Scrolling over a card scrolls it, not the board.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.stopPropagation();
      if (e.ctrlKey) e.preventDefault();
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [ref]);
}

// ---- toolbar -----------------------------------------------------------------------

export function CommentToolButton({ tool, ctrl }: { tool: Tool; ctrl: BoardController | null }) {
  const signedIn = !!useAuth().session;
  if (!remoteEnabled) return null;
  return (
    <IconButton
      label="Comment (C)"
      pressed={tool === 'comment'}
      onClick={(e) => {
        if (tool === 'comment') ctrl?.setTool('select');
        else if (!signedIn) askToSignIn(e.currentTarget);
        else ctrl?.setTool('comment');
      }}
    >
      <MessageCircle size={15} />
    </IconButton>
  );
}

// A published board's viewers get panning, comments and fit.
export function ViewerToolbar({ tool, ctrl }: { tool: Tool; ctrl: BoardController | null }) {
  if (!remoteEnabled) return null;
  return (
    <div className="board-toolbar float-bar">
      <IconButton label="Move (V)" pressed={tool !== 'comment'} onClick={() => ctrl?.setTool('select')}>
        <Hand size={15} />
      </IconButton>
      <CommentToolButton tool={tool} ctrl={ctrl} />
      <span className="sep" />
      <IconButton label="Fit all (F)" onClick={() => ctrl?.fitAll()}>
        <Maximize size={15} />
      </IconButton>
    </div>
  );
}
