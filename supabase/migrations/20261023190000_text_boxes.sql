-- Notes become text boxes: a box height (null: as tall as the text) and
-- whole-box formatting. Existing notes keep their look as body text.

alter table public.notes
  add column h double precision,
  add column size text not null default 'body' check (size in ('h1', 'h2', 'h3', 'body')),
  add column bold boolean not null default false,
  add column italic boolean not null default false,
  add column underline boolean not null default false;
