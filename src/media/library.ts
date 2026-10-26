// The media library manifest (public/media/library.json) written by the
// proxy builder and read by the app, and the asset shape the engine draws.
// One entry per content-addressed asset. URLs are relative to the app root,
// `opfs:` paths into the browser's private file system, or `blob:` URLs for a
// file still being ingested.

export interface VideoRendition {
  url: string;
  width: number;
  height: number;
  bytes: number;
}

export interface SpriteRendition {
  url: string;
  format: 'bc1';
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  bytes: number;
}

export interface Asset {
  // First 16 hex digits of the source file's SHA-256.
  id: string;
  name: string;
  // Seconds.
  duration: number;
  width: number;
  height: number;
  fps: number;
  // Null while an upload's sprite is still being built.
  l0: SpriteRendition | null;
  l1: VideoRendition;
  // Absent when the source is barely taller than L1.
  l2: VideoRendition | null;
  // The source file, for focus mode, when this device has it.
  original?: VideoRendition | null;
  // Where a scraped asset came from. The full record (page metadata,
  // context, player attributes, embed info) is <id>/source.json.
  source?: AssetSource;
  // What a vision model saw in it (scripts/tag.ts).
  analysis?: AssetAnalysis;
}

export interface AssetAnalysis {
  // One sentence: what is shown and how it moves.
  caption: string;
  // "group:slug" from the motion vocabulary (src/media/vocabulary.ts), plus
  // free "visual:<tag>" tags for subjects, materials, colour and style.
  tags: string[];
  model: string;
  at: string;
}

// Visual embeddings (scripts/embed.ts): <id>/embedding.f32 holds one
// L2-normalized vector per sampled frame, then their normalized mean.
// embeddings.json + embeddings.f32 pack the means of every asset for search.
export interface EmbeddingIndex {
  model: string;
  dims: number;
  ids: string[];
  // Path of the packed Float32 means, in `ids` order.
  file: string;
}

export interface AssetSource {
  // Host of the site it was scraped from.
  site: string;
  siteName?: string;
  pageUrl: string;
  pageTitle?: string;
  // Where the file itself came from.
  mediaUrl?: string;
  provider?: string;
  title: string;
  description?: string;
  client?: string;
  agency?: string;
  year?: string;
  credits?: { role: string; name: string }[];
  tags?: string[];
  // Who made it, for clips from a social platform: their name, handle,
  // profile page and the links in their bio.
  creator?: Creator;
  // When the page or post went up (ISO date).
  published?: string;
  scrapedAt: string;
}

export interface Creator {
  name?: string;
  handle?: string;
  url?: string;
  links?: { title?: string; url: string }[];
}

export interface Library {
  version: 1;
  assets: Asset[];
}
