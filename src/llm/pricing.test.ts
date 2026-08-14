import { afterEach, describe, expect, it, vi } from "vitest";
import { priceUsage } from "./pricing.js";
import type { Usage } from "./types.js";

const usage = (inputTokens: number, outputTokens: number, cachedInputTokens = 0): Usage => ({
  inputTokens,
  outputTokens,
  cachedInputTokens,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("priceUsage", () => {
  it("prices a known Anthropic model from the table", () => {
    // claude-sonnet-5: $3/MTok in, $15/MTok out.
    expect(priceUsage("anthropic", "claude-sonnet-5", usage(1_000_000, 1_000_000), null)).toBeCloseTo(18);
  });

  it("matches a dated snapshot to its alias's price", () => {
    expect(priceUsage("anthropic", "claude-haiku-4-5-20251001", usage(1_000_000, 0), null)).toBeCloseTo(1);
  });

  it("bills cached input at the cheaper cache-read rate", () => {
    // Half the prompt cached: 500k at $5 + 500k at $0.50, no output.
    const cost = priceUsage("anthropic", "claude-opus-5", usage(1_000_000, 0, 500_000), null);
    expect(cost).toBeCloseTo(2.75);
  });

  it("prefers a provider-reported cost over the table", () => {
    // OpenRouter bills the call back to us; that figure is the actual charge.
    expect(priceUsage("openrouter", "anthropic/claude-sonnet-5", usage(1_000_000, 1_000_000), 0.42)).toBe(0.42);
  });

  it("finds an underlying vendor price behind an OpenRouter slug", () => {
    expect(priceUsage("openrouter", "anthropic/claude-sonnet-5", usage(1_000_000, 0), null)).toBeCloseTo(3);
  });

  it("does not mis-price a non-Anthropic OpenRouter slug from the Anthropic table", () => {
    expect(priceUsage("openrouter", "openai/some-unknown-model", usage(1_000_000, 1_000_000), null)).toBe(0);
  });

  it("returns 0 for an unknown model rather than guessing", () => {
    // Deliberate: a wrong price silently poisons every profit number on the
    // Economics page, and startup warns once when this happens.
    expect(priceUsage("xai", "grok-unknown", usage(1_000_000, 1_000_000), null)).toBe(0);
  });

  it("uses the operator's override when one is set", () => {
    vi.stubEnv("AGENT_PRICE_INPUT_PER_MTOK", "2");
    vi.stubEnv("AGENT_PRICE_OUTPUT_PER_MTOK", "8");
    expect(priceUsage("moonshot", "kimi-whatever", usage(1_000_000, 1_000_000), null)).toBeCloseTo(10);
  });

  it("lets the override win over the built-in table", () => {
    vi.stubEnv("AGENT_PRICE_INPUT_PER_MTOK", "1");
    vi.stubEnv("AGENT_PRICE_OUTPUT_PER_MTOK", "1");
    expect(priceUsage("anthropic", "claude-opus-5", usage(1_000_000, 1_000_000), null)).toBeCloseTo(2);
  });
});
