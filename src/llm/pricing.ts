// src/llm/pricing.ts
//
// Turns token usage into dollars, because the Economics page is built on real
// spend per phase. The Agent SDK used to hand us `total_cost_usd` for free; a raw
// API doesn't, so cost is now: whatever the provider reported, else this table,
// else an operator-supplied override, else zero-and-say-so.
//
// Only Anthropic's list prices are hardcoded, because those are the ones this
// project can state with confidence. Every other provider is either self-reporting
// (OpenRouter returns real per-call cost) or configured by the operator. A wrong
// price silently poisons every profit number on the Economics page, so an unknown
// model is deliberately reported as $0 with a loud one-time warning rather than
// guessed at.

import type { ProviderId, Usage } from "./types.js";

export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /**
   * USD per 1M tokens read back from the provider's prompt cache. Anthropic charges
   * ~0.1x the input rate for cache reads; omitted means "same as input".
   */
  cachedInputPerMTok?: number;
}

/**
 * Anthropic list prices (USD per 1M tokens). Cache reads are 0.1x input across the
 * lineup, so they're derived rather than repeated on every row.
 */
const ANTHROPIC_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-mythos-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

const PRICES: Partial<Record<ProviderId, Record<string, ModelPrice>>> = {
  anthropic: ANTHROPIC_PRICES,
};

/** Operator escape hatch for any model this file doesn't know: set both to price it. */
function envOverride(): ModelPrice | null {
  const input = Number(process.env.AGENT_PRICE_INPUT_PER_MTOK);
  const output = Number(process.env.AGENT_PRICE_OUTPUT_PER_MTOK);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  const cached = Number(process.env.AGENT_PRICE_CACHED_INPUT_PER_MTOK);
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    cachedInputPerMTok: Number.isFinite(cached) ? cached : undefined,
  };
}

/**
 * OpenRouter model slugs are `vendor/model`, sometimes with a `:free`/`:online` suffix.
 * Strip both so an OpenRouter run can still find an underlying vendor's price row.
 */
function normalizeModel(model: string): string {
  const withoutVariant = model.split(":")[0];
  const slash = withoutVariant.lastIndexOf("/");
  return (slash === -1 ? withoutVariant : withoutVariant.slice(slash + 1)).trim().toLowerCase();
}

export function lookupPrice(provider: ProviderId, model: string): ModelPrice | null {
  const override = envOverride();
  if (override) return override;

  const table = PRICES[provider] ?? (provider === "openrouter" ? ANTHROPIC_PRICES : undefined);
  if (!table) return null;

  const normalized = normalizeModel(model);
  if (table[normalized]) return table[normalized];
  // Dated snapshots (claude-haiku-4-5-20251001) share the alias's price.
  const prefixMatch = Object.keys(table).find((key) => normalized.startsWith(key));
  return prefixMatch ? table[prefixMatch] : null;
}

const warnedModels = new Set<string>();

/**
 * `reportedCostUsd` wins when the provider gave us one -- that's the actual charge,
 * not an estimate. Otherwise price from the table.
 */
export function priceUsage(
  provider: ProviderId,
  model: string,
  usage: Usage,
  reportedCostUsd: number | null
): number {
  if (reportedCostUsd !== null && Number.isFinite(reportedCostUsd)) return reportedCostUsd;

  const price = lookupPrice(provider, model);
  if (!price) {
    const key = `${provider}/${model}`;
    if (!warnedModels.has(key)) {
      warnedModels.add(key);
      console.warn(
        `[pricing] No price known for ${key}; recording $0 for its runs. ` +
          `Set AGENT_PRICE_INPUT_PER_MTOK and AGENT_PRICE_OUTPUT_PER_MTOK to make the Economics page accurate.`
      );
    }
    return 0;
  }

  const cachedRate = price.cachedInputPerMTok ?? price.inputPerMTok * 0.1;
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncachedInput * price.inputPerMTok +
      usage.cachedInputTokens * cachedRate +
      usage.outputTokens * price.outputPerMTok) /
    1_000_000
  );
}
