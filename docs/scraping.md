# Scraping: how we do it

How Henry's studio scrapes run, from a URL to clips in the Feed. Read this before taking over a batch. As of 2026-10-27: 27,500 scraped clips from 76 sites, all registered, tagged and searchable.

## What Henry wants

He sends batches of studio or agency URLs (usually a `/work` page). Get every video on each site with as much metadata as possible, put it in the Feed, and report back per site. Procedural code goes first. The Claude browser agent is the fallback for sites that hide video behind "Load more", modals and the like.

Standing rules:

- **API budget: $80 in total** for this work. About $33 has been spent so far. Track it from the costs the scripts print (`agent … ~$x`, `enrich … · $x`, `tagged … $x`). Tagging costs about $0.0005 a clip; an agent run is $0.15–1.20.
- **Local storage under 100 GB.** Delete local copies once they're verified in R2 (see Prune).
- **robots.txt:** Henry said not to worry about it, so runs use `--ignore-robots`. The file's sitemaps and crawl-delay are still used.
- **Never work around bot protection:** Vimeo's Turnstile 401s, Cloudflare challenges (`cf-mitigated: challenge`), logins, private videos, HTTP 429 rate limits. Report them and retry later. Henry runs his own Vimeo retry (below); Claude sessions don't run its cookie or impersonation mode.
- **Pushing `main` deploys the site** (Vercel). Commit locally and push when Henry asks. Other sessions edit this checkout too, so commit only your own files and hunks.
- **Uploading the search index** (`search-index.ts --upload`) needs Henry's OK each time.

## The pipeline

`FFMPEG` must point at the arm64 build: `/Users/henryallan/Documents/toolbox/vendor/ffmpeg/darwin-arm64/ffmpeg`. The system ffmpeg is x86 and broken.

| Step | Command | Notes |
|---|---|---|
| 1. Scrape | `node scripts/scrape.ts <url> --max-pages 300 --agent-turns 20 --ignore-robots` | Static crawl, then Chrome, then the agent if needed. Enriches project pages with Haiku and writes `media/scraped/<host>/` (originals, `<id>.json` sidecars, `scrape.json`). Re-running retries only failed items. |
| 2. Build | `node scripts/build-proxies.ts --in media/scraped/<host> --merge` | L0 sprite, L1 480p and L2 1080p in `public/media/<id>/`; updates `library.json`. |
| 3. Embed | `node scripts/embed.ts` | SigLIP 2 vectors for new clips. Local and free. |
| 4. Tag | `node scripts/tag.ts` | Haiku contact-sheet tags for every untagged clip. Never run two at once: both would tag the same clips. |
| 5. Upload | `node --env-file=.env.local scripts/upload-library.ts` | Sends local proxies to R2 through the media Worker. Don't pass `--verify-remote` routinely: it sends a request per file (see Gotchas). |
| 6. Register | `node scripts/pipeline/register-rows.mjs <host> …`, then the SQL below per part | Publishes asset rows as JSON parts through the Worker and prints their URLs. |
| 7. Prune | `node scripts/pipeline/prune.mjs --delete` | Checks every local proxy against R2 by size and deletes the verified proxies and their originals. Anything not in R2 is kept. |
| 8. Index | `node --env-file=.env.local scripts/search-index.ts --upload` | Once all of a batch is registered, and with Henry's OK. The manifest goes up last, so a failed run never goes live; just re-run it. |

**Register SQL** (Supabase project `nmmddnszqlrplwvcqgdn`, through the Supabase MCP `execute_sql`): first `create extension if not exists http with schema extensions;`, then for each part URL:

```sql
select extensions.http_set_curlopt('CURLOPT_TIMEOUT', '50');
insert into public.assets (id, name, origin, status, duration, width, height, fps, renditions, source_url, source_title, source, analysis, added_by)
select r->>'id', r->>'name', 'scraper', 'ready', (r->>'duration')::float8, (r->>'width')::int, (r->>'height')::int, (r->>'fps')::float8,
       r->'renditions', r->>'source_url', r->>'source_title', r->'source', nullif(r->'analysis', 'null'::jsonb), null
from jsonb_array_elements((select content::jsonb from extensions.http_get('<part url>'))) as r
on conflict (id) do update set name = excluded.name, origin = excluded.origin, status = excluded.status, renditions = excluded.renditions,
  source_url = excluded.source_url, source_title = excluded.source_title, source = excluded.source, analysis = excluded.analysis, updated_at = now();
```

