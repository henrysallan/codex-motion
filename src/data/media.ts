// Rendition URLs are stored as storage keys ("media/<hash>/l1.mp4"). This
// turns one into something fetchable: the media Worker in production, the
// dev server's public/media locally. blob:, opfs: and absolute URLs pass
// through.

import { config } from '../config.ts';

export function mediaUrl(keyOrUrl: string): string {
  if (!keyOrUrl) return '';
  if (/^(https?:|blob:|opfs:)/.test(keyOrUrl)) return keyOrUrl;
  if (keyOrUrl.startsWith('media/') && config.mediaUrl) return `${config.mediaUrl}/${keyOrUrl}`;
  return new URL(keyOrUrl, document.baseURI).href;
}

export const mediaKey = (assetId: string, file: string) => `media/${assetId}/${file}`;
