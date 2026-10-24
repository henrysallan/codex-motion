// WGSL for the five passes of a view: background, backdrops (board frames,
// the overlay shader writing depth), L0 tiles (one instanced draw from the
// sprite atlas), video tiles (one draw per decoded frame, over the L0 tile
// with crossfade alpha) and overlay rects (selection, handles, marquee). Rects arrive already in device pixels, transformed on the CPU in
// double precision, so far-out world coordinates never jitter.
//
// Both tile shaders filter by footprint: when a tile is drawn smaller than
// its source, they average up to 4x4 bilinear taps across the texels each
// pixel covers. That stands in for mipmaps, which neither a packed atlas nor
// an external video texture has.

const common = /* wgsl */ `
struct Globals {
  viewport: vec2f,     // device px
  camera: vec2f,       // world position of the viewport's top-left corner
  scale: f32,          // device px per world unit
  dpr: f32,
  radius: f32,         // tile corner radius, device px
  grid: f32,           // dot grid strength
  background: vec4f,
  gridColor: vec4f,
  placeholder: vec4f,
};
@group(0) @binding(0) var<uniform> G: Globals;

fn toClip(p: vec2f, depth: f32) -> vec4f {
  return vec4f(p.x / G.viewport.x * 2.0 - 1.0, 1.0 - p.y / G.viewport.y * 2.0, depth, 1.0);
}

// Triangle-strip quad corner for vertex 0..3.
fn corner(vi: u32) -> vec2f {
  return vec2f(f32(vi & 1u), f32(vi >> 1u));
}

// Signed distance to a rounded rect centred at the origin.
fn sdRoundRect(p: vec2f, half: vec2f, r: f32) -> f32 {
  let q = abs(p) - half + r;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// Antialiased coverage of a tile with the view's corner radius.
fn tileCoverage(local: vec2f, size: vec2f) -> f32 {
  let r = min(G.radius, 0.5 * min(size.x, size.y));
  return clamp(0.5 - sdRoundRect(local - 0.5 * size, 0.5 * size, r), 0.0, 1.0);
}

// Antialiased coverage of a pixel by a tile's clip rect (device px, x, y, w,
// h; a negative width: no clip) with corners of radius r.
fn clipCoverage(pos: vec2f, clip: vec4f, r: f32) -> f32 {
  if (clip.z < 0.0) { return 1.0; }
  let half = 0.5 * clip.zw;
  return clamp(0.5 - sdRoundRect(pos - clip.xy - half, half, min(r, min(half.x, half.y))), 0.0, 1.0);
}
`;

export const backgroundShader = /* wgsl */ `
${common}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4f(p * 2.0 - 1.0, 1.0, 1.0);
}

// Dots on a world grid whose spacing steps by 4x so they stay 16-64 px apart.
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  var color = G.background.rgb;
  if (G.grid > 0.0) {
    let world = G.camera + pos.xy / G.scale;
    let level = max(0.0, ceil(log2(16.0 / (32.0 * G.scale)) / 2.0));
    let spacing = 32.0 * pow(4.0, level);
    let cell = world / spacing;
    let d = length(abs(cell - round(cell)) * spacing * G.scale);
    let spot = 1.0 - smoothstep(0.6 * G.dpr, 1.4 * G.dpr, d);
    color = mix(color, G.gridColor.rgb, spot * G.grid);
  }
  return vec4f(color, 1.0);
}
`;

export const tileShader = /* wgsl */ `
${common}

struct Tile {
  rect: vec4f,    // x, y, w, h in device px
  uv: vec4f,      // atlas uv of this frame: u0, v0, u1, v1
  layer: f32,     // atlas layer; negative while the sprite is loading
  depth: f32,
  dim: f32,
  clipRadius: f32,
  clip: vec4f,    // device px; see clipCoverage
};
@group(0) @binding(1) var<storage, read> tiles: array<Tile>;
@group(0) @binding(2) var atlas: texture_2d_array<f32>;
@group(0) @binding(3) var samp: sampler;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) local: vec2f,
  @location(2) @interpolate(flat) uvRect: vec4f,
  @location(3) @interpolate(flat) size: vec2f,
  // Atlas texels per device pixel along x and y.
  @location(4) @interpolate(flat) footprint: vec2f,
  @location(5) @interpolate(flat) misc: vec3f, // layer, dim, clip radius
  @location(6) @interpolate(flat) clip: vec4f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let t = tiles[ii];
  let c = corner(vi);
  var out: VOut;
  out.pos = toClip(t.rect.xy + c * t.rect.zw, t.depth);
  out.uv = mix(t.uv.xy, t.uv.zw, c);
  out.local = c * t.rect.zw;
  out.uvRect = t.uv;
  out.size = t.rect.zw;
  let texels = (t.uv.zw - t.uv.xy) * vec2f(textureDimensions(atlas));
  out.footprint = texels / max(t.rect.zw, vec2f(1.0));
  out.misc = vec3f(t.layer, t.dim, t.clipRadius);
  out.clip = t.clip;
  return out;
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let coverage = tileCoverage(v.local, v.size) * clipCoverage(v.pos.xy, v.clip, v.misc.z);
  if (coverage <= 0.0) { discard; }
  var color = G.placeholder.rgb;
  let layer = i32(v.misc.x);
  if (layer >= 0) {
    let texel = 1.0 / vec2f(textureDimensions(atlas));
    let lo = v.uvRect.xy + 0.5 * texel;
    let hi = v.uvRect.zw - 0.5 * texel;
    let n = clamp(ceil(v.footprint), vec2f(1.0), vec2f(4.0));
    var acc = vec3f(0.0);
    for (var j = 0.0; j < n.y; j += 1.0) {
      for (var i = 0.0; i < n.x; i += 1.0) {
        let o = ((vec2f(i, j) + 0.5) / n - 0.5) * v.footprint * texel;
        acc += textureSampleLevel(atlas, samp, clamp(v.uv + o, lo, hi), layer, 0.0).rgb;
      }
    }
    color = acc / (n.x * n.y);
  }
  return vec4f(mix(G.background.rgb, color, v.misc.y), coverage);
}
`;

