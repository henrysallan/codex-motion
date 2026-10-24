# codex-motion

A motion moodboard: a reference canvas where every clip plays at once, all the
time, with no click to start. See the product and technical spec
(`Motion Moodboard — Product & Technical Spec`) for the full plan.

Status: **M0** (renderer spike) passed its gate; **M1** (collections and
canvas) is in, running on a local data layer (IndexedDB + OPFS) shaped like
the planned Postgres tables, so Supabase can slot in later.

What works:

- Pill bar with Collections and Feed toggles and one tab per open
  collection; up to three panes (Collections, Feed, Canvas) with draggable,
  persisted widths; light and dark themes.
- Collections: animated cover grid or list, search, sort, rename, delete,
  "set as active target".
- Canvas: pan/zoom, select, marquee, move, aspect-locked resize, snap
  (off by default), notes, arrange as grid/row, z-order, undo/redo, hover
  scrub, global pause.
- Focus mode (double-click): the clip on its own clock at the best tier on
  this device (the original for uploads), play/pause, frame step, speed,
  in/out points that the board loop then respects. An info panel beside it
  shows the clip's project, credits and AI tags (toggle in the focus bar).
- Feed: the shared library in a seeded shuffle; select (click, shift, cmd,
  marquee), add to the active target or pick a collection, or drag onto the
  canvas. New clips land at the last drop point, relax off anything they
  overlap, and fly in. Double-click a tile for its details: the clip at
  full quality, with the scraped project (client, studio, year, credits,
  tags, source links) and the AI caption and tags beside it; arrows step
  through the Feed.
- Ingest: drop or paste videos, GIFs or images onto the canvas. A file is
  placed within ~60 ms playing from the file itself, then decoded once in a
  worker into L0/L1/L2 (H.264 via WebCodecs) in OPFS; a 4 s 1080p clip
  finishes in ~1.6 s. Interrupted ingests resume from the saved original.
  Uploads stay in their collections until the uploader shares them to the
  Feed (see "Uploads" below).

## Run it

Needs Node 24+, an arm64 `ffmpeg` (the scripts read `$FFMPEG`, else `ffmpeg` on
PATH), and a Chromium browser with WebGPU and WebCodecs (Chrome 113+).

```bash
npm install
```

```bash
npm run dev
```

The library is scraped reference (see below). To fill a fresh checkout,
scrape a site, or drop `.mp4`/`.mov`/`.webm` files in a folder and run
`npm run build:proxies -- --in path/to/folder --merge`. Re-runs only process
new files; assets are keyed by content hash. For a synthetic benchmark
library (the M0 gate), `npm run gen:clips` makes 200 test clips in
`media/sources` to build the same way.

With `VITE_SUPABASE_*` set the app signs in and reads the shared library
from Supabase and R2; `npm run upload:library` pushes `public/media`'s
proxies to R2 (multipart for files over 90 MB) and writes the SQL that
registers them. With `SUPABASE_SERVICE_ROLE_KEY` in `.env.local` it
registers them itself, with each clip's scraped metadata and AI tags (the
`source` and `analysis` columns, too big for the SQL file). Leave those
variables empty to run fully local.

### Scraping a site

```bash
npm run scrape -- https://studio.example/work
```

```bash
FFMPEG=/path/to/ffmpeg npm run build:proxies -- --in media/scraped/studio.example --merge
```

The first command collects every video on the site into
`media/scraped/<host>/`: each file named by content hash, a `<id>.json`
sidecar beside it, and `scrape.json` for the whole run. The second builds
proxies and adds them to the library (and so the Feed) without dropping what
is already there; `--build` on the scrape does that and then the analysis
passes below. A path in the URL
(`/work`) puts that section's pages first; the rest of the site is still
crawled, up to `--max-pages`. `--budget-gb` caps what one run downloads,
earliest-crawled pages first.

It works in three tiers and only reaches for the next one when the last one
left signs of more:

1. **Static**: robots.txt, sitemaps and a same-site crawl of the HTML as
   served. Extractors read `<video>`/`<source>` (including lazy `data-*` and
   JSON source lists), player iframes and ids (Vimeo, YouTube, Wistia, Mux,
   Cloudflare Stream, ...), og/twitter video tags, JSON-LD `VideoObject`, and
   media URLs inside inline data (`__NEXT_DATA__`, Next's RSC payload, Framer,
   Nuxt) with the fields around them.
