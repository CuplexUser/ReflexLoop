// src/llm/index.ts
//
// Resolves the LlmClient(s) from the environment, once, at startup. Phases take a
// client as a parameter, so a phase can never quietly reach for a model other than
// the one the operator configured for it.
//
// AGENT_PROVIDER picks the provider (default: openrouter -- one key reaches Claude,
// GPT, Grok and Kimi, and it reports real per-call cost so the Economics page stays
// honest without a pricing table). AGENT_MODEL is required and deliberately has no
// default: providers rename and retire models constantly, and a stale default fails
// at the first API call with an opaque 404 instead of at startup with a usable message.
//
// Each phase can override both. The phases genuinely want different things -- research
// is long, wide and cheap to get wrong; act writes real code into real repos with no
// build step to catch it; reflect is a couple of short memory calls -- so:
//
//   AGENT_RESEARCH_PROVIDER / AGENT_RESEARCH_MODEL
//   AGENT_ACT_PROVIDER      / AGENT_ACT_MODEL
//   AGENT_REFLECT_PROVIDER  / AGENT_REFLECT_MODEL
//
// Anything unset falls back to AGENT_PROVIDER/AGENT_MODEL, so the single-model setup
// stays a two-line .env. Provider and model override independently: setting only
// AGENT_ACT_MODEL keeps the base provider and swaps the model on it, which is the
// common case when both models live behind one OpenRouter key.

import { AnthropicClient } from "./anthropic.js";
import { OpenAiCompatibleClient } from "./openai-compatible.js";
import { PROVIDERS, PROVIDER_IDS, isProviderId } from "./providers.js";
import type { LlmClient, ProviderId } from "./types.js";

export * from "./types.js";
export { PROVIDERS, PROVIDER_IDS } from "./providers.js";
export { priceUsage, lookupPrice } from "./pricing.js";

const DEFAULT_PROVIDER = "openrouter";

/** Output cap per model call. Generous by default -- act phases write whole files. */
export const MAX_OUTPUT_TOKENS = Number(process.env.AGENT_MAX_TOKENS ?? 8192);

/** The three phases that call a model. Matches the `phase` column in `runs`. */
export type PhaseName = "research_plan" | "act" | "reflect";

const PHASE_ENV_PREFIX: Record<PhaseName, string> = {
  research_plan: "AGENT_RESEARCH",
  act: "AGENT_ACT",
  reflect: "AGENT_REFLECT",
};

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

function buildClient(providerId: ProviderId, model: string, phase: PhaseName): LlmClient {
  const spec = PROVIDERS[providerId];

  const apiKey = env(spec.apiKeyEnv);
  if (!apiKey) {
    throw new Error(
      `The ${phase} phase is configured to use ${spec.label}, which needs ${spec.apiKeyEnv} set in .env (see .env.example).`
    );
  }

  const baseUrl = (env(spec.baseUrlEnv) || spec.baseUrl).replace(/\/+$/, "");
  return spec.kind === "anthropic"
    ? new AnthropicClient(spec, model, apiKey, baseUrl)
    : new OpenAiCompatibleClient(spec, model, apiKey, baseUrl);
}

function resolveProviderId(value: string, source: string): ProviderId {
  if (!isProviderId(value)) {
    throw new Error(`${source}="${value}" is not supported. Choose one of: ${PROVIDER_IDS.join(", ")}.`);
  }
  return value;
}

/**
 * One client per phase. Phases that resolve to the same provider+model share an
 * instance -- clients are stateless, and sharing keeps the startup log honest about
 * how many distinct models are actually in play.
 */
export function resolveLlmClients(): Record<PhaseName, LlmClient> {
  const baseProviderRaw = env("AGENT_PROVIDER") || DEFAULT_PROVIDER;
  const baseProvider = resolveProviderId(baseProviderRaw.toLowerCase(), "AGENT_PROVIDER");
  const baseModel = env("AGENT_MODEL");

  const cache = new Map<string, LlmClient>();
  const clients = {} as Record<PhaseName, LlmClient>;

  for (const phase of Object.keys(PHASE_ENV_PREFIX) as PhaseName[]) {
    const prefix = PHASE_ENV_PREFIX[phase];
    const providerRaw = env(`${prefix}_PROVIDER`);
    const provider = providerRaw
      ? resolveProviderId(providerRaw.toLowerCase(), `${prefix}_PROVIDER`)
      : baseProvider;
    const model = env(`${prefix}_MODEL`) || baseModel;

    if (!model) {
      const spec = PROVIDERS[provider];
      throw new Error(
        `No model configured for the ${phase} phase. Set AGENT_MODEL (used by every phase) ` +
          `or ${prefix}_MODEL, to a model id ${spec.label} accepts -- its current list is at ${spec.modelsUrl}.`
      );
    }

    const key = `${provider}::${model}`;
    let client = cache.get(key);
    if (!client) {
      client = buildClient(provider, model, phase);
      cache.set(key, client);
    }
    clients[phase] = client;
  }

  return clients;
}

/** One line per distinct model in use, for the startup log. */
export function describeClients(clients: Record<PhaseName, LlmClient>): string[] {
  const byModel = new Map<string, PhaseName[]>();
  for (const [phase, client] of Object.entries(clients) as [PhaseName, LlmClient][]) {
    const key = `${client.provider}/${client.model}`;
    byModel.set(key, [...(byModel.get(key) ?? []), phase]);
  }
  return [...byModel].map(([model, phases]) => `${model} (${phases.join(", ")})`);
}
