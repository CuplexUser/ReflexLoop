// src/llm/providers.ts
//
// The registry of providers this runner can talk to, and how each one is reached.
//
// Four of the five speak the OpenAI /chat/completions wire format (OpenRouter,
// OpenAI, xAI, Moonshot), so they share one adapter and differ only in base URL,
// key, and the provider-specific knob that turns on server-side web search.
// Anthropic has its own Messages API and gets a native adapter -- worth the extra
// file rather than going through Anthropic's OpenAI-compatibility shim, which
// lags on tool use.
//
// Model IDs are NOT defaulted here on purpose. Every provider renames and retires
// models on its own schedule, and a stale hardcoded default fails at the first API
// call with an opaque 404 rather than at startup. AGENT_MODEL is required; index.ts
// fails fast and points at the provider's model list.

import type { ProviderId } from "./types.js";

export type ProviderKind = "openai-compatible" | "anthropic";

export interface ProviderSpec {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  /** Default API root; override per-provider with the env var in `baseUrlEnv`. */
  baseUrl: string;
  baseUrlEnv: string;
  /** Env var holding this provider's API key. */
  apiKeyEnv: string;
  /** Where an operator finds valid model ids for this provider. */
  modelsUrl: string;
  /** Whether the provider can run web search server-side (AGENT_SEARCH_PROVIDER=native). */
  nativeSearch: boolean;
}

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    apiKeyEnv: "OPENROUTER_API_KEY",
    modelsUrl: "https://openrouter.ai/models",
    // OpenRouter's `plugins: [{id: "web"}]` works across every model it proxies,
    // which is what makes it the least surprising default for native search.
    nativeSearch: true,
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    baseUrlEnv: "OPENAI_BASE_URL",
    apiKeyEnv: "OPENAI_API_KEY",
    modelsUrl: "https://platform.openai.com/docs/models",
    // `web_search_options` is only honoured by OpenAI's search-enabled models;
    // on any other model the field is accepted and does nothing, so native mode
    // silently degrades to no search. Prefer tavily/brave here.
    nativeSearch: true,
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    modelsUrl: "https://platform.claude.com/docs/en/about-claude/models/overview",
    nativeSearch: true,
  },
  xai: {
    id: "xai",
    label: "xAI (Grok)",
    kind: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    baseUrlEnv: "XAI_BASE_URL",
    apiKeyEnv: "XAI_API_KEY",
    modelsUrl: "https://docs.x.ai/docs/models",
    nativeSearch: true,
  },
  moonshot: {
    id: "moonshot",
    label: "Moonshot (Kimi)",
    kind: "openai-compatible",
    // Moonshot runs separate international and mainland-China endpoints; set
    // MOONSHOT_BASE_URL=https://api.moonshot.cn/v1 for an account created there.
    baseUrl: "https://api.moonshot.ai/v1",
    baseUrlEnv: "MOONSHOT_BASE_URL",
    apiKeyEnv: "MOONSHOT_API_KEY",
    modelsUrl: "https://platform.moonshot.ai/docs/introduction",
    nativeSearch: true,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

export function isProviderId(value: string): value is ProviderId {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}
