import type { SpriteRendition, VideoRendition } from '../media/library.ts';

export interface ProbeResult {
  kind: 'video' | 'image';
  width: number;
  height: number;
  // Seconds; for images refined once frames are decoded.
  duration: number;
  fps: number;
}

export type ToIngest =
  | { type: 'probe'; jobId: number; file: File }
  | { type: 'build'; jobId: number; id: string }
  | { type: 'cancel'; jobId: number }
  // Rebuild from an original already in OPFS (an interrupted ingest).
  | { type: 'resume'; jobId: number; id: string; path: string; name: string; mime: string };

export type FromIngest =
  | { type: 'identified'; jobId: number; id: string; meta: ProbeResult }
  | { type: 'original'; jobId: number; url: string; bytes: number }
  | { type: 'progress'; jobId: number; progress: number }
  | { type: 'done'; jobId: number; duration: number; l0: SpriteRendition; l1: VideoRendition; l2: VideoRendition | null }
  | { type: 'error'; jobId: number; message: string };
