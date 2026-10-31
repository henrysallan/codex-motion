// motion.isthishenry — page context for a picked video
//
// What the page says about the video you clicked, read from the live DOM in
// the same shapes the site scraper keeps (scripts/scrape/types.ts):
//   page     PageMeta: title, description, og/twitter/meta tags, JSON-LD,
//            visible text
//   context  VideoContext: the card around the video (heading, section,
//            caption, nearby text, the link it points at), plus the post's
//            text on feed sites
// The background worker puts these in the capture record that travels with
// the download, and the helper writes that into the file. The app reads it
// back on drop and enriches the clip from it (api/enrich.ts).
//
// Loaded as a classic script before picker.js; defines globalThis.MotionCapture.

(function (root) {
  'use strict';

  const HEADINGS = 'h1,h2,h3,h4,h5,h6';
  // Sizes kept small: the record rides inside the video file and in one
  // request to /api/enrich.
  const PAGE_TEXT = 8000;
  const POST_TEXT = 4000;
  const JSON_LD = 16000;
  // Tags that change on every visit (signed CDN images, tokens) or say
  // nothing about the work.
  const SKIP_META = /^(viewport|theme-color|format-detection|msapplication|apple-|google-site|robots|googlebot|referrer|color-scheme|csrf|_token|fb:|al:)/;
  const IMAGE_META = /^(image|video|audio)(:|$)/;
  const TIMECODES = /\b\d{1,2}(?::\d{2}){1,2}\b(?:\s*\/\s*\d{1,2}(?::\d{2}){1,2}\b)?/g;

  function clean(s, max = 400) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  // A display title: trimmed, without a dangling separator ("Wabi —").
  function title(s) {
    return clean(s, 200).replace(/[\s—–\-|·:,/]+$/u, '');
  }

  // Rendered text: innerText skips hidden elements and breaks between
  // blocks, so "<h3>Title</h3><p>Client</p>" reads "Title Client".
  function textOf(el, max) {
    return clean(el?.innerText ?? el?.textContent ?? '', max);
  }

  // Click ids and campaign tags: they differ per visit and say nothing.
  const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_[ce]id|igsh|igshid|si|ref_src|_ga|_gl)$/i;

  // A link worth keeping: absolute http(s), no fragment or tracking.
  function pageLink(href) {
    try {
      const u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol)) return '';
      u.hash = '';
      for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
      return u.href;
    } catch {
      return '';
    }
  }

  // A player's title is often the uploaded file's name ("Amazon_CS_04_System").
  function looksLikeFilename(t) {
    const s = t.trim();
    return (
      /_.*_|^_|\.(mp4|mov|webm|m4v|gif)$|\bv\d+\b|\bfinal\b|\d{3,4}p\b|\d{3,4}x\d{3,4}/i.test(s) ||
      (s.match(/\p{L}/gu) ?? []).length < 3 ||
      /^(untitled|video|vimeo video player|youtube video player)$/i.test(s)
    );
  }

  /**
   * The page's own metadata, as scripts/scrape/extract.ts reads it from
   * HTML. `withText` is false on feed pages, whose text is every post.
   */
  function page({ withText = true } = {}) {
    const og = {};
    const twitter = {};
    const meta = {};
    for (const el of document.querySelectorAll('meta')) {
      const k = (el.getAttribute('property') ?? el.getAttribute('name') ?? el.getAttribute('itemprop') ?? '').trim().toLowerCase();
      const v = el.getAttribute('content');
      if (!k || v == null || !v.trim()) continue;
      if (k.startsWith('og:')) {
        if (!IMAGE_META.test(k.slice(3))) og[k.slice(3)] ??= clean(v, 2000);
      } else if (k.startsWith('twitter:')) {
        if (!IMAGE_META.test(k.slice(8)) && k !== 'twitter:player') twitter[k.slice(8)] ??= clean(v, 2000);
      } else if (!SKIP_META.test(k)) meta[k] ??= clean(v, 1000);
    }
    const jsonLd = [];
    let ldSize = 0;
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(el.textContent);
        for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
          const size = JSON.stringify(item).length;
          if (ldSize + size > JSON_LD) continue;
          ldSize += size;
          jsonLd.push(item);
        }
      } catch {
        // Malformed JSON-LD is common; skip it.
      }
    }
    const canonical = document.querySelector('link[rel="canonical"]')?.href;
    const h1 = textOf(document.querySelector('h1'), 300);
    const out = {
      url: location.href,
      title: clean(document.title, 300) || undefined,
      description: meta.description ?? og.description,
      canonical: canonical ? pageLink(canonical) || undefined : undefined,
      lang: document.documentElement.lang || undefined,
      h1: h1 || undefined,
      og,
      twitter,
      meta,
      jsonLd,
      text: withText && document.body ? textOf(document.body, PAGE_TEXT) : '',
    };
    return out;
  }

  /**
   * What surrounds the video: the smallest ancestor with any text (usually
   * the project card: title, client, year), its heading, a figure caption,
   * the heading of the section it sits in, and the link the card points at.
   * Mirrors contextOf() in scripts/scrape/extract.ts. `post` is the feed
   * post the picker found the permalink in, when there is one.
   */
  function context(el, post) {
    const ctx = {};
    // An element's own label; a player iframe's title is often the upload's file name.
    const label = clean(el.getAttribute('title') ?? el.getAttribute('aria-label') ?? el.getAttribute('alt'), 200);
    const own = label && !looksLikeFilename(label) ? label : '';
    let node = el;
    let box = null;
    for (let depth = 0; depth < 8; depth++) {
      const parent = node.parentElement;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      const raw = textOf(parent, 4000);
      if (raw.length > 1500) break;
      node = parent;
      // A player's timecodes ("0:01 / 0:04") aren't text about the video.
      const t = clean(raw.replace(TIMECODES, ' '), 4000);
      // Any text at all: a card may hold only its title.
      if (t.replace(/\W/g, '').length >= 3) {
        box = parent;
        // Player chrome ("unmute unmute unmute") isn't context.
        const words = t.toLowerCase().split(/\s+/);
        if (new Set(words).size > 2 || words.length <= 3) ctx.text = clean(t);
        break;
      }
    }
    const fig = el.closest('figure')?.querySelector('figcaption');
    if (fig) ctx.caption = title(textOf(fig)) || undefined;
    // The video's own name lives inside its card: a heading, a title-ish
    // element, or a caption. A heading above the card names the section.
    if (box) {
      const named = box.querySelector(HEADINGS) ?? box.querySelector('[class*="title" i],[class*="name" i],[class*="caption" i]');
      if (named) ctx.heading = title(textOf(named)) || undefined;
    }
    ctx.heading ??= ctx.caption ?? (own || undefined);
    const section = precedingHeading(el);
    if (section && section !== ctx.heading) ctx.section = section;
    const a = el.closest('a[href]') ?? box?.querySelector('a[href]');
    const href = a ? pageLink(a.getAttribute('href')) : '';
    if (href) {
      const text = textOf(a, 200);
      ctx.link = { href, ...(text ? { text } : {}) };
    }
    if (post) {
      const t = textOf(post, POST_TEXT);
      if (t) ctx.post = t;
    }
    for (const k of Object.keys(ctx)) if (ctx[k] === undefined) delete ctx[k];
    return ctx;
  }

  function precedingHeading(el) {
    let node = el;
    for (let depth = 0; depth < 10 && node && node !== document.body; depth++) {
      let sib = node.previousElementSibling;
      for (let steps = 0; sib && steps < 30; steps++) {
        const h = sib.matches(HEADINGS) ? sib : [...sib.querySelectorAll(HEADINGS)].pop();
        if (h) {
          const t = textOf(h, 200);
          if (t) return t;
        }
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return undefined;
  }

  root.MotionCapture = { page, context, clean, looksLikeFilename };
})(globalThis);
