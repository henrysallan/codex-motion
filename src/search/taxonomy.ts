// What search can filter by, and how a clip's metadata maps onto it. Shared
// by the index builder (scripts/search-index.ts) and the app, so a value
// means the same thing on both sides.
//
// Scraped metadata is messy: studios tag projects with their own service
// lines ("Motion Graphics & Film", "Brand Strategy"), industries, cities and
// boilerplate ("Challenge", "Outcome"). Project type and sector are fixed
// lists that those tags map onto; anything unmapped stays searchable as text.

import { slug, TAG_GROUPS, tagLabel, type TagGroup } from '../media/vocabulary.ts';

export type FacetKey =
  | 'studio'
  | 'client'
  | 'site'
  | 'projectType'
  | 'sector'
  | 'technique'
  | 'use'
  | 'camera'
  | 'easing'
  | 'pacing'
  | 'color'
  | 'aspect'
  | 'duration'
  | 'year';

export interface FacetDef {
  key: FacetKey;
  label: string;
  // Prefix accepted in the search field: `client:nike`.
  alias: string[];
  // How the panel orders values: by count, or in the listed/natural order.
  order: 'count' | 'fixed' | 'desc';
}

export const FACETS: FacetDef[] = [
  { key: 'technique', label: 'Technique', alias: ['technique', 'tech'], order: 'count' },
  { key: 'use', label: 'Content', alias: ['use', 'content', 'type'], order: 'count' },
  { key: 'projectType', label: 'Project type', alias: ['project', 'projecttype'], order: 'count' },
  { key: 'studio', label: 'Studio', alias: ['studio', 'agency', 'by'], order: 'count' },
  { key: 'client', label: 'Client', alias: ['client', 'for', 'brand'], order: 'count' },
  { key: 'sector', label: 'Sector', alias: ['sector', 'industry'], order: 'count' },
  { key: 'site', label: 'Source', alias: ['source', 'site', 'from'], order: 'count' },
  { key: 'color', label: 'Colour', alias: ['color', 'colour'], order: 'fixed' },
  { key: 'camera', label: 'Camera', alias: ['camera'], order: 'count' },
  { key: 'easing', label: 'Easing', alias: ['easing', 'ease'], order: 'count' },
  { key: 'pacing', label: 'Pacing', alias: ['pacing', 'cuts'], order: 'count' },
  { key: 'aspect', label: 'Aspect', alias: ['aspect', 'ratio'], order: 'fixed' },
  { key: 'duration', label: 'Length', alias: ['length', 'duration'], order: 'fixed' },
  { key: 'year', label: 'Year', alias: ['year'], order: 'desc' },
];

export const facetDef = (key: FacetKey) => FACETS.find((f) => f.key === key)!;

export function facetByAlias(alias: string): FacetDef | undefined {
  const a = alias.toLowerCase();
  return FACETS.find((f) => f.alias.includes(a));
}

// ---- project type and sector -------------------------------------------------------
// Matched against a page's source tags, lowercased.

export const PROJECT_TYPES: [string, RegExp][] = [
  ['Brand identity', /^(brand identity|identity|visual identity|graphic identity|branding|rebrand(ing)?|brand design|motion identity|motion branding|event identity|campaign identity|network branding|sports branding|brand language|visual language|visual system|design system|sub-brand|global brand transformation|logo( design)?|logotype|wordmark|hand-drawn wordmarks)$/],
  ['Motion & film', /^(motion graphics & film|motion graphics|motion design|motion system|motion|animation|film|minifilm|tvc|showreel|studio reel|music videos?)$/],
  ['Campaign', /^(campaigns?|launch campaign|commercial|ooh|billboards|advertising|social media|social|creative production)$/],
  ['Digital & web', /^(digital experiences|digital( design)?|websites?|website development|web design|interaction design|interactive|e-commerce|shopify|agency website|apps?|ui|ux|screen content|in-game)$/],
  ['Type design', /^(typefaces?|type design|variable font|custom typeface)$/],
  ['Creative coding', /^(creative coding|generative( design| tool| pattern design| visual systems)?|custom tools|audio-?reactive( visuali[sz]ation| visualisers)?|visuali[sz]er)$/],
  ['Data visualization', /^(data driven experiences|data visuali[sz]ation|data)$/],
  ['Environmental & signage', /^(signage & environmental graphics|exhibitions?|environmental graphics|wayfinding|retail|physical roll out|circular screen design|architecture)$/],
  ['Packaging', /^packaging$/],
  ['Editorial & print', /^(publications|books|editorial design|publishing|print|zine|posters?)$/],
  ['Title sequence', /^(title sequences?|opening titles)$/],
  ['Sound & sonic identity', /^(sound design|sonic identity|sonic branding|sound logo|sound mnemonic)$/],
  ['Illustration & icons', /^(illustration|iconography|icons|pictograms|logo animation)$/],
  ['Naming & verbal', /^(naming|verbal identity|messaging)$/],
  ['Strategy', /^(brand strategy|strategy|positioning|brand positioning|research)$/],
  ['Product design', /^(industrial\/product design|product design|product render)$/],
];