export const videoShader = /* wgsl */ `
${common}

struct VideoTile {
  rect: vec4f,    // x, y, w, h in device px
  frame: vec4f,   // frame width, frame height, alpha, depth
  misc: vec4f,    // dim, clip radius
  crop: vec4f,    // u0, v0, u1, v1 of the frame to show
  clip: vec4f,    // device px; see clipCoverage
};
@group(1) @binding(0) var<uniform> V: VideoTile;
@group(1) @binding(1) var frame: texture_external;
@group(1) @binding(2) var samp: sampler;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) local: vec2f,
};

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let c = corner(vi);
  var out: VOut;
  out.pos = toClip(V.rect.xy + c * V.rect.zw, V.frame.w);
  out.uv = mix(V.crop.xy, V.crop.zw, c);
  out.local = c * V.rect.zw;
  return out;
}

@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let footprint = V.frame.xy * (V.crop.zw - V.crop.xy) / max(V.rect.zw, vec2f(1.0));
  let n = clamp(ceil(footprint), vec2f(1.0), vec2f(4.0));
  var acc = vec3f(0.0);
  for (var j = 0.0; j < n.y; j += 1.0) {
    for (var i = 0.0; i < n.x; i += 1.0) {
      let o = ((vec2f(i, j) + 0.5) / n - 0.5) * footprint / V.frame.xy;
      acc += textureSampleBaseClampToEdge(frame, samp, v.uv + o).rgb;
    }
  }
  let color = mix(G.background.rgb, acc / (n.x * n.y), V.misc.x);
  return vec4f(color, V.frame.z * tileCoverage(v.local, V.rect.zw) * clipCoverage(v.pos.xy, V.clip, V.misc.y));
}
`;

export const overlayShader = /* wgsl */ `
${common}

struct Rect {
  rect: vec4f,     // x, y, w, h in device px
  fill: vec4f,     // straight alpha
  stroke: vec4f,
  params: vec4f,   // stroke width, radius (device px), depth (backdrops)
};
@group(0) @binding(1) var<storage, read> rects: array<Rect>;

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) p: vec2f,
  @location(1) @interpolate(flat) index: u32,
};

@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let r = rects[ii];
  // Grow the quad to fit a centred stroke plus a pixel of antialiasing.
  let pad = 0.5 * r.params.x + 1.0;
  let c = corner(vi);
  let p = r.rect.xy - pad + c * (r.rect.zw + 2.0 * pad);
  var out: VOut;
  out.pos = toClip(p, r.params.z);
  out.p = p;
  out.index = ii;
  return out;
}

// Premultiplied output: stroke over fill.
@fragment fn fs(v: VOut) -> @location(0) vec4f {
  let r = rects[v.index];
  let half = 0.5 * r.rect.zw;
  let d = sdRoundRect(v.p - r.rect.xy - half, half, min(r.params.y, min(half.x, half.y)));
  let fillA = r.fill.a * clamp(0.5 - d, 0.0, 1.0);
  let sw = r.params.x;
  let strokeA = select(0.0, r.stroke.a * clamp(0.5 - (abs(d) - 0.5 * sw), 0.0, 1.0), sw > 0.0);
  let a = strokeA + fillA * (1.0 - strokeA);
  // Backdrops write depth, which mustn't cover what's under their corners.
  if (a <= 0.0) { discard; }
  let rgb = r.stroke.rgb * strokeA + r.fill.rgb * fillA * (1.0 - strokeA);
  return vec4f(rgb, a);
}
`;
