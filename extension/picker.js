// motion.isthishenry — picker content script
//
// Injected into every frame of the active tab when the toolbar icon is clicked.
// Re-injecting toggles the picker off. While active:
//   • the cursor becomes a crosshair
//   • the <video> under the cursor is outlined, with a badge showing its
//     resolution, duration and source type
//   • click grabs it (sent to the background for download)
//   • shift+click queues it (numbered marker) and keeps picking; Enter or a
//     click away downloads the queue in order
//   • Esc cancels everything, queue included
//
// All UI lives inside a closed shadow root so page CSS cannot touch it.

(() => {
  const NS = '__motionPicker';
  if (window[NS]) {
    window[NS].toggle();
    return;
  }

  const isTop = window === window.top;
  const BLOCKED_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick'];

  // Site knowledge (labels, embed providers, permalink patterns) lives in
  // providers.js, and page context in capture.js, both injected just before
  // this file.
  const P = globalThis.MotionProviders || { SITES: [], siteForUrl: () => null, permalinkFromUrl: () => '' };
  const C = globalThis.MotionCapture || null;

  // Cross-origin player iframes we cannot script but can hand to yt-dlp.
  function embedProvider(iframe) {
    const src = iframe.getAttribute('src') || iframe.src || '';
    let abs = '';
    try {
      abs = new URL(src, location.href).href;
    } catch {
      return null;
    }
    const site = P.siteForUrl(abs);
    return site?.embed ? site : null;
  }

  /**
   * On feed pages (Instagram home/reels, X timeline…) the page URL is not the
   * post. Look for the post's permalink: first in the page URL itself, then in
   * anchors inside the nearest post container around the video. Returns
   * { permalink, container }: the container is the post's element, whose
   * text (caption, author, credits) goes into the capture.
   */
  function findPost(v) {
    const site = P.siteForUrl(location.href);
    if (!site?.permalink) return { permalink: '', container: null };

    const fromLocation = P.permalinkFromUrl(site, location.href);
    if (fromLocation) return { permalink: fromLocation, container: v.closest('article') || v.closest('[role="dialog"]') };

    // Walk up from the video. The first ancestor that contains exactly one
    // distinct post link is the post's container (Instagram's timestamp link,
    // X's status link). An ancestor with several distinct post links is the
    // feed itself, at which point we give up rather than guess.
    let node = v.parentElement;
    while (node && node !== document.documentElement) {
      const links = new Set();
      for (const a of node.querySelectorAll('a[href]')) {
        const link = P.permalinkFromUrl(site, a.href);
        if (link) links.add(link);
        if (links.size > 1) break;
      }
      if (links.size === 1) return { permalink: links.values().next().value, container: node };
      if (links.size > 1) return { permalink: '', container: null };
      node = node.parentElement;
    }
    return { permalink: '', container: null };
  }

  /**
   * The page context for a picked video (see capture.js). Only taken when a
   * video is picked or queued, not on hover: reading the page's text costs
   * a layout. A child frame's page is the player, not the page you're on, so
   * the background asks the top frame for the page meta instead.
   */
  function captureFor(v, permalink) {
    if (!C) return {};
    const out = {};
    try {
      const { container } = findPost(v);
      out.context = C.context(v, container);
      // On a feed the page's text is every post; the post's own text is in the context.
      const site = P.siteForUrl(location.href);
      const feed = !!(site?.permalink && permalink && P.permalinkFromUrl(site, location.href) !== permalink);
      if (isTop) out.page = C.page({ withText: !feed });
    } catch (err) {
      console.warn('[motion] could not read the page context:', err);
    }
    return out;
  }

  function isPickable(el) {
    return el instanceof HTMLVideoElement || (el instanceof HTMLIFrameElement && !!embedProvider(el));
  }

  let active = false;
  let host = null;
  let shadow = null;
  let box = null;
  let badge = null;
  let hud = null;
  let cursorStyle = null;
  let target = null;
  let lastPoint = null;
  let rafId = 0;
  let toastTimer = 0;

  // Shift-click queue. Elements queued in THIS frame → { id, mark }.
  // The ordered list of ids across all frames comes from the background.
  const queued = new Map();
  let queueIds = [];
  let marksLayer = null;

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .vp-root {
      position: fixed; inset: 0; z-index: 2147483647;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      font-size: 12px; line-height: 1.2; color: #fff;
    }
    .vp-box {
      position: fixed; left: 0; top: 0; width: 0; height: 0;
      border: 2px solid #8b5cf6;
      border-radius: 6px;
      background: rgba(139, 92, 246, 0.14);
      box-shadow: 0 0 0 1px rgba(0,0,0,.35), 0 0 0 9999px rgba(8, 8, 12, 0.28);
      opacity: 0;
      transition: left .08s ease-out, top .08s ease-out, width .08s ease-out, height .08s ease-out, opacity .12s;
      will-change: left, top, width, height;
    }
    .vp-box.on { opacity: 1; }
    .vp-box::after {
      content: ""; position: absolute; inset: -2px;
      border-radius: 6px;
      border: 2px solid rgba(255,255,255,.55);
      animation: vp-pulse 1.4s ease-in-out infinite;
    }
    @keyframes vp-pulse { 0%,100% { opacity: 0 } 50% { opacity: .9 } }
    .vp-badge {
      position: fixed; left: 0; top: 0;
      transform: translateY(calc(-100% - 8px));
      display: flex; gap: 8px; align-items: center;
      padding: 6px 10px;
      background: #111114; border: 1px solid rgba(255,255,255,.12);
      border-radius: 8px; white-space: nowrap;
      box-shadow: 0 6px 24px rgba(0,0,0,.35);
      opacity: 0; transition: opacity .12s;
    }
    .vp-badge.on { opacity: 1; }
    .vp-badge.below { transform: translateY(8px); }
    .vp-badge b { font-weight: 600; letter-spacing: .01em; }
    .vp-badge .dot { width: 6px; height: 6px; border-radius: 50%; background: #8b5cf6; }
    .vp-badge .kind { color: #c9c9d1; }
    .vp-badge .kind.warn { color: #f3b04b; }
    .vp-mark {
      position: fixed; left: 0; top: 0; width: 0; height: 0;
      border: 2px solid #22c55e; border-radius: 6px;
      background: rgba(34, 197, 94, 0.10);
      box-shadow: 0 0 0 1px rgba(0,0,0,.35);
    }
    .vp-mark .num {
      position: absolute; left: -2px; top: -2px;
      min-width: 24px; height: 24px; padding: 0 7px;
      display: flex; align-items: center; justify-content: center;
      background: #22c55e; color: #052e16; font-weight: 700; font-size: 12px;
      border-radius: 6px 0 8px 0;
    }
    .vp-hud .count {
      background: #22c55e; color: #052e16; font-weight: 700;
      padding: 1px 8px; border-radius: 999px;
    }
    .vp-hud, .vp-toast {
      position: fixed; left: 50%; transform: translateX(-50%);
      padding: 9px 14px; border-radius: 999px;
      background: rgba(17,17,20,.92); color: #fff;
      border: 1px solid rgba(255,255,255,.12);
      box-shadow: 0 8px 30px rgba(0,0,0,.35);
      backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      display: flex; gap: 10px; align-items: center;
      white-space: nowrap;
    }
    .vp-hud { top: 16px; animation: vp-drop .18s ease-out; }
    .vp-hud .logo { width: 8px; height: 8px; border-radius: 50%; background: #8b5cf6; box-shadow: 0 0 0 3px rgba(139,92,246,.25); }
    .vp-hud kbd {
      font: inherit; font-size: 11px; padding: 1px 6px; border-radius: 5px;
      background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.18);
    }
    .vp-hud .dim { color: #b3b3bd; }
    .vp-toast { bottom: 24px; opacity: 0; transition: opacity .15s, transform .15s; transform: translate(-50%, 8px); max-width: min(92vw, 640px); white-space: normal; text-align: center; }
    .vp-toast.on { opacity: 1; transform: translate(-50%, 0); }
    .vp-toast.ok { border-color: rgba(46,204,113,.45); }
    .vp-toast.err { border-color: rgba(243,176,75,.5); }
    @keyframes vp-drop { from { opacity: 0; transform: translate(-50%, -8px) } to { opacity: 1; transform: translate(-50%, 0) } }
  `;

  function mountUI() {
    host = document.createElement('motion-picker');
    host.style.cssText = 'all:initial;position:fixed;inset:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = CSS;

    const root = document.createElement('div');
    root.className = 'vp-root';

    box = document.createElement('div');
    box.className = 'vp-box';

    badge = document.createElement('div');
    badge.className = 'vp-badge';

    marksLayer = document.createElement('div');

    root.append(marksLayer, box, badge);

    if (isTop) {
      hud = document.createElement('div');
      hud.className = 'vp-hud';
      renderHud();
      root.append(hud);
    }

    shadow.append(style, root);
    (document.documentElement || document.body).appendChild(host);

    // Crosshair cursor over everything, including elements that set their own cursor.
    cursorStyle = document.createElement('style');
    cursorStyle.textContent = `*, *::before, *::after { cursor: crosshair !important; }`;
    (document.head || document.documentElement).appendChild(cursorStyle);
  }

  function unmountUI() {
    host?.remove();
    cursorStyle?.remove();
    host = shadow = box = badge = hud = marksLayer = cursorStyle = null;
  }

  // ---------------------------------------------------------------------------
  // Hit testing
  // ---------------------------------------------------------------------------

  function findVideoAt(x, y) {
    // 1. Walk the hit-test stack (pierces open shadow roots).
    const stack = document.elementsFromPoint(x, y);
    for (const el of stack) {
      if (el === host) continue;
      const v = resolveVideo(el, x, y, 0);
      if (v && isVisible(v)) return v;
    }
    // 2. Fallback: videos with pointer-events:none are invisible to elementsFromPoint.
    let best = null;
    let bestArea = Infinity;
    for (const v of cachedVideos()) {
      if (!isVisible(v)) continue;
      const r = v.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        best = v;
        bestArea = area;
      }
    }
    return best;
  }

  function resolveVideo(el, x, y, depth) {
    if (isPickable(el)) return el;
    if (el.shadowRoot && depth < 5) {
      for (const inner of el.shadowRoot.elementsFromPoint(x, y)) {
        if (inner === el) continue;
        const v = resolveVideo(inner, x, y, depth + 1);
        if (v) return v;
      }
    }
    return null;
  }

  // Walking the whole DOM on every mousemove is too expensive on large pages,
  // so the fallback list is refreshed at most a few times per second.
  let videoCache = [];
  let videoCacheAt = 0;
  function cachedVideos() {
    const now = performance.now();
    if (now - videoCacheAt > 400) {
      videoCache = Array.from(allVideos(document, 0));
      videoCacheAt = now;
    }
    return videoCache;
  }

  function* allVideos(root, depth) {
    if (depth > 5) return;
    for (const el of root.querySelectorAll('*')) {
      if (el instanceof HTMLVideoElement) yield el;
      if (el.shadowRoot) yield* allVideos(el.shadowRoot, depth + 1);
    }
  }

  function isVisible(v) {
    const r = v.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(v);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.02;
  }

  // ---------------------------------------------------------------------------
  // Highlight
  // ---------------------------------------------------------------------------

  function scheduleUpdate() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      update();
    });
  }

  function update() {
    if (!active || !box) return;
    positionMarks();
    const v = lastPoint ? findVideoAt(lastPoint.x, lastPoint.y) : null;
    if (v !== target) {
      target = v;
      if (target) renderBadge(target);
    }
    if (!target) {
      box.classList.remove('on');
      badge.classList.remove('on');
      return;
    }
    const r = target.getBoundingClientRect();
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
    box.classList.add('on');

    badge.style.left = `${Math.max(8, r.left)}px`;
    badge.style.top = `${r.top}px`;
    badge.classList.toggle('below', r.top < 44);
    badge.classList.add('on');
  }

  function renderBadge(v) {
    const info = describe(v);
    let title;
    let kindLabel;
    let good;
    if (v instanceof HTMLIFrameElement) {
      title = `${info.provider} embed`;
      kindLabel = 'via yt-dlp';
      good = true;
    } else {
      const dims = v.videoWidth && v.videoHeight ? `${v.videoWidth}×${v.videoHeight}` : 'loading…';
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? fmtDuration(v.duration) : '';
      title = dims + (dur ? ` · ${dur}` : '');
      const site = P.siteForUrl(info.frameUrl) || P.siteForUrl(info.pageUrl);
      // Carousel sites always go through yt-dlp (best rendition, per-slide names),
      // even when the player happens to use a plain file.
      if (info.kind === 'direct' && !site?.carousel) {
        kindLabel = 'direct file';
        good = true;
      } else if (site) {
        const slide = info.slide
          ? ` · slide ${info.slide.index}/${info.slide.count}`
          : info.urlIndex
            ? ` · slide ${info.urlIndex}`
            : '';
        kindLabel = `${site.name}${slide} · via yt-dlp`;
        good = true;
      } else {
        const streamed = { hls: 'HLS', dash: 'DASH', blob: 'MediaSource', none: 'no source yet' }[info.kind];
        kindLabel = /^https?:/i.test(info.pageUrl) ? `${streamed} · try yt-dlp` : streamed;
        good = false;
      }
    }
    badge.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const b = document.createElement('b');
    b.textContent = title;
    const k = document.createElement('span');
    k.className = 'kind' + (good ? '' : ' warn');
    k.textContent = kindLabel;
    badge.append(dot, b, k);
  }

  function fmtDuration(s) {
    s = Math.round(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------------------
  // Describe a video's sources
  // ---------------------------------------------------------------------------

  function describe(v) {
    const pageUrl = isTop ? location.href : document.referrer || location.href;
    const pageTitle = document.title || '';

    if (v instanceof HTMLIFrameElement) {
      const src = absolute(v.getAttribute('src') || v.src);
      return {
        kind: 'embed',
        provider: embedProvider(v)?.name || 'player',
        src,
        sources: [],
        poster: '',
        width: 0,
        height: 0,
        duration: 0,
        pageUrl,
        pageTitle,
        frameUrl: src,
      };
    }

    const sources = Array.from(v.querySelectorAll('source'))
      .map((s) => ({ src: absolute(s.getAttribute('src')), type: s.getAttribute('type') || '' }))
      .filter((s) => s.src);
    let src = v.currentSrc || absolute(v.getAttribute('src')) || '';
    // If the element is bound to a MediaSource but has a plain <source> child, prefer the file.
    if ((!src || src.startsWith('blob:')) && sources.length) {
      const direct = sources.find((s) => /^https?:/i.test(s.src) && !isManifest(s.src));
      if (direct) src = direct.src;
    }
    const { permalink } = findPost(v);
    return {
      src,
      sources,
      poster: absolute(v.getAttribute('poster')) || '',
      width: v.videoWidth || 0,
      height: v.videoHeight || 0,
      duration: Number.isFinite(v.duration) ? v.duration : 0,
      pageUrl,
      pageTitle,
      frameUrl: location.href,
      permalink,
      ...findSlide(v, permalink),
      kind: classify(src),
    };
  }

  // ---------------------------------------------------------------------------
  // Carousel slide detection
  // ---------------------------------------------------------------------------

  /**
   * Which slide of a carousel post is showing. Returns { slide, urlIndex }:
   *   slide     { index, count } read from the carousel's position dots
   *   urlIndex  ?img_index=N, when the page URL is this post
   * The helper cross-checks both against the post's real slide count.
   */
  function findSlide(v, permalink) {
    const site = P.siteForUrl(location.href);
    if (!site?.carousel) return {};
    const out = {};
    const dots = readCarouselDots(v);
    if (dots) out.slide = dots;
    try {
      const n = parseInt(new URL(location.href).searchParams.get('img_index'), 10);
      if (n > 0 && permalink && P.permalinkFromUrl(site, location.href) === permalink) out.urlIndex = n;
    } catch {
      /* ignore */
    }
    return out;
  }

  /**
   * Carousels show a row of small dots, one per slide, with the current one
   * styled differently. Find that row near the video without relying on class
   * names: a parent whose children are all small, equal-sized squares or
   * circles, sitting over or just below the video. The odd one out is active.
   */
  function readCarouselDots(v) {
    const vr = v.getBoundingClientRect();
    if (vr.width < 40 || vr.height < 40) return null;
    const scope = v.closest('article') || v.closest('[role="dialog"]') || v.closest('main') || document.body;

    const byParent = new Map();
    for (const el of scope.querySelectorAll('div, span, li, button')) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.width > 12 || r.height > 12) continue;
      if (Math.abs(r.width - r.height) > 2) continue;
      const parent = el.parentElement;
      if (!parent) continue;
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(el);
    }

    let best = null;
    let bestDist = Infinity;
    for (const [parent, dots] of byParent) {
      if (dots.length < 2 || dots.length > 20 || parent.children.length !== dots.length) continue;
      const pr = parent.getBoundingClientRect();
      const cx = pr.left + pr.width / 2;
      // Horizontally within the video, vertically over its lower part or just below it.
      if (cx < vr.left || cx > vr.right) continue;
      if (pr.top < vr.top + vr.height * 0.5 || pr.top > vr.bottom + 80) continue;
      const dist = Math.abs(pr.top - vr.bottom);
      if (dist < bestDist) {
        best = dots;
        bestDist = dist;
      }
    }
    if (!best) return null;

    const index = activeDot(best);
    return index === -1 ? null : { index: index + 1, count: best.length };
  }

  function activeDot(dots) {
    const feats = dots.map((d) => {
      const cs = getComputedStyle(d);
      return {
        sig: [d.className, cs.opacity, cs.backgroundColor, Math.round(d.getBoundingClientRect().width)].join('|'),
        opacity: parseFloat(cs.opacity) || 0,
        sat: saturation(cs.backgroundColor),
      };
    });
    // Three or more dots: exactly one looks different from all the others.
    if (dots.length >= 3) {
      const counts = new Map();
      for (const f of feats) counts.set(f.sig, (counts.get(f.sig) || 0) + 1);
      const odd = feats.findIndex((f) => counts.get(f.sig) === 1);
      if (counts.size === 2 && odd !== -1) return odd;
    }
    // Two dots (or no clean odd one out): the more opaque, then the more colourful one.
    for (const key of ['opacity', 'sat']) {
      const max = Math.max(...feats.map((f) => f[key]));
      const top = feats.filter((f) => f[key] === max);
      if (top.length === 1 && feats.some((f) => f[key] < max)) return feats.indexOf(top[0]);
    }
    return -1;
  }

  function saturation(color) {
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(color || '');
    if (!m) return 0;
    const [r, g, b] = m.slice(1, 4).map(Number);
    const max = Math.max(r, g, b);
    return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
  }

  function classify(src) {
    if (!src) return 'none';
    if (src.startsWith('blob:')) return 'blob';
    if (/\.m3u8(\?|#|$)/i.test(src)) return 'hls';
    if (/\.mpd(\?|#|$)/i.test(src)) return 'dash';
    if (/^https?:/i.test(src)) return 'direct';
    return 'none';
  }

  function isManifest(u) {
    return /\.(m3u8|mpd)(\?|#|$)/i.test(u);
  }

  function absolute(u) {
    if (!u) return '';
    try {
      return new URL(u, location.href).href;
    } catch {
      return '';
    }
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  function onMove(e) {
    lastPoint = { x: e.clientX, y: e.clientY };
    scheduleUpdate();
  }

  function onLeave() {
    lastPoint = null;
    scheduleUpdate();
  }

  function onBlocked(e) {
    // Swallow everything so the page's own player doesn't play/pause/seek.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type !== 'click') return;
    if (e.button !== 0) return;
    lastPoint = { x: e.clientX, y: e.clientY };
    const v = findVideoAt(e.clientX, e.clientY);

    if (v && e.shiftKey) {
      // Shift+click: toggle this video in the queue and keep picking.
      toggleQueue(v, { whole: e.altKey });
      return;
    }
    if (v) {
      // Plain click on a video: download it (after anything already queued).
      // ⌥+click on a carousel post: every slide of the post.
      select(v, { whole: e.altKey });
      return;
    }
    // Click away: run the queue if there is one, otherwise cancel.
    if (hasQueue()) runQueue();
    else cancel();
  }

  // Local marks count immediately; the cross-frame total arrives by broadcast.
  function hasQueue() {
    return queued.size > 0 || queueIds.length > 0;
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel();
    } else if (e.key === 'Enter' && hasQueue()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      runQueue();
    }
  }

  function onViewportChange() {
    scheduleUpdate();
  }

  function bind() {
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('pointermove', onMove, true);
    // Non-capturing on <html>: fires only when the cursor leaves the document,
    // not when it enters a child such as an iframe.
    document.documentElement.addEventListener('mouseleave', onLeave);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange, true);
    for (const t of BLOCKED_EVENTS) window.addEventListener(t, onBlocked, true);
  }

  function unbind() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('pointermove', onMove, true);
    document.documentElement.removeEventListener('mouseleave', onLeave);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onViewportChange, true);
    window.removeEventListener('resize', onViewportChange, true);
    for (const t of BLOCKED_EVENTS) window.removeEventListener(t, onBlocked, true);
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  function activate() {
    if (active) return;
    active = true;
    target = null;
    lastPoint = null;
    mountUI();
    bind();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    unbind();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
    target = null;
    queued.clear();
    queueIds = [];
    unmountUI();
  }

  function toggle() {
    // Toolbar click while active = cancel (clears any queue in every frame).
    if (active) cancel();
    else activate();
  }

  function cancel() {
    // Ask the background to deactivate every frame, so a cancel in an iframe
    // also clears the HUD in the top frame. Deactivate locally right away.
    deactivate();
    chrome.runtime.sendMessage({ type: 'motion:cancel' }).catch(() => {});
  }

  // What the background gets for a picked video: its sources and the page context.
  function picked(v, whole) {
    const info = describe(v);
    return { ...info, whole, ...captureFor(v, info.permalink) };
  }

  function select(v, { whole = false } = {}) {
    const payload = picked(v, whole);
    const id = queued.get(v)?.id || newId();
    deactivate();
    send({ type: 'motion:select', id, payload });
  }

  function send(msg) {
    return chrome.runtime.sendMessage(msg).catch((err) => {
      if (isTop) showToast({ ok: false, message: `motion.isthishenry error: ${err?.message ?? err}` });
    });
  }

  function newId() {
    return Math.random().toString(36).slice(2, 10);
  }

  // ---------------------------------------------------------------------------
  // Shift-click queue
  // ---------------------------------------------------------------------------

  function toggleQueue(v, opts) {
    if (queued.has(v)) removeFromQueue(v);
    else addToQueue(v, opts);
  }

  function addToQueue(v, { whole = false } = {}) {
    const id = newId();
    const mark = document.createElement('div');
    mark.className = 'vp-mark';
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = '…';
    mark.append(num);
    marksLayer?.append(mark);
    queued.set(v, { id, mark });
    positionMarks();
    // Snapshot the payload now: on feed pages the post may scroll away or
    // change source before the queue runs.
    send({ type: 'motion:queue-add', id, payload: picked(v, whole) });
  }

  function removeFromQueue(v) {
    const entry = queued.get(v);
    if (!entry) return;
    entry.mark.remove();
    queued.delete(v);
    send({ type: 'motion:queue-remove', id: entry.id });
  }

  function runQueue() {
    deactivate();
    send({ type: 'motion:queue-run' });
  }

  // Background broadcast: the ordered ids across all frames. Renumber our marks
  // and refresh the HUD count. Never remove marks here: a broadcast can be
  // stale (two quick shift-clicks) and removal is always local anyway.
  function onQueueState(ids) {
    queueIds = Array.isArray(ids) ? ids : [];
    for (const entry of queued.values()) {
      const idx = queueIds.indexOf(entry.id);
      entry.mark.querySelector('.num').textContent = idx === -1 ? '…' : String(idx + 1);
    }
    renderHud();
  }

  function positionMarks() {
    for (const [v, entry] of queued) {
      if (!v.isConnected) {
        entry.mark.style.display = 'none';
        continue;
      }
      const r = v.getBoundingClientRect();
      entry.mark.style.display = '';
      entry.mark.style.left = `${r.left}px`;
      entry.mark.style.top = `${r.top}px`;
      entry.mark.style.width = `${r.width}px`;
      entry.mark.style.height = `${r.height}px`;
    }
  }

  function renderHud() {
    if (!hud) return;
    const n = queueIds.length;
    hud.innerHTML = '';
    const add = (cls, text) => {
      const s = document.createElement(cls === 'kbd' ? 'kbd' : 'span');
      if (cls !== 'kbd') s.className = cls;
      s.textContent = text;
      hud.append(s);
    };
    add('logo', '');
    const b = document.createElement('b');
    b.textContent = 'motion.isthishenry';
    hud.append(b);
    if (n === 0) {
      add('dim', 'click a video to grab it');
      add('kbd', '⇧ click');
      add('dim', 'queue several');
      if (P.siteForUrl(location.href)?.carousel) {
        add('kbd', '⌥ click');
        add('dim', 'whole post');
      }
      add('kbd', 'Esc');
      add('dim', 'cancel');
    } else {
      add('count', `${n} queued`);
      add('kbd', '⇧ click');
      add('dim', 'add / remove');
      add('kbd', 'Enter');
      add('dim', 'or click away to download');
      add('kbd', 'Esc');
      add('dim', 'cancel');
    }
  }

  // ---------------------------------------------------------------------------
  // Toast (top frame only). Survives picker teardown so the result is visible.
  // ---------------------------------------------------------------------------

  // `sticky` toasts (download progress) stay until the next non-sticky toast replaces them.
  function showToast({ ok, message, sticky }) {
    if (!isTop) return;
    let el = document.getElementById('motion-toast-host');
    if (!el) {
      el = document.createElement('motion-toast');
      el.id = 'motion-toast-host';
      el.style.cssText = 'all:initial;position:fixed;inset:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
      const sh = el.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = CSS;
      const root = document.createElement('div');
      root.className = 'vp-root';
      const t = document.createElement('div');
      t.className = 'vp-toast';
      root.append(t);
      sh.append(style, root);
      (document.documentElement || document.body).appendChild(el);
      el.__toast = t;
    }
    const t = el.__toast;
    t.textContent = message;
    t.className = `vp-toast on ${ok ? 'ok' : 'err'}`;
    clearTimeout(toastTimer);
    if (sticky) {
      toastTimer = 0;
      return;
    }
    toastTimer = setTimeout(() => {
      t.classList.remove('on');
      toastTimer = setTimeout(() => {
        el.remove();
        toastTimer = 0;
      }, 200);
    }, ok ? 3200 : 6000);
  }

  // ---------------------------------------------------------------------------
  // Messages from the background
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'motion:deactivate') deactivate();
    else if (msg.type === 'motion:toast') showToast(msg);
    else if (msg.type === 'motion:queue' && active) onQueueState(msg.ids);
    // A video picked in a child frame: the page you're on is this one.
    else if (msg.type === 'motion:page' && isTop) {
      let page = null;
      try {
        page = C?.page() ?? null;
      } catch (err) {
        console.warn('[motion] could not read the page context:', err);
      }
      sendResponse({ page });
    }
  });

  window[NS] = { toggle, activate, deactivate };
  activate();
})();
