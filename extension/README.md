# motion.isthishenry.chrome

A Chrome extension for pulling video design references off any page and into codex-motion. It used to be VideoPull.

Click the toolbar icon (or press **Alt+Shift+V**), hover the video you want, click it. That's it.

## What it does today

- **Cursor picker overlay.** The cursor becomes a crosshair and the `<video>` under it is outlined with a pulsing violet frame. Everything else dims slightly so the target is unambiguous.
- **Live badge.** Above the outline you see resolution, duration, and how the video will be grabbed: direct file, Vimeo via yt-dlp, HLS, DASH, or MediaSource (`blob:`).
- **Page details go into the file.** When you pick a video, the extension reads what the page says about it, in the shapes the site scraper keeps: the page's title, description, og and JSON-LD tags and visible text, and the card around the video (its heading, the section heading, a caption, the text beside it, the link it points at). On Instagram and X it reads the post's own text instead of the feed's. The helper adds yt-dlp's metadata for the file (who posted it, when, their description and tags) and writes it all into the video's comment tag as JSON, with a stream copy (nothing is re-encoded). Drop the file onto a codex-motion board and the clip arrives with its source filled in. Signed in, the app also enriches it from those details, as the Enrich button does, without fetching the page again, so Instagram posts and private Vimeo links work too. See `src/media/capture.ts` in the app for the format.
- **Vimeo → yt-dlp.** Any Vimeo video (on vimeo.com, inside the player frame, or embedded on another site) is handed to a local helper that runs:
  ```
  yt-dlp -f "bv*+ba/b" --merge-output-format mp4 --cookies-from-browser chrome \
         -P ~/Downloads/motion.isthishenry -o "%(title)s.%(ext)s" "https://vimeo.com/<ID>"
  ```
  Progress streams back into the page as a toast. Domain-restricted embeds are fetched through the `player.vimeo.com` URL with the embedding page as referer. Private links keep their hash.
- **Instagram, X, TikTok, YouTube and any other streamed player → yt-dlp.** Streamed videos (`blob:` MediaSource, HLS, DASH) can't be downloaded directly, so they go through the same helper. On feed pages the page URL isn't the post, so the picker finds the post's permalink next to the clicked video: on Instagram that is the timestamp link (`/p/…`, `/reel/…`), on X the `/status/…` link. Reels URLs are normalised to `/reel/`. Anything unrecognised falls back to yt-dlp on the page URL. YouTube runs without cookies; yt-dlp with account cookies is known to get YouTube accounts flagged.
- **Instagram carousels.** Clicking a video in a carousel saves that slide only. The picker reads which slide is showing from the carousel's position dots (no Instagram class names involved) and from `?img_index=` on a post URL, and the badge shows it before you click: `Instagram · slide 3/7 · via yt-dlp`. The helper reads the post once, cross-checks those hints against the real slide count (and against the player's own CDN file or poster when available), then downloads just that slide from the saved metadata. **⌥+click** saves every slide of the post, image slides included as JPEGs; **⇧⌥+click** queues the whole post. Files are named `owner - POSTID - 3 of 7.mp4`, so slides and posts by the same account never overwrite each other. If no hint identifies the slide, every video slide is saved and the toast says so.
- **Direct files** download straight into `~/Downloads/motion.isthishenry/`, named after the page title and resolution. The page's own player is prevented from reacting to the click. Chrome downloads them itself (with the page's cookies); the helper then writes the page details into them.
- **Works through shadow DOM and same-origin iframes.** Videos hidden behind player chrome or with `pointer-events: none` are still pickable.
- **Shift+click to queue.** Shift+click several videos (numbered green markers, count in the HUD), shift+click again to remove one, then press **Enter** or click away to download them in order. yt-dlp jobs run one at a time; the toast shows `2/5 · yt-dlp · Instagram Cabc · 42%` and a summary at the end. A plain click on a video while a queue exists downloads the queue and then that video. The queue lives in the background worker, so videos picked in different frames land in one list.
- **Esc** cancels, queue included. Clicking the icon again while active also cancels.

## Install

### 1. Extension

From a release: download `motion.isthishenry.chrome-<version>.zip` from the codex-motion repo's [Releases](https://github.com/henrysallan/codex-motion/releases) and unzip it somewhere it can stay. From a checkout: use this `extension/` folder.

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the folder.
4. Pin motion.isthishenry.chrome to the toolbar.

Chrome only installs packed extensions from the Web Store, so a release is a folder you load unpacked, and updating means replacing the folder's contents and pressing the reload icon on the extension's card.

