-- The sign-up hook needn't be callable over the API: move it out of the
-- exposed schema. Index the remaining foreign keys.

alter function public.handle_new_user() set schema private;
revoke execute on function private.handle_new_user() from public, anon, authenticated;

create index assets_added_by on public.assets (added_by);
create index collections_cover_asset on public.collections (cover_asset_id);
create index placements_added_by on public.placements (added_by);
create index placements_asset on public.placements (asset_id);
