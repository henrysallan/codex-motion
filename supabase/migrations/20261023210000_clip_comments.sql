-- Clip comments, Frame.io-style: each is pinned to a moment in a clip. They
-- belong to the clip rather than a board, so the Feed's details view and
-- canvas focus mode show the same ones. Like the asset library itself they
-- are readable by everyone; anyone signed in can comment, and a comment can
-- be deleted by whoever wrote it. Comments aren't edited.

create table public.clip_comments (
  id uuid primary key default gen_random_uuid(),
  asset_id text not null references public.assets on delete cascade,
  -- References profiles (not auth.users) so the API can embed the author.
  author_id uuid not null default auth.uid() references public.profiles on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  -- Seconds into the clip.
  timecode double precision not null check (timecode >= 0),
  created_at timestamptz not null default now()
);
create index clip_comments_asset on public.clip_comments (asset_id, timecode);
create index clip_comments_author on public.clip_comments (author_id);

alter table public.clip_comments enable row level security;

create policy "clip comments are readable" on public.clip_comments for select to anon, authenticated
  using (true);
create policy "signed-in users can comment" on public.clip_comments for insert to authenticated
  with check (author_id = (select auth.uid()));
create policy "authors can delete" on public.clip_comments for delete to authenticated
  using (author_id = (select auth.uid()));

-- An open clip hears new comments live.
alter publication supabase_realtime add table public.clip_comments;
