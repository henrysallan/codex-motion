// Space in the L0 sprite atlas, kept apart from the GPU texture so it can be
// tested on its own.
//
// Each atlas layer is cut into fixed cells of one frame each. A layer's
// class is the frame height and how many frames fit across a layer
// (floor(2048 / frameWidth)); its cells are 2048 / across wide, rounded down
// to whole BC1 blocks. So a 16:9 sprite (228 px frames) lives in 8-across
// layers of 256 px cells, and a 4:5 one (104 px) in 19-across layers. A
// sprite takes frameCount cells of its class, wherever they are: freeing one
// gives back exactly what the next sprite of that class needs, and a layer
// whose cells all come free returns to the pool for any class.
//
// Room comes from, in order: free cells of the class, an unclaimed layer,
// more layers (the texture doubles, up to `softCap`), then eviction. Only
// sprites not used this frame can go; the engine stamps every sprite a board
// item or a nearby scroll item shows, every frame. The victim is whichever is
// older: the least recently used sprite of the same class, or the layer whose
// sprites were all used least recently. When everything is in use, the
// texture grows past the cap in steps, up to `hardCap`, and only then is an
// allocation refused.

export const ATLAS_SIZE = 2048;
// Layers added per step once past the soft cap.
const OVER_CAP_STEP = 32;

export interface Frame {
  layer: number;
  x: number;
  y: number;
}

export interface AtlasEntry {
  key: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  // Where each frame lives.
  frames: Frame[];
  // Allocator clock when last drawn or wanted nearby.
  usedAt: number;
}

interface CellClass {
  across: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  cells: number;
  layers: Set<Layer>;
  // Free cells across `layers`.
  free: number;
}

interface Layer {
  index: number;
  cls: CellClass | null;
  // Free cell indices, popped lowest first.
  free: number[];
  entries: Set<Record>;
}

interface Record {
  entry: AtlasEntry;
  cls: CellClass;
  cells: { layer: Layer; cell: number }[];
}

export interface CellAllocatorOptions {
  layers: number;
  softCap: number;
  hardCap: number;
  // Called before layers are added, with the old and new count.
  onGrow?: (from: number, to: number) => void;
}

export class CellAllocator {
  readonly softCap: number;
  readonly hardCap: number;
  // Bumped once per frame by the engine; sprites stamped with the current
  // value are in use and can't be evicted.
  clock = 1;
  evictions = 0;

  private readonly onGrow: (from: number, to: number) => void;
  private readonly layers: Layer[] = [];
  private readonly classes = new Map<string, CellClass>();
  private readonly records = new Map<string, Record>();

  constructor(o: CellAllocatorOptions) {
    this.softCap = Math.max(1, Math.min(o.softCap, o.hardCap));
    this.hardCap = o.hardCap;
    this.onGrow = o.onGrow ?? (() => {});
    for (let i = 0; i < o.layers; i++) this.layers.push({ index: i, cls: null, free: [], entries: new Set() });
  }

  get layerCount(): number {
    return this.layers.length;
  }

  get layersInUse(): number {
    let n = 0;
    for (const l of this.layers) if (l.cls) n++;
    return n;
  }

  get size(): number {
    return this.records.size;
  }

  // Texels covered by resident frames.
  get texelsUsed(): number {
    let n = 0;
    for (const r of this.records.values()) n += r.entry.frameCount * r.entry.frameWidth * r.entry.frameHeight;
    return n;
  }

  get(key: string): AtlasEntry | undefined {
    return this.records.get(key)?.entry;
  }

  keys(): IterableIterator<string> {
    return this.records.keys();
  }

