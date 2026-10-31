// motion.isthishenry — site knowledge shared by the picker (content script), the
// background worker (imported as a module) and Node unit tests.
//
// Loaded as a classic script, it defines globalThis.MotionProviders.

(function (root) {
  'use strict';

  /**
   * name       label shown in the badge / toasts
   * hosts      matched against the hostname (exact or as a parent domain)
   * embed      cross-origin iframes from this site are pickable as an embed
   * permalink  path patterns identifying a single post; used to build the URL
   *            handed to yt-dlp from a feed page (Instagram home, X timeline…)
   * normalize  canonicalises a matched path
   * cookies    whether yt-dlp should read Chrome's cookies for this site
   *            (Instagram and Vimeo are login-walled; YouTube is left cookie-less
   *            because yt-dlp with account cookies can get the account flagged)
   * carousel   posts can hold several slides: the picker reads which slide is
   *            showing, and the helper saves just that one (or the whole post
   *            on ⌥-click) with per-slide filenames
   */
  const SITES = [
    {
      name: 'Vimeo',
      hosts: ['vimeo.com'],
      embed: true,
      cookies: true,
    },
    {
      name: 'Instagram',
      hosts: ['instagram.com'],
      permalink: [/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?/],
      normalize: (path) => path.replace(/^\/reels\//, '/reel/').replace(/\/?$/, '/'),
      cookies: true,
      carousel: true,
    },
    {
      name: 'YouTube',
      hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
      cookies: false,
    },
    {
      name: 'X',
      hosts: ['x.com', 'twitter.com'],
      permalink: [/^\/[^/]+\/status\/\d+/],
      cookies: true,
    },
    {
      name: 'TikTok',
      hosts: ['tiktok.com'],
      permalink: [/^\/@[^/]+\/video\/\d+/],
      cookies: true,
    },
  ];

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
  }

  function siteForHost(host) {
    if (!host) return null;
    host = host.toLowerCase();
    return SITES.find((s) => s.hosts.some((h) => host === h || host.endsWith('.' + h))) || null;
  }

  function siteForUrl(url) {
    return siteForHost(hostOf(url));
  }

  /**
   * If `url` points at a single post on `site`, return the canonical permalink
   * (origin + normalised path), else ''.
   */
  function permalinkFromUrl(site, url) {
    if (!site?.permalink) return '';
    let u;
    try {
      u = new URL(url);
    } catch {
      return '';
    }
    for (const re of site.permalink) {
      const m = re.exec(u.pathname);
      if (m) {
        const path = site.normalize ? site.normalize(m[0]) : m[0];
        return u.origin + path;
      }
    }
    return '';
  }

  root.MotionProviders = { SITES, hostOf, siteForHost, siteForUrl, permalinkFromUrl };
})(globalThis);