export const SECTORS: [string, RegExp][] = [
  ['Arts & culture', /^(arts & culture|contemporary art|museums?|dance|festivals?|theatre|culture)$/],
  ['Entertainment & media', /^(entertainment|broadcast design|ott|media|television|tv)$/],
  ['Technology', /^(technology|tech|ai|software|b2b|saas)$/],
  ['Finance', /^(finance|fintech|banking|insurance|payments)$/],
  ['Non-profit', /^(non-profits?|nonprofit|charity|community)$/],
  ['Health', /^(health|healthcare|biomedical sciences|wellness|sun care)$/],
  ['Education', /^(education|universit(y|ies))$/],
  ['Food & drink', /^(food & drink|food distribution|restaurants?|wine)$/],
  ['Fashion & beauty', /^(fashion & beauty|fashion|streetwear|menswear|beauty)$/],
  ['Sport', /^(sports?|sports branding|nba|basketball|football|soccer|paris olympics|olympics|running)$/],
  ['Gaming', /^(gaming|esports|video games?|league of legends|fortnite)$/],
  ['Music', /^(music( services| technology)?|vinyl|audio)$/],
  ['Civic & public', /^(civic & public|government|public sector)$/],
  ['Real estate', /^real estate$/],
  ['Transport', /^(transport(ation)?|automotive|mobility)$/],
  ['Travel & hospitality', /^(hospitality & travel|travel|hotels?|hospitality)$/],
  ['Industry', /^(manufacturing & industrials)$/],
  ['Climate', /^(climate & sustainability|sustainability)$/],
  ['Consumer brands', /^(consumer brands|consumer)$/],
];

export function classify(tags: readonly string[], table: [string, RegExp][]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    const k = t.toLowerCase().trim();
    for (const [label, re] of table) if (re.test(k)) out.add(label);
  }
  return [...out];
}

// ---- colour ----------------------------------------------------------------------
// From the tagger's free "visual:" tags ("visual:neon-green",
// "visual:blue-to-pink-gradient"). Near-synonyms fold into one swatch.

