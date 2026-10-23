// The motion vocabulary from the spec: the fixed tags a vision model may
// apply, so the library stays consistent. Each value carries a one-line
// definition the tagger is held to. Edit freely; stored tags are
// "group:slug" (technique:3d-render).

export const VOCABULARY = {
  technique: {
    '2D cel': 'hand-drawn, frame-by-frame animation',
    'Shape layer': 'flat vector shapes and graphics animated, After Effects style',
    '3D render': 'CG-rendered 3D objects or scenes',
    'Fluid sim': 'simulated liquid, smoke or viscous, gooey motion',
    'Cloth sim': 'simulated fabric or soft bodies',
    Particles: 'many small elements driven as a system: dust, sparks, swarms',
    'Kinetic type': 'typography that moves and carries the piece; static captions or a still logo do not count',
    'Stop motion': 'physical objects animated and photographed frame by frame',
    'Live action': 'camera footage of real people, places or things',
    Generative: 'code-driven or procedural visuals: algorithmic patterns, systems',
    'Pixel art': 'low-resolution pixel graphics',
  },
  camera: {
    Static: 'the frame itself does not move (most motion graphics)',
    Pan: 'the view slides sideways or vertically across the scene',
    'Push-in': 'the view moves or zooms toward the subject',
    Orbit: 'the camera circles around a subject',
    Handheld: 'shaky, human-held camera',
    'Morph cut': 'one shot or form transforms seamlessly into the next',
  },
  easing: {
    Snappy: 'fast moves that stop abruptly',
    Elastic: 'springy settles that bounce',
    Linear: 'constant-speed, unaccelerated motion',
    Floaty: 'slow, drifting, softly eased motion',
    Overshoot: 'moves past the target, then settles back',
  },
  pacing: {
    'Hard cuts': 'abrupt cuts between different shots or scenes',
    'Match cuts': 'cuts that carry a shape, position or motion across shots',
    'Single take': 'one continuous shot or animation with no cuts',
    'Rhythmic to beat': 'cuts or moves timed to a steady rhythm',
  },
  use: {
    'Logo reveal': 'the clip builds to a logo or wordmark as its point',
    Transition: 'a short move or wipe from one screen or state to another',
    'UI motion': 'app, web or interface screens shown or animated',
    'Title sequence': 'opening or closing titles or credits for a film, show or event',
    'Product shot': 'a physical product presented as the subject',
    Loop: 'the last frame returns seamlessly to the first',
  },
} as const satisfies Record<string, Record<string, string>>;

export type TagGroup = keyof typeof VOCABULARY;

export const TAG_GROUPS = Object.keys(VOCABULARY) as TagGroup[];

export const labels = (g: TagGroup) => Object.keys(VOCABULARY[g]);

export const slug = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// "technique:3d-render" -> "3D render"; free tags ("visual:chrome") read as written.
export function tagLabel(tag: string): string {
  const [group, value] = tag.split(':', 2) as [string, string | undefined];
  const known = group in VOCABULARY ? labels(group as TagGroup) : [];
  return known.find((l) => slug(l) === value) ?? value ?? tag;
}
