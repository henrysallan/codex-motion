// Uploads ingested media from OPFS to cloud storage through the media
// Worker, smallest first (L0, L1, original, L2) so other devices can show a
// clip as early as possible. Files over 90 MB go up in 50 MB parts. Keys are
// content hashes, so re-uploading is a cheap no-op and an interrupted
// upload simply runs again on the next open.

import { config, remoteEnabled } from '../config.ts';
import type { AssetRecord } from './model.ts';
import { accessToken } from './supabase.ts';

const SINGLE_MAX = 90 * 1024 * 1024;
const PART = 50 * 1024 * 1024;

async function opfsFile(key: string): Promise<File> {
  const parts = key.split('/');
  let dir = await navigator.storage.getDirectory();
  for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
  return (await dir.getFileHandle(parts[parts.length - 1])).getFile();
}

async function request(url: string, init: RequestInit, token: string): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${init.method} ${url}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

async function putFile(key: string, file: File, token: string): Promise<void> {
  const url = `${config.mediaUrl}/${key}`;
  if (file.size <= SINGLE_MAX) {
    await request(url, { method: 'PUT', body: file }, token);
    return;
  }
  const start = (await (await request(`${url}?uploads`, { method: 'POST' }, token)).json()) as { uploadId?: string; exists?: boolean };
  if (start.exists || !start.uploadId) return;
  const id = encodeURIComponent(start.uploadId);
  try {
    const parts: unknown[] = [];
    for (let n = 1, off = 0; off < file.size; n++, off += PART) {
      const res = await request(`${url}?uploadId=${id}&partNumber=${n}`, { method: 'PUT', body: file.slice(off, off + PART) }, token);
      parts.push(await res.json());
    }
    await request(`${url}?uploadId=${id}`, { method: 'POST', body: JSON.stringify({ parts }), headers: { 'Content-Type': 'application/json' } }, token);
  } catch (e) {
    await fetch(`${url}?uploadId=${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    throw e;
  }
}

const inFlight = new Set<string>();

// The renditions an upload sends, smallest first.
function uploadKeys(a: AssetRecord): { key: string; bytes: number }[] {
  return [a.l0, a.l1, a.original, a.l2].flatMap((r) => (r?.url.startsWith('media/') ? [{ key: r.url, bytes: r.bytes }] : []));
}

// What an upload stores, all renditions together: what it counts against
// the uploader's quota.
export function uploadBytes(a: AssetRecord): number {
  return uploadKeys(a).reduce((sum, r) => sum + r.bytes, 0);
}

// Uploads every rendition of an ingested asset. Resolves true once all of
// them are in cloud storage.
export async function uploadAsset(a: AssetRecord): Promise<boolean> {
  if (!remoteEnabled || !config.mediaUrl || inFlight.has(a.id)) return false;
  const token = await accessToken();
  if (!token) return false;
  inFlight.add(a.id);
  try {
    for (const { key } of uploadKeys(a)) await putFile(key, await opfsFile(key), token);
    return true;
  } catch (e) {
    console.warn(`upload of ${a.name} failed; will retry on next open:`, e);
    return false;
  } finally {
    inFlight.delete(a.id);
  }
}

// Deletes every cloud file of an upload this user deleted. Resolves true
// once they're gone.
export async function deleteFiles(id: string): Promise<boolean> {
  if (!remoteEnabled || !config.mediaUrl) return false;
  const token = await accessToken();
  if (!token) return false;
  try {
    await request(`${config.mediaUrl}/media/${id}/`, { method: 'DELETE' }, token);
    return true;
  } catch (e) {
    console.warn(`couldn't delete the files of ${id}; will retry on next open:`, e);
    return false;
  }
}