export const COLORS: { value: string; label: string; swatch: string; words: string[] }[] = [
  { value: 'red', label: 'Red', swatch: '#e04a3c', words: ['red', 'maroon', 'burgundy', 'crimson', 'scarlet'] },
  { value: 'orange', label: 'Orange', swatch: '#f08a24', words: ['orange', 'coral', 'peach', 'ochre', 'amber'] },
  { value: 'yellow', label: 'Yellow', swatch: '#f2cf2a', words: ['yellow', 'gold', 'mustard'] },
  { value: 'green', label: 'Green', swatch: '#3fa452', words: ['green', 'lime', 'mint', 'olive'] },
  { value: 'teal', label: 'Teal', swatch: '#1fa3a3', words: ['teal', 'cyan', 'turquoise', 'aqua'] },
  { value: 'blue', label: 'Blue', swatch: '#3166e0', words: ['blue', 'navy', 'cobalt', 'indigo'] },
  { value: 'purple', label: 'Purple', swatch: '#8048d8', words: ['purple', 'violet', 'lilac', 'lavender'] },
  { value: 'pink', label: 'Pink', swatch: '#ec6fae', words: ['pink', 'magenta', 'fuchsia'] },
  { value: 'brown', label: 'Brown', swatch: '#8a5a3a', words: ['brown', 'beige', 'tan'] },
  { value: 'cream', label: 'Cream', swatch: '#efe6cf', words: ['cream', 'ivory', 'off-white'] },
  { value: 'black', label: 'Black', swatch: '#141414', words: ['black'] },
  { value: 'white', label: 'White', swatch: '#ffffff', words: ['white'] },
  { value: 'grey', label: 'Grey', swatch: '#9a9aa0', words: ['grey', 'gray', 'silver'] },
  { value: 'monochrome', label: 'Monochrome', swatch: 'linear-gradient(90deg,#111 50%,#fff 50%)', words: ['monochrome', 'black-and-white', 'duotone'] },
  { value: 'pastel', label: 'Pastel', swatch: 'linear-gradient(135deg,#f6c9d9,#c9e3f6,#d9f6c9)', words: ['pastel'] },
  { value: 'neon', label: 'Neon', swatch: 'linear-gradient(135deg,#39ff88,#ff3df2)', words: ['neon', 'fluorescent'] },
  { value: 'gradient', label: 'Gradient', swatch: 'linear-gradient(135deg,#ff7a59,#6b5bff)', words: ['gradient', 'iridescent', 'holographic'] },
];

export function colorsOf(analysisTags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of analysisTags) {
    if (!t.startsWith('visual:')) continue;
    const v = t.slice(7);
    const parts = v.split('-');
    for (const c of COLORS) if (c.words.some((w) => (w.includes('-') ? v.includes(w) : parts.includes(w)))) out.add(c.value);
  }
  return [...out];
}

// ---- format ----------------------------------------------------------------------

export const ASPECTS = [
  { value: 'landscape', label: 'Landscape' },
  { value: 'square', label: 'Square' },
  { value: 'portrait', label: 'Portrait' },
];

export function aspectOf(width: number, height: number): string {
  const r = width / Math.max(1, height);
  return r > 1.2 ? 'landscape' : r < 0.83 ? 'portrait' : 'square';
}

export const DURATIONS = [
  { value: 'short', label: 'Under 5 s', max: 5 },
  { value: 'medium', label: '5–15 s', max: 15 },
  { value: 'long', label: '15–60 s', max: 60 },
  { value: 'film', label: 'Over 1 min', max: Infinity },
];

export const durationOf = (seconds: number) => DURATIONS.find((d) => seconds < d.max)!.value;

// "2023–Present" -> 2023; "25-26" -> 2025.
export function yearOf(raw: string | undefined): number | null {
  if (!raw) return null;
  const full = raw.match(/\b(19|20)\d{2}\b/);
  if (full) return Number(full[0]);
  const short = raw.match(/^(\d{2})\s*[-–—/]\s*\d{2}$/);
  return short ? 2000 + Number(short[1]) : null;
}

// ---- studios -----------------------------------------------------------------------

// "Studio Dumbar/DEPT®" -> both; "FutureDeluxe, Patswerk" -> both.
export function splitStudios(agency: string | undefined): string[] {
  if (!agency) return [];
  return agency
    .split(/\s*[/,;]\s*|\s+and\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

// ---- labels ----------------------------------------------------------------------

// The vocabulary facets store "group:slug" tags; their facet values are the slugs.
export const VOCAB_FACETS = TAG_GROUPS as readonly TagGroup[] as readonly FacetKey[];

export function valueLabel(key: FacetKey, value: string): string {
  if ((TAG_GROUPS as readonly string[]).includes(key)) return tagLabel(`${key}:${value}`);
  if (key === 'color') return COLORS.find((c) => c.value === value)?.label ?? value;
  if (key === 'aspect') return ASPECTS.find((a) => a.value === value)?.label ?? value;
  if (key === 'duration') return DURATIONS.find((d) => d.value === value)?.label ?? value;
  return value;
}

// Fixed-order facets list their values in this order.
export function fixedOrder(key: FacetKey): string[] | null {
  if (key === 'color') return COLORS.map((c) => c.value);
  if (key === 'aspect') return ASPECTS.map((a) => a.value);
  if (key === 'duration') return DURATIONS.map((d) => d.value);
  return null;
}

export { slug };
