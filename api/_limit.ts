// Per-person call limits for the functions in api/ (the leading underscore
// keeps Vercel from serving this file as a function of its own).
//
// Counted in memory, per instance: Fluid compute keeps one warm instance
// for a site this size, so a limit stops a runaway loop or a script, but
// it isn't a global quota. The Firewall rules and the Anthropic key's spend
// limit are the backstops.

// A counter allowing `limit` calls per key in any `windowMs`. Each endpoint
// makes its own, so their calls aren't counted together. The function
// counts the call when it's allowed and answers whether it was.
export function rateLimit(limit: number, windowMs: number): (key: string, now?: number) => boolean {
  const calls = new Map<string, number[]>();
  return (key, now = Date.now()) => {
    const since = now - windowMs;
    const recent = (calls.get(key) ?? []).filter((t) => t > since);
    const ok = recent.length < limit;
    if (ok) recent.push(now);
    calls.set(key, recent);
    if (calls.size > 1000) for (const [k, times] of calls) if (!times.some((t) => t > since)) calls.delete(k);
    return ok;
  };
}
