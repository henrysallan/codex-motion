-- Upload quota: each account may store 1 GB of uploads, every rendition
-- counted (original, L0 sprite, L1/L2 proxies). Admins have no limit.
--
-- Before sending an upload's files the app declares their total size with
-- reserve_upload(), which writes assets.bytes; a trigger refuses any
-- declaration that would take the uploader past the limit. The media Worker
-- asks upload_allowance() and stores no more under media/<hash>/ than the
-- row declares, so the limit holds for anyone who skips the app.
--
-- A declaration only grows: once space is reserved it keeps counting, so it
-- can't be lowered after the files are up. Uploads can't be deleted yet,
-- which makes the quota a lifetime one for now.

-- Admins ------------------------------------------------------------------------

create table private.admins (
  user_id uuid primary key references auth.users on delete cascade
);
alter table private.admins enable row level security;

insert into private.admins (user_id)
select id from auth.users where email = 'isthishenry@gmail.com';

create function private.is_admin(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.admins where user_id = uid);
$$;
revoke execute on function private.is_admin(uuid) from public, anon;
grant execute on function private.is_admin(uuid) to authenticated;

-- 1 GB, in decimal units as Finder counts them.
create function private.upload_limit() returns bigint
language sql immutable set search_path = '' as $$ select 1000000000::bigint $$;

-- Sizes -------------------------------------------------------------------------

alter table public.assets
  add column bytes bigint not null default 0 check (bytes >= 0);

-- Uploads already stored count at their stored size. Leave updated_at alone.
alter table public.assets disable trigger assets_touch;
update public.assets a
set bytes = coalesce((select sum((r.value ->> 'bytes')::bigint) from jsonb_each(a.renditions) r), 0)
where a.origin = 'upload';
alter table public.assets enable trigger assets_touch;

-- Counts every row a user added, whatever its origin, so relabelling an
-- upload doesn't free its space.
create function private.check_upload_quota() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  used bigint;
begin
  if tg_op = 'UPDATE' then
    new.bytes := greatest(new.bytes, old.bytes);
    if new.bytes = old.bytes then return new; end if;
  end if;
  if new.bytes = 0 or new.added_by is null or private.is_admin(new.added_by) then return new; end if;
  -- One declaration per user at a time, so two can't both fit the last space.
  perform pg_advisory_xact_lock(hashtextextended(new.added_by::text, 0));
  select coalesce(sum(bytes), 0) into used
  from public.assets where added_by = new.added_by and id <> new.id;
  if used + new.bytes > private.upload_limit() then
    raise exception 'upload limit: % of % bytes used, % more requested', used, private.upload_limit(), new.bytes;
  end if;
  return new;
end $$;
revoke execute on function private.check_upload_quota() from public, anon, authenticated;

create trigger assets_upload_quota before insert or update of bytes on public.assets
for each row execute function private.check_upload_quota();

-- API ---------------------------------------------------------------------------

-- What the caller has stored, and their limit (null: none).
create function public.upload_quota() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'used', coalesce((select sum(bytes) from public.assets where added_by = (select auth.uid())), 0),
    'limit', case when private.is_admin((select auth.uid())) then null else private.upload_limit() end
  );
$$;

-- Declares an upload's total size. Status: 'ok' (reserved), 'full' (it
-- doesn't fit; nothing changed), 'shared' (someone else added this file
-- first, so its space is theirs), 'missing' (the row hasn't synced yet).
create function public.reserve_upload(asset text, total bigint) returns jsonb
language plpgsql set search_path = '' as $$
declare
  owner uuid;
begin
  select added_by into owner from public.assets where id = asset;
  if not found then return jsonb_build_object('status', 'missing'); end if;
  if owner is distinct from (select auth.uid()) then return jsonb_build_object('status', 'shared'); end if;
  begin
    update public.assets set bytes = total where id = asset;
  exception when raise_exception then
    return public.upload_quota() || jsonb_build_object('status', 'full');
  end;
  return public.upload_quota() || jsonb_build_object('status', 'ok');
end $$;

-- For the media Worker: how many bytes the caller may store under
-- media/<asset>/. Null: no limit (admins); 0: nothing reserved there.
create function public.upload_allowance(asset text) returns bigint
language sql stable set search_path = '' as $$
  select case
    when private.is_admin((select auth.uid())) then null
    else coalesce((select bytes from public.assets where id = asset and added_by = (select auth.uid())), 0)
  end;
$$;

revoke execute on function public.upload_quota() from public, anon;
revoke execute on function public.reserve_upload(text, bigint) from public, anon;
revoke execute on function public.upload_allowance(text) from public, anon;
grant execute on function public.upload_quota() to authenticated;
grant execute on function public.reserve_upload(text, bigint) to authenticated;
grant execute on function public.upload_allowance(text) to authenticated;
