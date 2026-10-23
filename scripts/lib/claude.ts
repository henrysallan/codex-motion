// Shared bits for the scripts that call Claude: credentials, the models we
// default to, and what a run costs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Bulk extraction and tagging: fast and cheap, plenty for picking tags from
// a fixed list or pulling fields out of a page.
export const BULK_MODEL = 'claude-haiku-5-5';
// The browsing agent: rare, and the one job that needs judgement.
export const AGENT_MODEL = 'claude-opus-5-5';

export function loadEnv(): void {
  try {
    process.loadEnvFile('.env.local');
  } catch {
    // No .env.local; the environment may still carry credentials.
  }
}

export const hasCredentials = () =>
  !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || fs.existsSync(path.join(os.homedir(), '.config', 'anthropic')));

// $ per million tokens (list prices, October 2026): input, output, cache
// read. Cache writes bill at 1.25x input. Haiku's cache-read rate is
// assumed at the usual 0.1x; past 100K-token prompts it bills $0.50 / $2.50.
const PRICES: Record<string, [number, number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-opus-5-5': [4, 20, 0.2],
};

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export function addUsage(u: Usage, r: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): void {
  u.input += r.input_tokens;
  u.output += r.output_tokens;
  u.cacheRead += r.cache_read_input_tokens ?? 0;
  u.cacheWrite += r.cache_creation_input_tokens ?? 0;
}

// Dollars, or null for a model without a price here.
export function cost(model: string, u: Usage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (u.input * p[0] + u.cacheWrite * p[0] * 1.25 + u.cacheRead * p[2] + u.output * p[1]) / 1e6;
}

export const price = (model: string) => PRICES[model] ?? null;

export const dollars = (n: number | null) => (n === null ? 'unknown cost' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

// Models that take the server-side refusal fallback (`fallbacks: 'default'`);
// Haiku has none.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
export const takesFallback = (model: string) => FALLBACK_MODELS.has(model);
