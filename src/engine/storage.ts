// Byte loading for the render worker.
//
//   opfs:<path>        a file in the origin private file system
//   blob:…             a dropped file still being ingested
//   …/media/<hash>/…   content-addressed media: read from OPFS if this
//                      device has it (ingested here, or fetched before),
//                      else fetched and kept there. Keys never change
//                      content, so a local copy never goes stale.

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
  // A write in progress shows as an empty file until it commits.
  if (file.size === 0) throw new Error(`${path}: empty`);
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
  const { pathname } = new URL(url);
  const m = pathname.match(/^\/(media\/[0-9a-f]{16}\/[\w.]+)$/);
  if (!m) return fetchBytes(url);
  const key = m[1];
  for (const path of [key, `cache/${key}`]) {
    try {
      return await readOpfs(path);
    } catch {
      // Not here; try the next place.
    }
  }
  const bytes = await fetchBytes(url);
  // Best effort: a full disk or a private window just skips the cache.
  writeOpfs(key, bytes.slice(0)).catch(() => {});
  return bytes;
}
