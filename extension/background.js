// motion.isthishenry — background service worker (MV3)
//
// Responsibilities:
//   1. Toolbar click / shortcut → inject the picker into every frame of the active tab.
//   2. Relay picker messages between frames (cancel, deactivate, toast, queue state).
//   3. Keep a per-tab queue of shift-clicked videos and download them in sequence:
//        • Vimeo (page, player frame, or embedded iframe) → yt-dlp via the native helper
//        • plain http(s) file → chrome.downloads
//        • any other streamed player → yt-dlp on the post permalink / page URL
//   4. Send each download's capture record (the page context the picker read,
//      see capture.js) to the helper, which writes it into the saved file.

import './providers.js';

const { siteForUrl, permalinkFromUrl } = globalThis.MotionProviders;

const DOWNLOAD_DIR = 'motion.isthishenry';
const NATIVE_HOST = 'com.isthishenry.motion.host';
const PICKER_FILES = ['providers.js', 'capture.js', 'picker.js'];
// The capture record's marker and format version; the app reads files that
// carry it (src/app/capture.ts).
const CAPTURE_KEY = 'motion.isthishenry';
const CAPTURE_VERSION = 1;
const INSTALL_HINT = 'Run ./host/install.sh in the extension folder, then reload the extension.';

// tabId -> [{ id, payload }]  videos queued with shift-click, in order
const queues = new Map();
// downloadId -> resolve(fn) for direct downloads we are awaiting
const pendingDownloads = new Map();
// tabId -> true while a queue is being processed (prevents a second run overlapping)
const running = new Set();

// -----------------------------------------------------------------------------
// Injection
// -----------------------------------------------------------------------------

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    await injectPicker(tab.id);
  } catch (err) {
    // chrome://, the Web Store, PDF viewer, etc. cannot be scripted.
    console.warn('[motion] cannot inject picker here:', err?.message ?? err);
    flashBadge(tab.id, '!', '#d33');
  }
});

async function injectPicker(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: PICKER_FILES });
  } catch (err) {
    // activeTab may not cover cross-origin frames; fall back to the top frame only.
    console.info('[motion] allFrames injection failed, retrying top frame only:', err?.message ?? err);
    await chrome.scripting.executeScript({ target: { tabId }, files: PICKER_FILES });
  }
}

// -----------------------------------------------------------------------------
// Messages from the picker
// -----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId || !msg || typeof msg.type !== 'string') return false;

  switch (msg.type) {
    case 'motion:cancel': {
      queues.delete(tabId);
      deactivateAll(tabId);
      sendResponse({ ok: true });
      return false;
    }

    // Plain click: download this one video now (a queue of one). Anything
    // already queued is included ahead of it.
    case 'motion:select': {
      const items = takeQueue(tabId);
      items.push({ id: msg.id || randomId(), payload: msg.payload, page: topPage(sender, msg.payload) });
      deactivateAll(tabId);
      sendResponse({ ok: true });
      runQueue(tabId, items);
      return false;
    }

    case 'motion:queue-add': {
      const q = queues.get(tabId) || [];
      if (!q.some((it) => it.id === msg.id)) q.push({ id: msg.id, payload: msg.payload, page: topPage(sender, msg.payload) });
      queues.set(tabId, q);
      broadcastQueue(tabId);
      sendResponse({ ok: true, count: q.length });
      return false;
    }

    case 'motion:queue-remove': {
      const q = (queues.get(tabId) || []).filter((it) => it.id !== msg.id);
      if (q.length) queues.set(tabId, q);
      else queues.delete(tabId);
      broadcastQueue(tabId);
      sendResponse({ ok: true, count: q.length });
      return false;
    }

    case 'motion:queue-run': {
      const items = takeQueue(tabId);
      deactivateAll(tabId);
      sendResponse({ ok: true, count: items.length });
      if (items.length) runQueue(tabId, items);
      return false;
    }

    default:
      return false;
  }
});

// A video picked in a child frame carries no page meta: that frame's page is
// the player. Ask the top frame for it while the video is still on screen.
function topPage(sender, payload) {
  if (payload?.page || !sender.frameId) return null;
  return chrome.tabs
    .sendMessage(sender.tab.id, { type: 'motion:page' }, { frameId: 0 })
    .then((r) => r?.page ?? null, () => null);
}

function takeQueue(tabId) {
  const items = queues.get(tabId) || [];
  queues.delete(tabId);
  return items;
}

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

