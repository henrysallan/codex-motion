// Byte loading for the render worker.
//
//   opfs:<path>        a file in the origin private file system
//   blob:…             a dropped file still being ingested
//   …/media/<hash>/…   content-addressed media: read from OPFS if this
//                      device has it (ingested here, or fetched before),
//                      else fetched. Keys never change content, so a local
//                      copy never goes stale.
//
// Sprites and small videos are read whole, and fetched ones are kept in
// OPFS. Larger videos are read in ranges (openRanged): a decoder needs the
// few seconds around its playhead, not the whole file. Fetched ranges
// aren't copied into OPFS; media responses are immutable, so the HTTP cache
// keeps them.

let root: Promise<FileSystemDirectoryHandle> | null = null;
const opfs = () => (root ??= navigator.storage.getDirectory());

async function resolve(path: string, create: boolean): Promise<FileSystemFileHandle> {
  const parts = path.split('/').filter(Boolean);
  let dir = await opfs();
  for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name, { create });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

async function opfsFile(path: string): Promise<File> {
  const file = await (await resolve(path, false)).getFile();
  // A write in progress shows as an empty file until it commits.
  if (file.size === 0) throw new Error(`${path}: empty`);
  return file;
}

async function readOpfs(path: string): Promise<ArrayBuffer> {
  return (await opfsFile(path)).arrayBuffer();
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

// Fetches a whole file, keeping a copy in OPFS if it is content-addressed.
async function fetchAndKeep(url: string, key: string | null): Promise<ArrayBuffer> {
  const bytes = await fetchBytes(url);
  // Best effort: a full disk or a private window just skips the cache.
  if (key) writeOpfs(key, bytes.slice(0)).catch(() => {});
  return bytes;
}

// The content-addressed key of a media URL, or null for other URLs.
function mediaKey(url: string): string | null {
  const m = new URL(url).pathname.match(/^\/(media\/[0-9a-f]{16}\/[\w.]+)$/);
  return m ? m[1] : null;
}

// Where this device may have a copy of a media key: ingested here, or
// fetched before.
const localPaths = (key: string) => [key, `cache/${key}`];

export async function loadBytes(url: string): Promise<ArrayBuffer> {
  if (url.startsWith('opfs:')) return readOpfs(url.slice(5));
  if (url.startsWith('blob:')) return fetchBytes(url);
  const key = mediaKey(url);
  if (!key) return fetchBytes(url);
  for (const path of localPaths(key)) {
    try {
      return await readOpfs(path);
    } catch {
      // Not here (or being written); try the next place.
    }
  }
  return fetchAndKeep(url, key);
}

// Random access to a file's bytes. `head` is its first bytes (the whole
// file when it is no longer than the head that was asked for).
export interface RangedFile {
  size: number;
  head: Uint8Array;
  read(start: number, end: number): Promise<Uint8Array>;
}

const readBlob = async (blob: Blob, start: number, end: number) => new Uint8Array(await blob.slice(start, end).arrayBuffer());

async function fromBlob(blob: Blob, headBytes: number): Promise<RangedFile> {
  return { size: blob.size, head: await readBlob(blob, 0, headBytes), read: (start, end) => readBlob(blob, start, end) };
}

// An OPFS file for ranged reads. A File is a snapshot, and reading one
// throws once the file has been written again (a copy being kept, another
// tab), so a failed read takes a fresh snapshot and tries once more.
async function fromOpfs(path: string, headBytes: number): Promise<RangedFile> {
  let file = await opfsFile(path);
  const read = async (start: number, end: number) => {
    try {
      return await readBlob(file, start, end);
    } catch {
      file = await opfsFile(path);
      return readBlob(file, start, end);
    }
  };
  return { size: file.size, head: await read(0, headBytes), read };
}

// Opens a file for ranged reads, reading its first `headBytes` bytes up
// front. With headBytes Infinity it reads the whole file in one plain
// request, which caches better than a range (see demux.ts WHOLE_BYTES).
export async function openRanged(url: string, headBytes: number): Promise<RangedFile> {
  if (url.startsWith('opfs:')) return fromOpfs(url.slice(5), headBytes);
  if (url.startsWith('blob:')) return fromBlob(await (await fetch(url)).blob(), headBytes);
  const key = mediaKey(url);
  for (const path of key ? localPaths(key) : []) {
    try {
      return await fromOpfs(path, headBytes);
    } catch {
      // Not here (or being written); try the next place.
    }
  }
  if (headBytes === Infinity) {
    const bytes = new Uint8Array(await fetchAndKeep(url, key));
    return { size: bytes.length, head: bytes, read: async (start, end) => bytes.subarray(start, end) };
  }

  const range = async (start: number, end: number) => {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const total = res.status === 206 ? Number(res.headers.get('Content-Range')?.split('/')[1]) : NaN;
    return { status: res.status, total, bytes: new Uint8Array(await res.arrayBuffer()) };
  };
  const first = await range(0, headBytes);
  if (first.status !== 206) {
    // The server sent the whole file.
    return { size: first.bytes.length, head: first.bytes, read: async (start, end) => first.bytes.subarray(start, end) };
  }
  if (!Number.isFinite(first.total)) throw new Error(`${url}: no Content-Range`);
  return {
    size: first.total,
    head: first.bytes,
    read: async (start, end) => {
      const r = await range(start, end);
      return r.status === 206 ? r.bytes : r.bytes.subarray(start, end);
    },
  };
}
