// Links in a note's text: http(s) URLs and www. names, cut out of a line so
// the rest stays plain text. Pure, so scripts/test can check it.

export type Segment = { text: string } | { href: string; text: string };

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?'"’”*_~]$/;

function href(raw: string): string | null {
  try {
    const u = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// A line of text cut into plain text and links. Trailing punctuation, and a
// closing bracket the link didn't open, stay outside the link.
export function linkify(line: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const m of line.matchAll(URL_RE)) {
    let raw = m[0];
    for (;;) {
      if (TRAILING.test(raw)) raw = raw.slice(0, -1);
      else if (raw.endsWith(')') && raw.split('(').length < raw.split(')').length) raw = raw.slice(0, -1);
      else if (raw.endsWith(']') && raw.split('[').length < raw.split(']').length) raw = raw.slice(0, -1);
      else break;
    }
    const h = href(raw);
    if (!h || m.index === undefined) continue;
    if (m.index > at) out.push({ text: line.slice(at, m.index) });
    out.push({ href: h, text: raw });
    at = m.index + raw.length;
  }
  if (at < line.length) out.push({ text: line.slice(at) });
  return out;
}

// The links in a note, each once, in order.
export function linksIn(body: string): string[] {
  const seen = new Set<string>();
  for (const line of body.split('\n')) for (const s of linkify(line)) if ('href' in s) seen.add(s.href);
  return [...seen];
}