function deactivateAll(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'motion:deactivate' }).catch(() => {});
}

function broadcastQueue(tabId) {
  const ids = (queues.get(tabId) || []).map((it) => it.id);
  chrome.tabs.sendMessage(tabId, { type: 'motion:queue', ids }).catch(() => {});
}

function toast(tabId, result) {
  chrome.tabs
    .sendMessage(tabId, { type: 'motion:toast', ...result }, { frameId: 0 })
    .catch(() => {});
}

// -----------------------------------------------------------------------------
// Queue processing
// -----------------------------------------------------------------------------

async function runQueue(tabId, items) {
  if (running.has(tabId)) {
    // A run is in progress; append instead of overlapping (yt-dlp runs one at a time).
    const q = queues.get(tabId) || [];
    queues.set(tabId, q.concat(items));
    toast(tabId, { ok: true, sticky: true, message: `Added ${items.length} to the running queue` });
    return;
  }
  running.add(tabId);
  const total = items.length;
  let saved = 0;
  let failed = 0;

  try {
    for (let i = 0; i < items.length; i++) {
      const prefix = total > 1 ? `${i + 1}/${total} · ` : '';
      const item = items[i];
      let res;
      try {
        if (item.page && !item.payload?.page) item.payload.page = (await item.page) ?? undefined;
        res = await processItem(tabId, item.payload, prefix);
      } catch (err) {
        res = { ok: false, message: `Failed: ${err?.message ?? err}` };
      }
      res.ok ? saved++ : failed++;
      toast(tabId, { ...res, message: prefix + res.message, sticky: false });
      // Give a failure toast a moment to be readable before the next item's progress replaces it.
      if (!res.ok && i < items.length - 1) await sleep(1800);
    }
    // Items added while we were running.
    const more = takeQueue(tabId);
    if (more.length) {
      running.delete(tabId);
      return runQueue(tabId, more);
    }
  } finally {
    running.delete(tabId);
  }

  if (total > 1) {
    toast(tabId, {
      ok: failed === 0,
      message: `Queue finished · ${saved} saved${failed ? ` · ${failed} failed` : ''} → ~/Downloads/${DOWNLOAD_DIR}`,
    });
    flashBadge(tabId, failed ? '!' : '✓', failed ? '#d33' : '#2a9d5c');
  }
}

/**
 * payload = {
 *   kind: 'direct' | 'blob' | 'hls' | 'dash' | 'none' | 'embed',
 *   src, sources: [{src,type}], poster, width, height, duration,
 *   pageUrl, pageTitle, frameUrl, permalink?, provider?,
 *   page?, context?   (capture.js; page comes from the top frame)
 * }
 * Resolves when the item has fully finished (saved or failed).
 */
async function processItem(tabId, payload, prefix = '') {
  if (!payload) return { ok: false, message: 'No video data received.' };
  const { kind, src } = payload;

  // 1. Vimeo anywhere in the picture → yt-dlp with the canonical Vimeo URL.
  const vimeo = resolveVimeo(payload);
  if (vimeo) {
    const capture = buildCapture(payload, { url: vimeo.url, provider: 'Vimeo' });
    return ytdlp(tabId, { ...vimeo, label: `Vimeo ${vimeo.id}`, cookies: true, capture }, prefix);
  }

  // 2. Plain file → let Chrome download it. Carousel sites (Instagram) skip
  //    this: yt-dlp gets the best rendition and names each slide properly.
  if (kind === 'direct' && src && !siteForUrl(payload.pageUrl)?.carousel) {
    return directDownload(tabId, payload, buildCapture(payload, { url: src }), prefix);
  }

  // 3. Anything streamed → yt-dlp on the post permalink, or failing that the page URL.
  const target = resolveGeneric(payload);
  if (target?.error) return { ok: false, message: target.error };
  if (target) {
    const provider = siteForUrl(target.url)?.name;
    target.capture = buildCapture(payload, { url: target.url, ...(provider ? { provider } : {}) });
    return ytdlp(tabId, target, prefix);
  }

  if (kind === 'embed') {
    return { ok: false, message: `Embedded ${payload.provider || 'player'} is not supported yet.` };
  }
  if (kind === 'none' || !src) {
    return { ok: false, message: 'That video has no readable source yet. Try pressing play first.' };
  }
  return { ok: false, message: 'This video is streamed and the page has no URL yt-dlp can use.' };
}

