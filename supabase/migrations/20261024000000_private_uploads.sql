-- Private uploads stay private. Until now every asset row was readable by
-- anyone, so uploads kept out of the Feed (20261023220000_upload_feed.sql)
-- were still listable over the API.
--
-- An asset is readable when it's library or scraped media, an upload shared
-- to the Feed, the caller's own upload, or on a board the caller can read
-- (so published boards keep showing every clip on them). Clip comments
-- follow their clip, and a clip can only be placed on a board by someone
-- who can read it: otherwise anyone could pin a private upload to their
-- own board, and delete_upload() would refuse its uploader for good.
--
-- An uploader still edits their own row, but its id, origin and added_by
-- are fixed, and its renditions may only name that row's own files under
-- media/<id>/, as the media Worker stores them. The app turns rendition
-- keys into URLs, so a free-form key would let an uploader point every
-- viewer at a server of their own.
--
-- New accounts without a name in their sign-in metadata are called Member
-- rather than the start of their email address; profiles are public.
-- Existing profiles keep their names.

-- Reading -----------------------------------------------------------------------

-- Whether the caller can read a board this clip is on. Reads as the definer,
-- like private.can_read_collection, so the assets policy doesn't recurse
-- through placements' and collections' policies.
create function private.on_readable_board(aid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.placements p join public.collections c on c.id = p.collection_id
    where p.asset_id = aid and (c.owner_id = (select auth.uid()) or c.is_public)
  );
$$;

-- The assets policy below, for other tables' policies.
create function private.can_read_asset(aid text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.assets a
    where a.id = aid
      and (a.origin <> 'upload' or a.in_feed or a.added_by = (select auth.uid()) or private.on_readable_board(a.id))
  );
$$;

revoke execute on function private.on_readable_board(text) from public;
revoke execute on function private.can_read_asset(text) from public;
grant execute on function private.on_readable_board(text) to anon, authenticated;
grant execute on function private.can_read_asset(text) to anon, authenticated;

drop policy "assets are readable" on public.assets;
create policy "library, shared and own assets are readable" on public.assets for select to anon, authenticated
  using (origin <> 'upload' or in_feed or added_by = (select auth.uid()) or private.on_readable_board(id));

drop policy "clip comments are readable" on public.clip_comments;
create policy "clip comments follow their clip" on public.clip_comments for select to anon, authenticated
  using (private.can_read_asset(asset_id));
drop policy "signed-in users can comment" on public.clip_comments;
create policy "readers can comment" on public.clip_comments for insert to authenticated
  with check (author_id = (select auth.uid()) and private.can_read_asset(asset_id));

-- A clip already on one of the caller's boards stays readable to them, so
-- moving it, or adding it to another board, still works after its uploader
-- takes it out of the Feed.
drop policy "own placements are insertable" on public.placements;
create policy "own placements are insertable" on public.placements for insert to authenticated
  with check (private.owns_collection(collection_id) and private.can_read_asset(asset_id));
drop policy "own placements are editable" on public.placements;
create policy "own placements are editable" on public.placements for update to authenticated
  using (private.owns_collection(collection_id))
  with check (private.owns_collection(collection_id) and private.can_read_asset(asset_id));

-- Asset ids are content hashes, so a second person can drop a file someone
-- else uploaded privately. Their row insert is skipped (it exists) and they
-- can't read or place the clip, so the app asks this first and turns the
-- drop away instead of queueing a placement that can't sync. It says only
-- that the file is taken, to someone who has its hash.
create function public.uploads_taken(ids text[]) returns setof text
language sql stable security definer set search_path = '' as $$
  select a.id from public.assets a
  where a.id = any(ids) and not private.can_read_asset(a.id);
$$;
revoke execute on function public.uploads_taken(text[]) from public, anon;
grant execute on function public.uploads_taken(text[]) to authenticated;

-- Writing -----------------------------------------------------------------------

-- Holds API callers only. The service role's scripts are trusted, and
-- foreign-key actions run as the table's owner, so deleting an account can
-- still clear added_by. Renditions are checked when they change, so an
-- update to other columns of an older row isn't refused.
create function private.check_asset_write() returns trigger
language plpgsql set search_path = '' as $$
declare
  tier text;
  r jsonb;
begin
  if current_user not in ('anon', 'authenticated') then return new; end if;
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.origin is distinct from old.origin or new.added_by is distinct from old.added_by then
      raise exception 'an asset''s id, origin and added_by can''t be changed' using errcode = '42501';
    end if;
    if new.renditions is not distinct from old.renditions then return new; end if;
  end if;
  if jsonb_typeof(new.renditions) is distinct from 'object' then
    raise exception 'renditions must be an object' using errcode = '22023';
  end if;
  for tier, r in select key, value from jsonb_each(new.renditions) loop
    if not (
      tier in ('l0', 'l1', 'l2', 'original')
      and jsonb_typeof(r) = 'object'
      and jsonb_typeof(r -> 'key') = 'string'
      and (r ->> 'key') ~ '^media/[0-9a-f]{16}/(l0\.trl0|l1\.mp4|l2\.mp4|original\.[a-z0-9]{1,8})$'
      and split_part(r ->> 'key', '/', 2) = new.id
    ) then
      raise exception 'rendition % must be a file under media/%/', tier, new.id using errcode = '22023';
    end if;
  end loop;
  return new;
end $$;
revoke execute on function private.check_asset_write() from public, anon, authenticated;

create trigger assets_check_write before insert or update on public.assets
for each row execute function private.check_asset_write();

-- Profiles ----------------------------------------------------------------------

create or replace function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, name, avatar_url)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), nullif(btrim(new.raw_user_meta_data ->> 'name'), ''), 'Member'),
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end $$;
revoke execute on function private.handle_new_user() from public, anon, authenticated;
