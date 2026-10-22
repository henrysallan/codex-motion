// Byte loading for the render worker.
//
//   opfs:<path>   a file in the origin private file system (ingested media)
//   blob:…        a dropped file still being ingested
//   /media/…      server media, cached through to OPFS under cache/ so a
//                 board reopens from local disk; files are content-addressed
//                 and never change, so a cached copy never goes stale

const CACHE_DIR = 'cache';

let root: Promise<FileSystemDirectoryHandle> | null = null;
const opfs = () => (root ??= navigator.storage.getDirectory());

async function resolve(path: string, create: boolean): Promise<FileSystemFileHandle> {
  const parts = path.split('/').filter(Boolean);
  let dir = await opfs();
  for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

async function readOpfs(path: string): Promise<ArrayBuffer> {
  const file = await (await resolve(path, false)).getFile();
  return file.arrayBuffer();
}

async function writeOpfs(path: string, bytes: ArrayBuffer): Promise<void> {
  const writable = await (await resolve(path, true)).createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

export async function loadBytes(url: string): Promise<ArrayBuffer> {
  if (url.startsWith('opfs:')) return readOpfs(url.slice(5));
  if (url.startsWith('blob:')) return fetchBytes(url);
  const { pathname, origin } = new URL(url);
  if (origin !== location.origin || !pathname.startsWith('/media/')) return fetchBytes(url);
  const cached = CACHE_DIR + pathname;
  try {
    return await readOpfs(cached);
  } catch {
    const bytes = await fetchBytes(url);
    // Best effort: a full disk or a private window just skips the cache.
    writeOpfs(cached, bytes.slice(0)).catch(() => {});
    return bytes;
  }
}