/**
 * The capture record the helper writes into the saved file: the page the
 * video was seen on (the post, on feed sites), what that page said about
 * it, the card around it, and where the file came from. The helper adds
 * yt-dlp's metadata per file. Nothing time-dependent goes in: the library
 * keys clips by the file's hash, so the same video saved twice should
 * differ as little as possible.
 */
function buildCapture(payload, media) {
  const site = siteForUrl(payload.pageUrl);
  const permalink =
    (payload.permalink && /^https?:/i.test(payload.permalink) ? payload.permalink : '') ||
    permalinkFromUrl(site, payload.pageUrl);
  const context = payload.context && Object.keys(payload.context).length ? payload.context : null;
  return {
    [CAPTURE_KEY]: CAPTURE_VERSION,
    url: permalink || payload.pageUrl,
    ...(payload.page ? { page: payload.page } : {}),
    ...(context ? { context } : {}),
    ...(media?.url && /^https?:/i.test(media.url) ? { media } : {}),
    ...(payload.slide ? { slide: payload.slide } : {}),
  };
}

/**
 * Builds the yt-dlp target for a non-Vimeo video:
 *   • the post permalink the picker found next to the video (feed pages), else
 *   • a permalink pattern matched against the page URL itself, else
 *   • the page URL as-is.
 * Only http(s) pages qualify; local files and extension pages return null.
 */
function resolveGeneric(payload) {
  const pageUrl = payload.pageUrl || '';
  if (!/^https?:/i.test(pageUrl)) return null;

  const site = siteForUrl(pageUrl);
  const permalink =
    (payload.permalink && /^https?:/i.test(payload.permalink) ? payload.permalink : '') ||
    permalinkFromUrl(site, pageUrl);

  // On a feed site, a bare feed URL (instagram.com/, x.com/home) is useless to
  // yt-dlp. Tell the user how to get a post URL instead of failing obscurely.
  if (site?.permalink && !permalink) {
    return {
      error: `Couldn't tell which ${site.name} post this is. Open the post itself (click its timestamp) and pick again.`,
    };
  }

  const url = permalink || pageUrl;
  let label = site?.name || hostOf(pageUrl).replace(/^www\./, '');
  if (site?.permalink) {
    const tail = url.replace(/\/$/, '').split('/').pop();
    if (tail) label += ` ${tail}`;
  }

  const target = { url, referer: null, label, cookies: site ? site.cookies !== false : true };
  if (site?.carousel) {
    // The helper reads the post once, then saves the slide the picker saw
    // (or every slide for ⌥-click), each with its own filename.
    Object.assign(target, {
      probe: true,
      whole: !!payload.whole,
      slide: payload.slide || null,
      urlIndex: payload.urlIndex || null,
      poster: payload.poster || null,
      // A plain CDN file the player was using identifies the exact slide.
      mediaUrl: /^https?:/i.test(payload.src || '') ? payload.src : null,
    });
    if (payload.whole) target.label += ' · whole post';
  }
  return target;
}

// -----------------------------------------------------------------------------
// Vimeo detection
// -----------------------------------------------------------------------------

/**
 * Looks for a Vimeo video ID in, in order: the embed iframe src, the frame the
 * <video> lives in, and the top page URL.
 *
 * Returns { url, referer, id } for yt-dlp, or null.
 *   • On vimeo.com itself      → https://vimeo.com/ID[/HASH]
 *   • Embedded elsewhere       → https://player.vimeo.com/video/ID[?h=HASH] + --referer page
 *     (domain-restricted embeds only resolve through the player URL with the right referer)
 */
