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
//
// All ten of those are now *settings* (settings.ts) rather than direct env reads, so
// they can be changed from the console without a restart -- the env vars above are
// what they seed from, and still what they fall back to. API keys deliberately did not
// move: they stay in .env, so `buildClient` still reads the environment for those.
// `resolveLlmClients()` is therefore called again on a settings change, and its throw
// on a missing key is what the console's save-time verification catches.

import { getSetting } from "../settings.js";
import { AnthropicClient } from "./anthropic.js";
import { OpenAiCompatibleClient } from "./openai-compatible.js";
import { PROVIDERS, PROVIDER_IDS, isProviderId } from "./providers.js";
import type { LlmClient, ProviderId } from "./types.js";

export * from "./types.js";
export { PROVIDERS, PROVIDER_IDS } from "./providers.js";
export { priceUsage, lookupPrice } from "./pricing.js";

const DEFAULT_PROVIDER = "openrouter";

/**
 * Reads a positive-integer env var, falling back to `fallback` for anything that isn't one.
 *
 * `??` alone is not enough here: a var that is present but *empty* -- `AGENT_MAX_TOKENS=` in
 * a .env, which is how .env.example ships it -- is `""`, not `undefined`, so the default never
 * applies and `Number("")` is 0. That shipped a `max_tokens: 0` on every single model call.
 * OpenRouter happens to ignore it, which is the only reason it went unnoticed; a provider that
 * honours it would cap every response at nothing.
 */
function positiveIntEnv(name: string, fallback: number): number {
  const parsed = Number((process.env[name] ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Output cap per model call.
 *
 * 8192 was the documented default and it is **not** enough: the largest successful act-phase
 * commit in this agent's own history is a ~55k-character `github_commit_files` call, roughly
 * 16k output tokens, and the whole point of the act phase is writing whole files in one call.
 * It only ever worked because the bug above sent `max_tokens: 0` and OpenRouter ignored it --
 * fixing the coercion without raising this would have turned a dormant bug into a live one
 * that truncates every real build.
 *
 * 32768 clears the observed high-water mark with room to spare and is at or under the output
 * limit of every model in providers.ts. OpenRouter clamps a too-large value to the model's own
 * maximum rather than erroring; lower it here if you point the loop at a provider that doesn't.
 */
export const MAX_OUTPUT_TOKENS = positiveIntEnv("AGENT_MAX_TOKENS", 32768);

/** The three phases that call a model. Matches the `phase` column in `runs`. */
export type PhaseName = "research_plan" | "act" | "reflect";

/** Per-phase override settings, and the env var each one seeds from (used only in error text). */
const PHASE_OVERRIDES: Record<PhaseName, { provider: "researchProvider" | "actProvider" | "reflectProvider"; model: "researchModel" | "actModel" | "reflectModel"; envPrefix: string }> = {
  research_plan: { provider: "researchProvider", model: "researchModel", envPrefix: "AGENT_RESEARCH" },
  act: { provider: "actProvider", model: "actModel", envPrefix: "AGENT_ACT" },
  reflect: { provider: "reflectProvider", model: "reflectModel", envPrefix: "AGENT_REFLECT" },
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
  const baseProviderRaw = getSetting("llmProvider") || DEFAULT_PROVIDER;
  const baseProvider = resolveProviderId(baseProviderRaw.toLowerCase(), "Provider");
  const baseModel = getSetting("llmModel").trim();

  const cache = new Map<string, LlmClient>();
  const clients = {} as Record<PhaseName, LlmClient>;

  for (const phase of Object.keys(PHASE_OVERRIDES) as PhaseName[]) {
    const override = PHASE_OVERRIDES[phase];
    const providerRaw = getSetting(override.provider).trim();
    const provider = providerRaw
      ? resolveProviderId(providerRaw.toLowerCase(), `${override.envPrefix}_PROVIDER`)
      : baseProvider;
    const model = getSetting(override.model).trim() || baseModel;

    if (!model) {
      const spec = PROVIDERS[provider];
      throw new Error(
        `No model configured for the ${phase} phase. Set the base model (used by every phase) ` +
          `or the ${phase} override, to a model id ${spec.label} accepts -- its current list is at ${spec.modelsUrl}.`
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