The manifest carries a fixed `key`, so the extension ID is always `fnigmbnnpjefkeakflphloaidndjcfbg` regardless of where the folder lives (it's the same ID VideoPull had). After editing files, hit the refresh icon on the extension card.

### 2. Helper for yt-dlp (native messaging host)

Chrome extensions cannot run shell commands, so yt-dlp downloads, and writing page details into files, go through a small Python helper that Chrome launches on demand.

```bash
brew install yt-dlp ffmpeg     # if you don't have them
./host/install.sh
```

The installer copies `host/motion_host.py` to `~/Library/Application Support/motion.isthishenry/`, gives it an absolute `/usr/bin/python3` shebang, writes `com.isthishenry.motion.host.json` into the `NativeMessagingHosts` folder of every Chrome-based browser it finds (allowing only this extension's ID), and pings the installed copy with Chrome's minimal environment. It also removes VideoPull's old helper (`com.videopull.host`) if it finds one. Re-run it after editing the host script. `./host/install.sh --uninstall` removes everything.

Why copy? macOS only lets Chrome's child processes read privacy-protected folders (`~/Documents`, `~/Desktop`, iCloud Drive) if Chrome has been granted access, so a helper living in this repo fails with "Helper disconnected: native host has exited". Application Support has no such restriction.

**Every file opens in QuickTime.** yt-dlp is told to prefer H.264 + AAC (`-S vcodec:h264,acodec:aac`) and to remux into `.mp4`. After each download the helper probes the result with ffprobe; anything macOS can't play natively (VP9, AV1, Opus, Vorbis, `.webm`) is converted with ffmpeg to H.264/AAC, copying whichever stream was already fine. Instagram and YouTube are the usual offenders. The toast shows "converting vp9+opus → H.264/AAC" while it runs.

The helper logs to `~/Library/Logs/motion.isthishenry/host.log`: every start, every command, yt-dlp's final result, and any crash. Look there first when a download fails.

The first Vimeo or Instagram download triggers a macOS Keychain prompt: yt-dlp needs "Chrome Safe Storage" to decrypt Chrome's cookies. Click **Always Allow**.

## Layout

```
manifest.json           MV3 manifest. Permissions: activeTab, scripting, downloads, nativeMessaging.
background.js           Service worker: injects the picker, relays messages, resolves Vimeo IDs,
                        builds each download's capture record, talks to the native helper,
                        runs direct downloads.
picker.js               Content script: overlay UI, hit testing, source detection, permalink lookup.
capture.js              Content script: the page context for a picked video (page meta, the card
                        around it, a feed post's text), in the scraper's shapes.
providers.js            Site table shared by picker and background: labels, embed providers,
                        permalink patterns, per-site cookie policy. Add a site here.
host/motion_host.py     Native messaging host: runs yt-dlp, streams progress back, writes the
                        capture into each saved file.
host/install.sh         Registers the host with Chrome; checks yt-dlp / ffmpeg.
icons/                  Generated toolbar icons.
scripts/make-icons.mjs  Regenerates the icons (node scripts/make-icons.mjs, no deps).
scripts/package.mjs     Zips the extension for a release (npm run ext:zip from the repo root).
dev/test.html           Fixture page: video cases (direct, pointer-events:none, shadow DOM, no source,
                        HLS, blob, Vimeo embed, feed post, carousel, project card) with a stubbed
                        chrome.runtime.
dev/serve.mjs           Static server for the fixture: node dev/serve.mjs → localhost:8765
```

The capture format's tests live with the app's (`scripts/test/capture.test.ts`, `npm test`), including the trip through a real file: the helper's ffmpeg write and the app's mediabunny read.

## Releasing

Bump `version` in `manifest.json`, commit, then tag and push from the repo root:

```bash
git tag ext-v0.3.0 && git push origin ext-v0.3.0
```

`.github/workflows/extension-release.yml` zips the extension and the helper with `scripts/package.mjs` and attaches the zip to a GitHub release named for the tag. The run fails if the tag doesn't match the manifest's version. `npm run ext:zip` builds the same zip locally, in `dist/`.

## How Vimeo detection works

The picker reports three URLs with every selection: the top page, the frame the `<video>` lives in, and (for cross-origin embeds it cannot script) the iframe `src`. The background looks for a Vimeo video ID in each, in that order. Recognised shapes:

```
vimeo.com/123456789                 vimeo.com/123456789/abcdef1234 (private hash)
vimeo.com/channels/staff/123456789  vimeo.com/groups/x/videos/123456789
vimeo.com/manage/videos/123456789   player.vimeo.com/video/123456789?h=abcdef1234
```

## Known limits

- **Cross-origin iframes** other than Vimeo are only reachable if Chrome grants `activeTab` to those frames. If injection into all frames fails, the picker falls back to the top frame only.
- **CDNs that require the page session** may reject the download Chrome initiates for direct files. You'll get a toast explaining the interruption.
- **Page details need the helper and ffmpeg.** Without them a direct file downloads as before, and the toast says the details weren't kept. Image slides and `.webm` files don't carry them.
- **A saved file's hash includes its page details**, and the library keys clips by hash. The same video saved twice from pages that changed in between (a new comment, a new view count in the page text) becomes two clips.

## Roadmap

- A side panel: sign in to codex-motion, pick where saves go (a daily collection by default), and add each save to the library directly, enriched, without the drag.
- Frame grab: snapshot the current frame as PNG.