function resolveVimeo(payload) {
  const candidates = [];
  if (payload.kind === 'embed' && payload.src) candidates.push(payload.src);
  if (payload.frameUrl) candidates.push(payload.frameUrl);
  if (payload.pageUrl) candidates.push(payload.pageUrl);

  let found = null;
  for (const c of candidates) {
    found = parseVimeoUrl(c);
    if (found) break;
  }
  if (!found) return null;

  const pageIsVimeo = isVimeoHost(hostOf(payload.pageUrl));
  const { id, hash } = found;

  if (pageIsVimeo) {
    return { id, url: `https://vimeo.com/${id}${hash ? `/${hash}` : ''}`, referer: null };
  }
  return {
    id,
    url: `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ''}`,
    referer: payload.pageUrl || null,
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isVimeoHost(host) {
  return host === 'vimeo.com' || host.endsWith('.vimeo.com');
}

function parseVimeoUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!isVimeoHost(u.hostname.toLowerCase())) return null;
  const segs = u.pathname.split('/').filter(Boolean);

  // player.vimeo.com/video/ID?h=HASH
  if (u.hostname.startsWith('player.')) {
    const i = segs.indexOf('video');
    const id = i >= 0 ? segs[i + 1] : null;
    if (id && /^\d{5,}$/.test(id)) {
      return { id, hash: u.searchParams.get('h') || hashSegment(segs[i + 2]) };
    }
    return null;
  }

  // vimeo.com/ID, vimeo.com/ID/HASH, vimeo.com/channels/x/ID, vimeo.com/groups/x/videos/ID,
  // vimeo.com/manage/videos/ID, vimeo.com/showcase/x/video/ID, vimeo.com/user/review/ID/HASH
  for (let i = segs.length - 1; i >= 0; i--) {
    if (/^\d{5,}$/.test(segs[i])) {
      return { id: segs[i], hash: u.searchParams.get('h') || hashSegment(segs[i + 1]) };
    }
  }
  return null;
}

function hashSegment(seg) {
  return seg && /^[0-9a-f]{6,12}$/i.test(seg) ? seg : null;
}

// -----------------------------------------------------------------------------
// yt-dlp via native messaging host. Resolves when yt-dlp finishes.
// -----------------------------------------------------------------------------

function ytdlp(tabId, target, prefix = '') {
  return new Promise((resolve) => {
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (err) {
      resolve({ ok: false, message: `Helper unavailable: ${err?.message ?? err}. ${INSTALL_HINT}` });
      return;
    }

    let gotAnyMessage = false;
    let settled = false;
    let lastToastAt = 0;
    const label = target.label || hostOf(target.url);
    const progress = (text) => toast(tabId, { ok: true, sticky: true, message: `${prefix}yt-dlp · ${label} · ${text}` });

    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    port.onMessage.addListener((msg) => {
      gotAnyMessage = true;
      switch (msg?.type) {
        case 'started':
          progress('starting…');
          flashBadge(tabId, '…', '#8b5cf6');
          break;
        case 'progress': {
          const now = Date.now();
          if (now - lastToastAt < 250 && msg.percent < 100) break;
          lastToastAt = now;
          progress(`${msg.item ? `${msg.item} · ` : ''}${msg.percent.toFixed(1)}%`);
          break;
        }
        case 'log':
          if (/merging|ffmpeg/i.test(msg.line || '')) progress('merging video + audio…');
          break;
        case 'stage':
          progress(msg.text || 'working…');
          break;
        case 'done': {
          console.info('[motion] yt-dlp done', msg);
          if (!msg.ok) {
            settle({ ok: false, message: `yt-dlp failed (${label}): ${trim(msg.error, 200)}` });
          } else {
            const files = msg.files?.length ? msg.files : [msg.file].filter(Boolean);
            const what = files.length > 1 ? `${files.length} files from ${label}` : basename(files[0]) || 'video';
            settle({ ok: true, message: `Saved ${what}${msg.note ? `. ${msg.note}` : ''}` });
          }
          port.disconnect();
          break;
        }
        default:
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || '';
      if (!gotAnyMessage) {
        const notInstalled = /not found|forbidden|Specified native messaging host/i.test(err);
        const exited = /exited/i.test(err);
        settle({
          ok: false,
          message: notInstalled
            ? `motion.isthishenry helper not installed. ${INSTALL_HINT}`
            : exited
              ? `Helper started but exited before replying. Re-run ./host/install.sh (it installs the helper outside ~/Documents) and check ~/Library/Logs/motion.isthishenry/host.log`
              : `Helper disconnected: ${err || 'unknown error'}`,
        });
      } else {
        settle({ ok: false, message: `Helper exited unexpectedly${err ? `: ${err}` : ''}` });
      }
    });

    port.postMessage({
      cmd: 'download',
      url: target.url,
      referer: target.referer,
      outDir: `~/Downloads/${DOWNLOAD_DIR}`,
      browser: target.cookies === false ? 'none' : 'chrome',
      probe: !!target.probe,
      whole: !!target.whole,
      slide: target.slide || null,
      urlIndex: target.urlIndex || null,
      poster: target.poster || null,
      mediaUrl: target.mediaUrl || null,
      capture: target.capture || null,
    });
  });
}

function basename(path) {
  if (!path) return '';
  return path.split('/').pop();
}

function trim(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -----------------------------------------------------------------------------
// Direct downloads. Resolves when Chrome reports the download complete.
// -----------------------------------------------------------------------------

async function directDownload(tabId, payload, capture, prefix = '') {
  const filename = buildFilename(payload);
  toast(tabId, { ok: true, sticky: true, message: `${prefix}Downloading ${filename}` });
  const downloadId = await chrome.downloads.download({
    url: payload.src,
    filename: `${DOWNLOAD_DIR}/${filename}`,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  const outcome = await new Promise((resolve) => pendingDownloads.set(downloadId, resolve));
  if (outcome.ok) {
    flashBadge(tabId, '✓', '#2a9d5c');
    const tagged = await tagDownload(downloadId, capture);
    return { ok: true, message: `Saved ${filename}${tagged === 'no-helper' ? ' · without page details (install the helper to keep them)' : ''}` };
  }
  return {
    ok: false,
    message: `Download interrupted (${outcome.error ?? 'unknown error'}). The CDN may require the page session.`,
  };
}

// Chrome saves direct files itself (with the page's cookies), so the helper
// writes the capture into them afterwards. Resolves 'ok', 'failed', or
// 'no-helper' when the helper isn't installed (the file stays as downloaded).
async function tagDownload(downloadId, capture) {
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (!item?.filename || !capture) return 'failed';
  try {
    let res = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'tag', file: item.filename, capture });
    if (res?.ok && res.pending) res = await swapIn(downloadId, item.filename, res.pending);
    if (!res?.ok) console.warn('[motion] could not write the page details into', item.filename, res?.error);
    return res?.ok ? 'ok' : 'failed';
  } catch (err) {
    const missing = /not found|forbidden|Specified native messaging host/i.test(err?.message ?? '');
    if (!missing) console.warn('[motion] could not write the page details into', item.filename, err);
    return missing ? 'no-helper' : 'failed';
  }
}

// macOS won't let the helper replace a file Chrome saved, only make its own:
// it leaves the tagged copy beside Chrome's, Chrome removes its file, and the
// helper moves the copy into that place.
async function swapIn(downloadId, file, tmp) {
  try {
    await chrome.downloads.removeFile(downloadId);
  } catch (err) {
    await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'abort', file, tmp }).catch(() => {});
    return { ok: false, error: `Chrome couldn't make room for the tagged copy: ${err?.message ?? err}` };
  }
  return chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'commit', file, tmp });
}