2. **Render**: headless Chrome (your installed Google Chrome, via
   playwright-core) for pages that look client-rendered or hold players with
   no visible source. It scrolls with real wheel events, triggers
   hover-to-play cards, records media requests, and re-runs the extractors on
   the live DOM.
3. **Agent**: Claude driving that browser through the browser use toolset,
   for what scripts can't reach: "Load more" buttons, filters, project
   modals, click-to-play players. Pages it loads are scanned automatically;
   it adds project metadata (title, client, credits) as it goes. Runs when
   the crawl finds nothing, or a page has a "Load more" control, player
   markup with no video, or more sourceless `<video>`s than videos found.
   Needs `ANTHROPIC_API_KEY` (environment or `.env.local`); defaults to
   Opus 5.5 (`--agent-model`), about $1–3 a site when it runs.
   `--agent always|off` overrides.

Each video keeps what the site said about it: the page (title, description,
og, JSON-LD, published date), every place it appeared with its card text,
heading, caption and link, the `<video>` attributes (autoplay/loop/poster),
the player's own metadata via yt-dlp, and the file's probe (size, codec,
duration, fps). With an API key, enrichment structures each project page
into title, client, agency, year, credits and tags with Haiku 5.5 (about
$0.001 a page; `--no-enrich` skips it, `--enrich-model` swaps the model).
Downloads go through
yt-dlp for players and streams (`pip install yt-dlp`; `YTDLP` overrides) and
plain HTTP for files. Bot checks are reported, never worked around, and
robots.txt is honoured. `npm run scrape -- --help` lists the options.

### Tags and embeddings

```bash
FFMPEG=/path/to/ffmpeg npm run embed                        # SigLIP 2 vectors for every clip, local and free
```

```bash
FFMPEG=/path/to/ffmpeg npm run tag -- --estimate            # free token count, projected cost
```

```bash
FFMPEG=/path/to/ffmpeg npm run tag                          # caption + motion tags for untagged clips
```

- **Embeddings** run SigLIP 2 (base, 224 px) in Node through transformers.js:
  8 frames of each clip's L1 proxy, L2-normalized, plus their mean, in
  `<id>/embedding.f32`; `embeddings.json` + `embeddings.f32` pack the means
  for search (5 MB for 1,635 clips). Text embeds into the same space, so
  `npm run embed -- --query "liquid chrome 3D render"` ranks the library
  with no tags at all, and `--like <id>` finds similar clips. The weights
  (~700 MB) download once into `media/models/`; about 5 minutes for 1,600
  clips on an M4 Pro.
- **Tags** send one contact sheet per clip (16 frames in time order, from
  the L1 proxy) to Haiku 5.5 with the motion vocabulary in
  `src/media/vocabulary.ts` (technique, camera, easing, pacing, use). Back
  come a one-line caption, tags from that vocabulary only, and up to 8 free
  visual tags (`visual:chrome`, `visual:phone-mockup`). They land in
  `analysis` on each asset and in `<id>/tags.json`. Measured: about 3,400
  input and 175 output tokens, $0.0004 a clip. `--only <site|id>`,
  `--limit`, `--force` and `--model` narrow or change a run.

### Search

```bash
npm run index                 # rebuild the search index from the library, tags and embeddings
```

```bash
npm run index -- --upload     # and send it to R2 for signed-in users (needs MEDIA_ADMIN_TOKEN)
```

The search bar sits at the top of the Feed. Type words, pick a suggestion
(`Client · Nike`) or write `studio:koto`, `client:"utah jazz"`, `-loop`,
`"kinetic type"`; picked values become chips, which are hard filters. The
sliders button opens the panel: a **fuzziness** slider, the order (best
match, shuffle, newest) and every facet with live counts: technique, content
(logo reveal, UI motion...), project type, studio, client, sector, source
site, colour, camera, easing, pacing, aspect, length, year. Select clips and
press **Similar** for more that look like them. `/` focuses the search.

- **Where it runs.** All of it runs in a worker (`src/search/`), over an index
  that `npm run index` builds into `public/media/search/` from
  `library.json` and the embeddings. The index is about 0.6 MB gzipped of
  text plus 3.2 MB of int8 vectors for 4,082 clips, content-hashed so it
  caches forever. A keystroke reaches new results in about 30 ms (the worker
  takes 2–18 ms of that).
- **Text** is BM25 over weighted fields (title, studio and client, tags,
  project type and sector, caption, page description), with prefix matching
  for the word being typed.
