export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 45) return 'just now';
  const m = s / 60;
  if (m < 45) return `${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 22) return `${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 26) return `${Math.round(d)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

export function clock(seconds: number, fps?: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const base = `${m}:${Math.floor(rest).toString().padStart(2, '0')}`;
  if (!fps) return `${base}.${Math.floor((rest % 1) * 10)}`;
  return `${base}:${Math.floor((rest % 1) * fps).toString().padStart(2, '0')}`;
}
