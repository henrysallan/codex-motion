-- Frames on a board: coloured boxes that hold clips. A clip in a frame shows
-- only inside it and moves with it. They follow their collection like notes.
--
-- placements.frame_id has no foreign key on purpose: the outbox pushes
-- whole batches, and a frame deleted elsewhere mustn't wedge it. A clip
-- whose frame is gone is just loose on the board.

create table public.frames (
  id uuid primary key,
  collection_id uuid not null references public.collections on delete cascade,
  x double precision not null,
  y double precision not null,
  w double precision not null,
  h double precision not null,
  color text not null default 'default' check (color in ('default', 'grey', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink')),
  z double precision not null default 0,
  updated_at timestamptz not null default now()
);
create index frames_collection on public.frames (collection_id);

create trigger frames_touch before update on public.frames for each row execute function public.touch_updated_at();

alter table public.placements add column frame_id uuid;

alter table public.frames enable row level security;

create policy "frames follow their collection" on public.frames for select to anon, authenticated
  using (private.can_read_collection(collection_id));
create policy "own frames are insertable" on public.frames for insert to authenticated
  with check (private.owns_collection(collection_id));
create policy "own frames are editable" on public.frames for update to authenticated
  using (private.owns_collection(collection_id)) with check (private.owns_collection(collection_id));
create policy "own frames are deletable" on public.frames for delete to authenticated
  using (private.owns_collection(collection_id));