  // Finds room for a sprite, evicting or growing as needed. Null when frames
  // can't fit a layer, or when everything resident is in use at the hard cap.
  allocate(key: string, frameWidth: number, frameHeight: number, frameCount: number): AtlasEntry | null {
    const existing = this.records.get(key);
    if (existing) return existing.entry;
    if (frameCount < 1 || frameWidth < 4 || frameHeight < 4 || frameWidth > ATLAS_SIZE || frameHeight > ATLAS_SIZE) return null;
    const cls = this.classFor(frameWidth, frameHeight);
    while (cls.free < frameCount) {
      if (this.claimLayer(cls)) continue;
      if (this.layers.length < this.softCap) {
        this.grow(Math.min(this.softCap, this.layers.length * 2));
        continue;
      }
      if (this.evictFor(cls)) continue;
      if (this.layers.length < this.hardCap) {
        this.grow(Math.min(this.hardCap, this.layers.length + OVER_CAP_STEP));
        continue;
      }
      // Give back layers claimed for this attempt.
      for (const l of cls.layers) if (l.entries.size === 0) this.unclaim(l);
      return null;
    }

    // Best fit: the fullest layer that takes the whole sprite, else fill
    // layers fullest first. Packing tight leaves other layers free to return
    // to the pool.
    const open = [...cls.layers].filter((l) => l.free.length > 0).sort((a, b) => a.free.length - b.free.length);
    const whole = open.find((l) => l.free.length >= frameCount);
    const record: Record = {
      entry: { key, frameWidth, frameHeight, frameCount, frames: [], usedAt: this.clock },
      cls,
      cells: [],
    };
    for (const layer of whole ? [whole] : open) {
      while (layer.free.length > 0 && record.cells.length < frameCount) {
        const cell = layer.free.pop()!;
        record.cells.push({ layer, cell });
        record.entry.frames.push({ layer: layer.index, x: (cell % cls.across) * cls.cellWidth, y: Math.floor(cell / cls.across) * cls.cellHeight });
      }
      layer.entries.add(record);
      if (record.cells.length === frameCount) break;
    }
    cls.free -= frameCount;
    this.records.set(key, record);
    return record.entry;
  }

  release(key: string): void {
    const r = this.records.get(key);
    if (!r) return;
    this.records.delete(key);
    for (const { layer, cell } of r.cells) {
      layer.free.push(cell);
      layer.entries.delete(r);
      r.cls.free++;
    }
    for (const { layer } of r.cells) if (layer.cls && layer.entries.size === 0) this.unclaim(layer);
  }

  private classFor(frameWidth: number, frameHeight: number): CellClass {
    const across = Math.floor(ATLAS_SIZE / frameWidth);
    const key = `${frameHeight}/${across}`;
    let cls = this.classes.get(key);
    if (!cls) {
      const rows = Math.floor(ATLAS_SIZE / frameHeight);
      cls = {
        across,
        rows,
        cellWidth: Math.floor(ATLAS_SIZE / across / 4) * 4,
        cellHeight: frameHeight,
        cells: across * rows,
        layers: new Set(),
        free: 0,
      };
      this.classes.set(key, cls);
    }
    return cls;
  }

  private claimLayer(cls: CellClass): boolean {
    const layer = this.layers.find((l) => !l.cls);
    if (!layer) return false;
    layer.cls = cls;
    // Popped from the end: cells fill in reading order.
    layer.free = Array.from({ length: cls.cells }, (_, i) => cls.cells - 1 - i);
    cls.layers.add(layer);
    cls.free += cls.cells;
    return true;
  }

  private unclaim(layer: Layer): void {
    const cls = layer.cls!;
    cls.layers.delete(layer);
    cls.free -= layer.free.length;
    layer.cls = null;
    layer.free = [];
  }

  private grow(to: number): void {
    const from = this.layers.length;
    if (to <= from) return;
    this.onGrow(from, to);
    for (let i = from; i < to; i++) this.layers.push({ index: i, cls: null, free: [], entries: new Set() });
  }

  // Frees space for `cls` by evicting whatever was used least recently:
  // its oldest idle sprite, or a whole layer of idle sprites (of any class)
  // if that layer's newest is older still. False when nothing is idle.
  private evictFor(cls: CellClass): boolean {
    const now = this.clock;
    let oldest: Record | null = null;
    for (const r of this.records.values()) {
      if (r.cls === cls && r.entry.usedAt < now && (!oldest || r.entry.usedAt < oldest.entry.usedAt)) oldest = r;
    }
    let layer: Layer | null = null;
    let layerAge = Infinity;
    for (const l of this.layers) {
      // Empty claimed layers are this allocation's own, already counted free.
      if (!l.cls || l.entries.size === 0) continue;
      let newest = -Infinity;
      for (const r of l.entries) {
        newest = Math.max(newest, r.entry.usedAt);
        if (newest >= now) break;
      }
      if (newest < now && newest < layerAge) {
        layer = l;
        layerAge = newest;
      }
    }
    if (oldest && (!layer || oldest.entry.usedAt <= layerAge)) {
      this.evict(oldest);
      return true;
    }
    if (layer) {
      for (const r of [...layer.entries]) this.evict(r);
      return true;
    }
    return false;
  }

  private evict(r: Record): void {
    this.evictions++;
    this.release(r.entry.key);
  }
}