Then `drop extension http;`. Check that `select count(*) from public.assets where origin = 'scraper'` equals the library's scraped count. Append the part keys (`media/<hash>/original.json`) to `media/r2-orphans.txt`, which lists R2 objects nothing uses; Henry deletes them with wrangler.

**Batches.** `scripts/pipeline/queue.sh <log-dir> "url name" …` scrapes two at a time; `TURNS=12` lowers the agent budget. `scripts/pipeline/process.sh <log-dir> name …` runs steps 2–5 and 7 for each site as soon as its scrape finishes, which keeps disk use low. Run both as background jobs, then do steps 6 and 8 once the processor exits. Keep logs under `media/scrape-logs/<batch>/`, which is git-ignored.

## After each site: read the failures

Break down each site's failures from `scrape.json` before reporting:

```bash
node -e "const j=require('./media/scraped/<host>/scrape.json'); const c={}; for (const i of j.items) if (i.status==='failed') { const k=(i.reason??'').match(/HTTP Error \d+|HTTP \d+|not a [a-z ]+|No video format/)?.[0] ?? i.reason?.slice(0,80); c[k]=(c[k]||0)+1 } console.log(c)"
```

- **Vimeo 401 "Unauthorized":** Vimeo's per-video Turnstile check. Count them per site for Henry. He runs `scripts/vimeo-retry.sh media/scraped/<host>` himself; then `node scripts/vimeo-adopt.ts` folds the downloads back into the scrape with their project metadata, and you run steps 2–8.
- **Many 404s/400s on URLs that are bare file names** (`site.com/Clip_Name.mp4`): almost always a label read as a link, which is a scraper bug. Find where the name sits in the page (alt text, JSON title, data arrays) and fix `scripts/scrape/extract.ts`. Earlier cases: Squarespace `alt`, WordPress player titles, and devalue arrays.
- **HTTP 429 on every page:** the site is rate-limiting us. The scraper stops by itself; retry another day.
- **403 with `cf-mitigated: challenge`:** a Cloudflare bot check. Leave it.

## What the scraper handles

Files, HLS/DASH, and the players yt-dlp knows (Vimeo, YouTube, Wistia, Mux, Cloudflare Stream, …).

- **Vimeo:** one request at a time per process, 5–8 s apart, stopping after three refusals in a row (`scripts/scrape/download.ts`). Signed `/play/` manifests are keyed by video id; `/external/*.m3u8` links are treated as streams.
- **FrameRate** (framerate.tv) embeds are resolved in Chrome to their Mux stream.
- **Animated GIFs** become MP4s (`scripts/lib/gif.ts`). Stills, icons and loaders are skipped.
- **Tests:** `npm test` (`scripts/test/scrape.test.ts`, `gif.test.ts`). Add a case for every extraction fix.

## Gotchas

- **The media Worker counts every request.** On the free plan's 100k a day, upload re-checks took media down for the live app. It's now on Workers Paid (10M a month), but still avoid per-file sweeps. Uploads over 40 MB go in 25 MB parts, because single requests over about 55 MB get cut off.
- **`library.json`:** `build-proxies --merge` and `tag.ts` re-read it right before writing, so they can run alongside other work, but don't overlap two `tag.ts` runs.
- **Re-running a site** reuses everything it already downloaded (through `public/media/<id>/asset.json`), even after the originals are pruned.
- **Disk:** one large site can be 5–7 GB of originals plus similar-sized proxies. Prune as you go.

## Open items (2026-10-27)

- Henry's Vimeo retry for brands.mx, further.group, ntsal.com, brucemaudesign.com and templo.co.uk: adopt and process the results when he says it's done.
- Retry later: nomadstudio.com and riccardobottoni.it (rate-limited), and wearemotto.com's 106 files behind a Cloudflare challenge.
- About 440 Vimeo videos across older sites are still Turnstile-blocked (`for d in media/scraped/*` with the failure breakdown above lists them).