- **Looks.** Query text is embedded with the same SigLIP 2 model as the
  clips, by `GET /api/embed?q=` (a Vercel Function, `api/embed.ts`; the dev
  server serves it from `media/models`). Clips are scored against it, and
  against the average of the best text matches ("more like these"), as
  z-scores per query. Responses are immutable, so each phrase is embedded
  once and then served from the CDN and browser cache. Without the endpoint,
  search still works on text and "more like these".
- **Fuzziness** goes from *Exact* (every word, as typed; nothing on looks
  alone) through *Close* (typos for unknown words, word starts) and
  *Related* (most words, plus clips that look strongly alike) to *Wide*
  (some words, plus anything that resembles the query, about the top 10%).
  "zebra" matches no words in the library; at *Related* it finds 35
  black-and-white stripe pieces.
- **Facets** come from the scraped page (studio, client, year, site) and the
  tags. Studios' own tags ("Motion Graphics & Film", "Fintech") map onto
  fixed project types and sectors in `src/search/taxonomy.ts`; anything
  unmapped is still searchable as text.

### Uploads: Enrich and the Feed

A clip dropped onto the canvas is yours: it shows in your collections, not
in the Feed. Its details panel (double-click it) has a **Your upload**
section, visible only to whoever uploaded it:

- **Enrich** tags the clip's frames and, given a link to the project or
  video, reads that page for project details. The app builds the same
  16-frame contact sheet as `npm run tag`, from the L1 proxy (WebCodecs,
  about 0.1–1 s), and posts it with the link to `POST /api/enrich`
  (`api/enrich.ts`, a Vercel Function; the dev server serves it too). The
  page is read as served, with robots.txt honoured and no headless browser,
  then structured with the scraper's enrichment prompt; the sheet goes
  through the tagger's prompt (`scripts/lib/tagging.ts`). Both use Haiku
  5.5: measured about $0.0004–0.0006 a page and $0.0005 a sheet, 2–4 s
  each. The result lands in the asset's `source_url`, `source` and
  `analysis`, written with the uploader's own token, so row-level security
  decides. It needs Supabase and `ANTHROPIC_API_KEY` on the server.
- **Show in Feed** (`assets.in_feed`) puts the clip in everyone's Feed and
  search. The search index bundle only covers the library, so the app
  builds a shared upload's search doc itself (`src/search/docs.ts`, the
  same code `npm run index` uses) from its source and tags. Uploads get no
  SigLIP embedding, so they match on text and tags, not on looks.

**Upload limit.** Each account stores up to 1 GB of uploads (decimal, as
Finder counts), the original and its L0/L1/L2 proxies all counted; the
account menu shows how much is used. Admins (`private.admins`, today just
isthishenry@gmail.com) have no limit. A drop that doesn't fit is turned
away before it's processed. After its proxies are built, the app reserves
the clip's full size with `reserve_upload()`; a trigger on `assets.bytes`
refuses any reservation past the limit, and the media Worker stores no
more under `media/<hash>/` than the row has reserved
(`supabase/migrations/20261023235500_upload_quota.sql`). A clip that fits
on drop but not once its proxies exist keeps playing on that device, isn't
saved, and tries again on the next open.

**Delete upload** (same panel) gives the space back. `delete_upload()`
takes the clip off the uploader's collections and drops its row in one
transaction, then leaves a tombstone that lets the uploader delete its
files through the Worker (`DELETE /media/<hash>/`); a deletion of files
that doesn't finish runs again on the next open
(`supabase/migrations/20261023235900_delete_uploads.sql`,
`src/app/deleteUpload.ts`). It's refused while anyone else has the clip in
a collection, since their boards aren't the uploader's to change. Copies
in Cloudflare's edge cache outside the location that served the delete
age out on their own.

### Canvas controls

Two-finger scroll pans; pinch, ctrl/cmd + wheel or a mouse wheel zooms.
Drag empty board to marquee; drag clips to move; corner handles resize.
`V` select, `H` hand (or hold `Space`), `N` note, `F` fit, `1` 100%,
`⌘Z` / `⇧⌘Z` undo/redo, `⌫` delete, arrows nudge. Tap `Space` to pause
everything. Double-click a clip for focus mode: `Space` play/pause, `,` `.`
step a frame, `I` `O` set in/out, `Esc` exit. `` ` `` toggles the renderer
overlay, which has the M0 benchmark (run it on "Benchmark board").

## How it works

```
main thread (React UI, store)       render worker                    ingest worker
----------------------------        -------------                    -------------
panes, layouts, cameras, input ---> one view per pane (OffscreenCanvas)  hash, decode once,
store (IndexedDB) + undo            scheduler: one decoder budget       encode L1/L2, BC1 L0,
                                    across all views                    write to OPFS
                                    streams shared per (source, range,
                                    clock); BC1 sprite atlas; renderer
