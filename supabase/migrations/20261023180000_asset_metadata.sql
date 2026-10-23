-- What a scraped asset's site said about it, and what the tagger saw in it:
-- the `source` and `analysis` records from library.json (AssetSource and
-- AssetAnalysis in src/media/library.ts). About 1.4 KB a row together, so
-- the app leaves them out of its startup select and reads one row when a
-- clip's details open.

alter table public.assets
  add column source jsonb,
  add column analysis jsonb;
