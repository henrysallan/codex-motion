-- Folders file collections in the Collections pane, and nest. Like
-- collections, they're the owner's alone. Deleting a folder leaves what was
-- in it at the top level (the app moves it up a level first).

create table public.folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  parent_id uuid references public.folders on delete set null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint not_own_parent check (parent_id is distinct from id)
);
create index folders_owner on public.folders (owner_id);
create index folders_parent on public.folders (parent_id);

create trigger folders_touch before update on public.folders for each row execute function public.touch_updated_at();

alter table public.collections add column folder_id uuid references public.folders on delete set null;
create index collections_folder on public.collections (folder_id);

alter table public.folders enable row level security;

create policy "own folders are readable" on public.folders for select to authenticated
  using (owner_id = (select auth.uid()));
create policy "folders can be created" on public.folders for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "own folders are editable" on public.folders for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own folders are deletable" on public.folders for delete to authenticated
  using (owner_id = (select auth.uid()));
