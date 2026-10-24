-- Uploads stay out of the Feed unless their owner shares them there. The
-- owner flips it from the clip's details ("own uploads are editable"
-- already covers the update); library and scraped rows ignore it.

alter table public.assets
  add column in_feed boolean not null default false;