chrome.downloads.onChanged.addListener((delta) => {
  const resolve = pendingDownloads.get(delta.id);
  if (!resolve) return;
  if (delta.state?.current === 'complete') {
    pendingDownloads.delete(delta.id);
    resolve({ ok: true });
  } else if (delta.state?.current === 'interrupted') {
    pendingDownloads.delete(delta.id);
    resolve({ ok: false, error: delta.error?.current });
  }
});

function buildFilename({ src, pageTitle, pageUrl, width, height, sources }) {
  let ext = extFromUrl(src);
  if (!ext) {
    const mime = sources?.find((s) => s.src === src)?.type ?? sources?.[0]?.type ?? '';
    ext = extFromMime(mime);
  }
  if (!ext) ext = 'mp4';

  let base = (pageTitle || '').trim();
  if (!base) {
    try {
      base = new URL(pageUrl).hostname;
    } catch {
      base = 'video';
    }
  }
  base = sanitize(base).slice(0, 80) || 'video';
  const dims = width && height ? `-${width}x${height}` : '';
  return `${base}${dims}.${ext}`;
}

function extFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(path);
    if (!m) return '';
    const ext = m[1].toLowerCase();
    return ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'ogg', 'mkv', 'avi', 'gif'].includes(ext) ? ext : '';
  } catch {
    return '';
  }
}

function extFromMime(mime) {
  const m = /^video\/([a-z0-9.-]+)/i.exec(mime || '');
  if (!m) return '';
  const sub = m[1].toLowerCase();
  if (sub === 'quicktime') return 'mov';
  if (sub === 'x-m4v') return 'm4v';
  if (sub === 'ogg') return 'ogv';
  return sub.replace(/[^a-z0-9]/g, '') || '';
}

function sanitize(name) {
  return name
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

function flashBadge(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  setTimeout(() => chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {}), 2500);
}
