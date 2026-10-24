-- Notes on a clip: free text that only the person who wrote it sees, one
-- note per person per clip, in the clip's details panel. Comments are the
-- shared conversation; notes are your own. `links` holds the previews of
-- the links in the body (title, site, small data: thumbnails), fetched once
-- by api/unfurl.ts so opening a note never reaches third-party sites.

create table public.asset_notes (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  asset_id text not null references public.assets on delete cascade,
  body text not null check (char_length(body) between 1 and 10000),
  links jsonb not null default '{}' check (jsonb_typeof(links) = 'object' and pg_column_size(links) <= 262144),
  updated_at timestamptz not null default now(),
  primary key (user_id, asset_id)
);
create index asset_notes_asset on public.asset_notes (asset_id);

alter table public.asset_notes enable row level security;

create policy "own notes are readable" on public.asset_notes for select to authenticated
  using (user_id = (select auth.uid()));
create policy "own notes can be written" on public.asset_notes for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "own notes can be edited" on public.asset_notes for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own notes can be deleted" on public.asset_notes for delete to authenticated
  using (user_id = (select auth.uid()));
