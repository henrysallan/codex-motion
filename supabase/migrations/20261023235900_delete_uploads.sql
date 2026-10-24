-- Deleting uploads. An uploader can delete their own upload, which frees
-- its space in their quota (20261023235500_upload_quota.sql).
--
-- delete_upload() takes the clip off the uploader's collections and drops
-- its row in one transaction (clip comments go with it; covers fall back),
-- then leaves a tombstone. The tombstone is what lets the media Worker
-- delete the files: it asks upload_purgeable() and calls upload_purged()
-- once they're gone. The app retries unpurged tombstones on the next open,
-- so a closed tab can't strand files.
--
-- An upload that's in someone else's collection can't be deleted: their
-- boards aren't the uploader's to change. Turning off Show in Feed stops
-- new adds.

create table private.deleted_uploads (
  asset_id text primary key,
  user_id uuid not null references auth.users on delete cascade,
  deleted_at timestamptz not null default now(),
  purged boolean not null default false
);
alter table private.deleted_uploads enable row level security;
create index deleted_uploads_unpurged on private.deleted_uploads (user_id) where not purged;

-- Status: 'ok' (deleted, now or by an earlier call), 'in_use' (`others`
-- people have it in a collection; nothing changed), 'not_owner', 'missing'
-- (the row never reached the server).
create function public.delete_upload(asset text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := (select auth.uid());
  owner uuid;
  others integer;
begin
  if me is null then raise exception 'sign in to delete uploads'; end if;
  -- Locks the row, so no placement can be added to it meanwhile.
  select added_by into owner from public.assets where id = asset for update;
  if not found then
    return jsonb_build_object('status',
      case when exists (select 1 from private.deleted_uploads where asset_id = asset and user_id = me) then 'ok' else 'missing' end);
  end if;
  if owner is distinct from me then return jsonb_build_object('status', 'not_owner'); end if;
  select count(distinct c.owner_id) into others
  from public.placements p join public.collections c on c.id = p.collection_id
  where p.asset_id = asset and c.owner_id <> me;
  if others > 0 then return jsonb_build_object('status', 'in_use', 'others', others); end if;
  delete from public.placements p using public.collections c
  where p.asset_id = asset and c.id = p.collection_id and c.owner_id = me;
  delete from public.assets where id = asset;
  insert into private.deleted_uploads (asset_id, user_id) values (asset, me)
  on conflict (asset_id) do update set user_id = excluded.user_id, deleted_at = now(), purged = false;
  return public.upload_quota() || jsonb_build_object('status', 'ok');
end $$;

-- For the media Worker: whether the caller may delete media/<asset>/. They
-- deleted its upload, and no one has added the same file again since.
create function public.upload_purgeable(asset text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.deleted_uploads where asset_id = asset and user_id = (select auth.uid()))
    and not exists (select 1 from public.assets where id = asset);
$$;

create function public.upload_purged(asset text) returns void
language sql security definer set search_path = '' as $$
  update private.deleted_uploads set purged = true where asset_id = asset and user_id = (select auth.uid());
$$;

-- The caller's deleted uploads whose files may still be stored.
create function public.unpurged_uploads() returns setof text
language sql stable security definer set search_path = '' as $$
  select d.asset_id from private.deleted_uploads d
  where d.user_id = (select auth.uid()) and not d.purged
    and not exists (select 1 from public.assets a where a.id = d.asset_id);
$$;

revoke execute on function public.delete_upload(text) from public, anon;
revoke execute on function public.upload_purgeable(text) from public, anon;
revoke execute on function public.upload_purged(text) from public, anon;
revoke execute on function public.unpurged_uploads() from public, anon;
grant execute on function public.delete_upload(text) to authenticated;
grant execute on function public.upload_purgeable(text) to authenticated;
grant execute on function public.upload_purged(text) to authenticated;
grant execute on function public.unpurged_uploads() to authenticated;