```

- **Level of detail.** Each clip has an L0 sprite (24 frames, 128 px tall, BC1,
  about 100 KB), a 480p L1 and a 1080p L2 (H.264, 1 s closed GOP, no B-frames).
  The scheduler picks a tier from each clip's on-screen height, ranks clips by
  visible area, and grants L1/L2 decoders until the budget runs out. On a
  board, L0 is always resident, so a tile is never blank. While a scrolling
  pane moves faster than 1.5 viewports a second, its clips start no new
  video: a tile would be gone before its stream started, and the downloads
  would hold up sprite loads. Video resumes as soon as it slows.
- **Sprite residency.** The L0 atlas is a cache: each layer is cut into
  fixed one-frame cells per frame width, so any sprite can be evicted and its
  cells reused. Scrolling panes (Feed, Collections) load sprites only for
  clips within two viewports of what is visible, nearest first; past
  256 BC1 layers (512 MB) the least recently used sprites that no board or
  nearby tile needs make room, and reload from OPFS when wanted again.
- **One clock.** Every clip's frame derives from the board time, in a
  "virtual" timeline where loop *k* of a clip of length *D* covers
  [*kD*, (*k*+1)*D*). Decoders loop forever without resets, L0 and video show
  the same moment, and scrubbing is just a different target time.
- **Crossfades.** A new tier fades in over the old one in 150 ms (video quads
  blend over the L0 tile, depth-tested so stacking stays right), and the old
  stream closes once covered.
- **Adaptive budget.** An overloaded decoder fails silently: frames arrive late,
  or a new decoder never produces one. The engine measures both, cuts the
  budget by a quarter when either shows, and adds one decoder back every
  500 ms once things have been clean for 2 s.
- **Off the main thread.** Rendering and decoding run in a worker that owns
  every pane's canvas, so UI work never costs the board a frame. Panes that
  scroll (Collections, Feed) scroll virtually: one number drives both the DOM
  chrome and the GPU camera in the same frame, so covers don't swim under
  their labels. The Feed mounts tiles, and sends the engine items, only near
  the viewport.

Code map: `src/engine/` (render worker), `src/ingest/` (ingest worker),
`src/app/` (React UI: `store.ts`, `Workspace.tsx`, `collections/`, `feed/`,
`canvas/BoardController.ts`, `layout/` placement and arrange), `src/data/`
(model and IndexedDB), `src/media/` (BC1 codec, L0 format, shared with the
scripts), `src/search/` (search engine, worker and taxonomy), `api/` (the
query embedding function), `scripts/` (clip generator, proxy builder,
scraper, tagging, embeddings, search index, tests).

## M0 results

Apple M4 Pro, Chromium in the Claude desktop browser pane, 1024×768 CSS px at
2x, 200 synthetic clips, 120 Hz.

| Run | Result |
| --- | --- |
| Benchmark gate (all 200 clips on screen) | **Pass**: 120 fps, p95 frame 9.9 ms, 0 frames over 25 ms |
| Whole benchmark (push-ins to L1/L2, fast pans) | 120 fps, p95 9.7 ms, worker CPU p95 under 0.7 ms/frame, 0% stale video frames |
| Stress: every clip asks for L1, budget 200 | Rendering stays at 120 fps; adaptive budget settles at 86–101 L1 decoders, 0% stale |
| Stress: every clip asks for L2 | Settles at about 22 L2 decoders, 0% stale |

Memory: the L0 atlas for 200 clips is 32 layers of BC1 (64 MB); L0 downloads
total 19.6 MB.

Not yet measured: a real Chrome window at full laptop resolution, Safari, and
lower-end GPUs. The overlay and `B` benchmark are there for that.

## Next

Left from the spec's canvas list: group into frames, rotation, "arrange by
vibe" (needs M2 embeddings). Then **M2 search**: signal features,
embeddings, VLM contact-sheet tags, dim-to-filter, find similar.
