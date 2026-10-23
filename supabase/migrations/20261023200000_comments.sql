-- Comments: pins on a board, each starting a thread of replies. Anyone who
-- can read a collection can read its comments; anyone signed in who can
-- read it can comment. A comment can be deleted by whoever wrote it or by
-- the collection's owner, and deleting a thread's first comment deletes the
-- thread. Comments aren't edited.

create table public.comments (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.collections on delete cascade,
  -- Replies point at their thread's first comment; null starts a thread.
  parent_id uuid references public.comments on delete cascade,
  -- References profiles (not auth.users) so the API can embed the author.
  author_id uuid not null default auth.uid() references public.profiles on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  -- Where a thread's pin sits, in canvas coordinates.
  x double precision,
  y double precision,
  -- A pin dropped on a clip follows it: the placement and where on it
  -- (0..1 across and down). No foreign key, so a clip restored with undo
  -- gets its pins back; while it's gone the pin falls back to x, y.
  placement_id uuid,
  px double precision check (px between 0 and 1),
  py double precision check (py between 0 and 1),
  created_at timestamptz not null default now(),
  constraint threads_have_pins check ((parent_id is null) = (x is not null and y is not null)),
  constraint anchors_are_whole check ((placement_id is null) = (px is null) and (px is null) = (py is null))
);
create index comments_collection on public.comments (collection_id, created_at);
create index comments_parent on public.comments (parent_id);
create index comments_author on public.comments (author_id);

-- A reply's parent must start a thread on the same board.
create function private.is_thread_start(pid uuid, cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.comments c
    where c.id = pid and c.collection_id = cid and c.parent_id is null
  );
$$;
grant execute on function private.is_thread_start(uuid, uuid) to authenticated;

alter table public.comments enable row level security;

create policy "comments follow their collection" on public.comments for select to anon, authenticated
  using (private.can_read_collection(collection_id));
create policy "readers can comment" on public.comments for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and private.can_read_collection(collection_id)
    and (parent_id is null or private.is_thread_start(parent_id, collection_id))
  );
create policy "authors and owners can delete" on public.comments for delete to authenticated
  using (author_id = (select auth.uid()) or private.owns_collection(collection_id));

-- Open boards hear new comments live.
alter publication supabase_realtime add table public.comments;
