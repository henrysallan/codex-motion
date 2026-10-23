-- codex-motion schema v1.
--
-- Collections belong to whoever made them: only the owner can read or edit
-- one, until they publish it under a slug, which makes it (and its
-- placements and notes) readable by anyone, signed in or not. Shared
-- editing comes later. Assets are the shared, content-addressed library:
-- readable by everyone, added by signed-in users.

create extension if not exists vector with schema extensions; -- M2 embeddings

-- Profiles ----------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text not null default '',
  avatar_url text,
  color text not null default '#4f7cff',
  -- Default destination for clips added from the Feed.
  active_target_id uuid,
  created_at timestamptz not null default now()
);

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- Assets ------------------------------------------------------------------------

create table public.assets (
  -- First 16 hex digits of the source file's SHA-256.
  id text primary key check (id ~ '^[0-9a-f]{16}$'),
  name text not null,
  origin text not null check (origin in ('library', 'upload', 'scraper')),
  status text not null default 'ready' check (status in ('processing', 'ready', 'error')),
  duration double precision not null,
  width integer not null,
  height integer not null,
  fps double precision not null,
  -- Storage keys and sizes per tier:
  -- { l0: {key, format, frameWidth, frameHeight, frameCount, bytes},
  --   l1|l2|original: {key, width, height, bytes} }
  renditions jsonb not null default '{}'::jsonb,
  source_url text,
  source_title text,
  added_by uuid default auth.uid() references auth.users on delete set null,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Collections, placements, notes ------------------------------------------------

create table public.collections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  cover_asset_id text references public.assets on delete set null,
  last_drop jsonb,
  is_public boolean not null default false,
  slug text unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_needs_slug check (not is_public or slug is not null)
);
create index collections_owner on public.collections (owner_id);

create table public.placements (
  id uuid primary key,
  collection_id uuid not null references public.collections on delete cascade,
  asset_id text not null references public.assets,
  x double precision not null,
  y double precision not null,
  w double precision not null,
  h double precision not null,
  rotation double precision not null default 0,
  z double precision not null default 0,
  in_point double precision,
  out_point double precision,
  added_by uuid default auth.uid() references auth.users on delete set null,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index placements_collection on public.placements (collection_id);

create table public.notes (
  id uuid primary key,
  collection_id uuid not null references public.collections on delete cascade,
  x double precision not null,
  y double precision not null,
  w double precision not null,
  text text not null default '',
  z double precision not null default 0,
  updated_at timestamptz not null default now()
);
create index notes_collection on public.notes (collection_id);

-- updated_at -----------------------------------------------------------------------

create function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger assets_touch before update on public.assets for each row execute function public.touch_updated_at();
create trigger collections_touch before update on public.collections for each row execute function public.touch_updated_at();
create trigger placements_touch before update on public.placements for each row execute function public.touch_updated_at();
create trigger notes_touch before update on public.notes for each row execute function public.touch_updated_at();

-- Access ------------------------------------------------------------------------
-- Helpers live outside the API-exposed schema; they read collections as the
-- definer so policies on child tables don't recurse through collections' RLS.

create schema if not exists private;

create function private.can_read_collection(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.collections c
    where c.id = cid and (c.owner_id = (select auth.uid()) or c.is_public)
  );
$$;

create function private.owns_collection(cid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.collections c
    where c.id = cid and c.owner_id = (select auth.uid())
  );
$$;

grant usage on schema private to anon, authenticated;
grant execute on function private.can_read_collection(uuid) to anon, authenticated;
grant execute on function private.owns_collection(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.assets enable row level security;
alter table public.collections enable row level security;
alter table public.placements enable row level security;
alter table public.notes enable row level security;

-- Names and avatars show on public collections.
create policy "profiles are readable" on public.profiles for select to anon, authenticated using (true);
create policy "own profile is editable" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "assets are readable" on public.assets for select to anon, authenticated using (true);
create policy "uploads can be added" on public.assets for insert to authenticated
  with check (origin = 'upload' and added_by = (select auth.uid()));
create policy "own uploads are editable" on public.assets for update to authenticated
  using (added_by = (select auth.uid())) with check (added_by = (select auth.uid()));

create policy "own or public collections are readable" on public.collections for select to anon, authenticated
  using (owner_id = (select auth.uid()) or is_public);
create policy "collections can be created" on public.collections for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy "own collections are editable" on public.collections for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "own collections are deletable" on public.collections for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy "placements follow their collection" on public.placements for select to anon, authenticated
  using (private.can_read_collection(collection_id));
create policy "own placements are insertable" on public.placements for insert to authenticated
  with check (private.owns_collection(collection_id));
create policy "own placements are editable" on public.placements for update to authenticated
  using (private.owns_collection(collection_id)) with check (private.owns_collection(collection_id));
create policy "own placements are deletable" on public.placements for delete to authenticated
  using (private.owns_collection(collection_id));

create policy "notes follow their collection" on public.notes for select to anon, authenticated
  using (private.can_read_collection(collection_id));
create policy "own notes are insertable" on public.notes for insert to authenticated
  with check (private.owns_collection(collection_id));
create policy "own notes are editable" on public.notes for update to authenticated
  using (private.owns_collection(collection_id)) with check (private.owns_collection(collection_id));
create policy "own notes are deletable" on public.notes for delete to authenticated
  using (private.owns_collection(collection_id));
