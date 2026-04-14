/**
 * Claude API pricing per million tokens (USD).
 * Source: https://platform.claude.com/docs/en/about-claude/pricing
 *
 * Cache hit = 0.1x base input price
 * Cache write (5min) = 1.25x base input price
 */

interface ModelPricing {
  input: number;       // $ per MTok
  output: number;      // $ per MTok
  cache_read: number;  // $ per MTok (cache hit)
  cache_write: number; // $ per MTok (5min cache write)
}

const PRICING: Record<string, ModelPricing> = {
  // Opus 4.6
  "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  // Opus 4.5
  "claude-opus-4-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  "claude-opus-4-5-20251101": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
  // Opus 4.1
  "claude-opus-4-1": { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  "claude-opus-4-1-20250805": { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  // Opus 4
  "claude-opus-4-0": { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  "claude-opus-4-20250514": { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
  // Sonnet 4.6
  "claude-sonnet-4-6": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  // Sonnet 4.5
  "claude-sonnet-4-5": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4-5-20250929": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  // Sonnet 4
  "claude-sonnet-4-0": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  "claude-sonnet-4-20250514": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
  // Haiku 4.5
  "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  // Haiku 3.5
  "claude-haiku-3-5": { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 },
  // Haiku 3
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25, cache_read: 0.03, cache_write: 0.3 },
};

// Alias mapping for common short names and internal model names
const ALIASES: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
  // Coco internal model names
  "codebase-internal": "claude-sonnet-4-6",
};

/**
 * Look up pricing for a model. Returns null if model is unknown.
 */
export function getModelPricing(model: string): ModelPricing | null {
  // Direct match
  if (PRICING[model]) return PRICING[model];

  // Alias
  const alias = ALIASES[model.toLowerCase()];
  if (alias && PRICING[alias]) return PRICING[alias];

  // Prefix match: "claude-sonnet-4-6-20260101" → "claude-sonnet-4-6"
  for (const key of Object.keys(PRICING)) {
    if (model.startsWith(key)) return PRICING[key];
  }

  return null;
}

/**
 * Compute cost in USD for given token counts and model.
 */
export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number
): number {
  const pricing = getModelPricing(model);
  if (!pricing) return 0;

  const M = 1_000_000;
  return (
    (inputTokens / M) * pricing.input +
    (outputTokens / M) * pricing.output +
    (cacheReadTokens / M) * pricing.cache_read +
    (cacheCreationTokens / M) * pricing.cache_write
  );
}
