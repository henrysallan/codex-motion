// Shapes shared across the site scraper.
//
// A run crawls one site. Extractors turn each page into candidates
// (references to a video, as the page gave them); candidates that point at
// the same video merge into one item, which is downloaded and written out
// with everything we learned about it.

// How a candidate was found: from the HTML as served, from the page after
// a scripted headless-Chrome visit, or by the Claude agent.
export type Tier = 'static' | 'render' | 'agent';

// A media file, an HLS/DASH stream, or a player page (Vimeo, YouTube, ...).
export type MediaKind = 'file' | 'stream' | 'embed';

export interface ElementInfo {
  tag: string;
  // autoplay/loop/muted/controls, poster, size, title, aria-label, class,
  // data-*: what the site's own markup says about the video.
  attrs: Record<string, string>;
  sources?: { url: string; type?: string; media?: string }[];
}

export interface VideoContext {
  // The video's own title, from inside its card.
  heading?: string;
  // The heading of the section it sits in ("Selected work").
  section?: string;
  caption?: string;
  // Text of the smallest container around the video that has any.
  text?: string;
  link?: { href: string; text?: string };
  // Order among the videos found on the page.
  index: number;
}

export interface Candidate {
  url: string;
  kind: MediaKind;
  key: string;
  provider?: string;
  pageUrl: string;
  tier: Tier;
  // Which extractor: video-tag, data-attr, iframe, og:video, json-ld, inline-json, link, network, agent.
  via: string;
  element?: ElementInfo;
  poster?: string;
  context?: VideoContext;
  // Other renditions of the same video, e.g. responsive <source> elements.
  variants?: string[];
  // Extractor-specific facts: og:video size, a JSON-LD VideoObject, the
  // sibling fields of a URL inside inline JSON, notes from the agent.
  meta?: Record<string, unknown>;
}

export interface PageMeta {
  url: string;
  status: number;
  title?: string;
  description?: string;
  canonical?: string;
  lang?: string;
  h1?: string;
  generator?: string;
  og: Record<string, string>;
  twitter: Record<string, string>;
  // Other <meta name|property>: author, keywords, article:published_time, ...
  meta: Record<string, string>;
  jsonLd: unknown[];
  // Visible text, trimmed; feeds enrichment.
  text: string;
}

export interface PageSignals {
  videoTags: number;
  // <video> elements whose source we could not see in the markup.
  unresolvedVideos: number;
  // Elements whose class or id names a player.
  playerHints: number;
  // A "Load more" / "Show more" control that isn't a plain link.
  moreButton: boolean;
  textLength: number;
  scripts: number;
  // Looks like a client-rendered shell: little text, lots of script.
  shell: boolean;
}

export interface PageRecord {
  url: string;
  status: number;
  tier: Tier;
  rendered: boolean;
  meta?: PageMeta;
  signals?: PageSignals;
  candidates: number;
  error?: string;
  // Served a bot challenge; we do not try to get past those.
  blocked?: boolean;
}

export interface ProjectInfo {
  title?: string | null;
  client?: string | null;
  agency?: string | null;
  year?: string | null;
  description?: string | null;
  disciplines?: string[];
  credits?: { role: string; name: string }[];
  tags?: string[];
  source: 'agent' | 'enrich';
}

export interface Appearance {
  pageUrl: string;
  url: string;
  tier: Tier;
  via: string;
  element?: ElementInfo;
  poster?: string;
  context?: VideoContext;
  meta?: Record<string, unknown>;
}

export interface PageSummary {
  url: string;
  title?: string;
  description?: string;
  canonical?: string;
  image?: string;
  siteName?: string;
  author?: string;
  published?: string;
  modified?: string;
  keywords?: string;
  lang?: string;
  h1?: string;
  jsonLd?: unknown[];
}

export interface ScrapedItem {
  key: string;
  status: 'found' | 'downloaded' | 'skipped' | 'failed';
  // The cheapest tier that found it.
  foundBy: Tier;
  reason?: string;
  // First 16 hex digits of the file's SHA-256, the library's asset id.
  id?: string;
  file?: string;
  // Best guess at the video's name, and where it came from.
  title: string;
  titleSource: 'project' | 'context' | 'embed' | 'page' | 'url';
  media: {
    // Every URL this video was seen at, best first.
    urls: string[];
    kind: MediaKind;
    provider?: string;
    // The URL the file actually came from.
    downloadedFrom?: string;
    contentType?: string;
    bytes?: number;
    lastModified?: string;
    etag?: string;
    width?: number;
    height?: number;
    duration?: number;
    fps?: number;
    codec?: string;
    audio?: boolean;
  };
  page: PageSummary;
  appearances: Appearance[];
  // yt-dlp's metadata for player-hosted videos, minus the format tables.
  embed?: Record<string, unknown>;
  project?: ProjectInfo;
  site: { url: string; host: string; name?: string };
  firstSeenAt: string;
  scrapedAt: string;
}
