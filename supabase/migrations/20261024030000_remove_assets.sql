-- Dev tools: admins (private.admins, 20261023235500_upload_quota.sql) can
-- delete clips from the library outright, from the Feed's right-click menu.
--
-- remove_assets() drops the rows in one transaction, taking the clips off
-- every board that has them, whoever owns it (clip comments and notes go
-- with them; covers fall back). Each removal leaves a tombstone, which does
-- two things:
-- - Library and scraped rows with a tombstone can't be inserted again, so
--   re-running upload:library over a library.json that still lists them
--   skips them. Uploads aren't blocked: whoever drops the same file later
--   gets their own private copy.
-- - The media Worker deletes the files. It already deletes a deleted
--   upload's files for whoever upload_purgeable() approves
--   (20261023235900_delete_uploads.sql); that now approves an admin for a
--   removed clip, and the app's purge on open retries what didn't finish.
--
-- To let a clip back in, delete its tombstone, then re-run upload:library
-- (its files are gone once purged).

create table private.removed_assets (
  asset_id text primary key,
  removed_by uuid references auth.users on delete set null,
  removed_at timestamptz not null default now(),
  -- What it was, for the record.
  origin text not null,
  name text not null,
  source_url text,
  purged boolean not null default false
);
alter table private.removed_assets enable row level security;
create index removed_assets_unpurged on private.removed_assets (asset_id) where not purged;

-- Whether the caller is an admin, so the app can offer dev tools.
create function public.is_admin() returns boolean
language sql stable set search_path = '' as $$
  select private.is_admin((select auth.uid()));
$$;

-- Removes these clips. Returns the ids it removed, and how many boards
-- (anyone's) they came off.
create function public.remove_assets(ids text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  removed text[];
  boards integer;
begin
  if not private.is_admin(me) then raise exception 'only admins can remove clips' using errcode = '42501'; end if;
  if coalesce(array_length(ids, 1), 0) > 1000 then raise exception 'at most 1000 clips at a time' using errcode = '22023'; end if;
  -- Locks the rows, so no placement can be added to them meanwhile.
  perform 1 from public.assets where id = any(ids) for update;
  select count(distinct collection_id) into boards from public.placements where asset_id = any(ids);
  delete from public.placements where asset_id = any(ids);
  with gone as (
    delete from public.assets where id = any(ids) returning id, origin, name, source_url
  ), marked as (
    insert into private.removed_assets (asset_id, removed_by, origin, name, source_url)
    select id, me, origin, name, source_url from gone
    on conflict (asset_id) do update set
      removed_by = excluded.removed_by, removed_at = now(), origin = excluded.origin,
      name = excluded.name, source_url = excluded.source_url, purged = false
    returning asset_id
  )
  select coalesce(array_agg(asset_id), '{}') into removed from marked;
  return jsonb_build_object('removed', to_jsonb(removed), 'boards', boards);
end $$;

-- Skips, rather than refuses, so a batch insert from a script carries on
-- with the rows that are still wanted.
create function private.skip_removed_asset() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.origin <> 'upload' and exists (select 1 from private.removed_assets where asset_id = new.id) then
    return null;
  end if;
  return new;
end $$;
revoke execute on function private.skip_removed_asset() from public, anon, authenticated;

create trigger assets_skip_removed before insert on public.assets
for each row execute function private.skip_removed_asset();

-- File purges -------------------------------------------------------------------

create or replace function public.upload_purgeable(asset text) returns boolean
language sql stable security definer set search_path = '' as $$
  select (
      exists (select 1 from private.deleted_uploads where asset_id = asset and user_id = (select auth.uid()))
      or (private.is_admin((select auth.uid())) and exists (select 1 from private.removed_assets where asset_id = asset))
    )
    and not exists (select 1 from public.assets where id = asset);
$$;

create or replace function public.upload_purged(asset text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update private.deleted_uploads set purged = true where asset_id = asset and user_id = (select auth.uid());
  if private.is_admin((select auth.uid())) then
    update private.removed_assets set purged = true where asset_id = asset;
  end if;
end $$;

create or replace function public.unpurged_uploads() returns setof text
language sql stable security definer set search_path = '' as $$
  select d.asset_id from private.deleted_uploads d
  where d.user_id = (select auth.uid()) and not d.purged
    and not exists (select 1 from public.assets a where a.id = d.asset_id)
  union
  select r.asset_id from private.removed_assets r
  where private.is_admin((select auth.uid())) and not r.purged
    and not exists (select 1 from public.assets a where a.id = r.asset_id);
$$;

revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.remove_assets(text[]) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.remove_assets(text[]) to authenticated;
