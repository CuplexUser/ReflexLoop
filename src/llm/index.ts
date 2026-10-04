// src/llm/index.ts
//
// Resolves the LlmClient(s) the phases run on. Phases take a client as a parameter,
// so a phase can never quietly reach for a model other than the one the operator
// configured for it -- and they take it from `getLlmClients()` at the moment they
// start, so a model changed in the console applies to the next phase rather than the
// next process.
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
//
// Behind each phase's model sit up to two **fallback** models (AGENT_FALLBACK_* and
// AGENT_FALLBACK2_*, also settings), shared by every phase. So each phase resolves to a
// chain -- its own model, then fallback 1, then fallback 2, duplicates dropped -- and
// `createPhaseClient` wraps that chain in a FailoverClient (failover.ts) for one phase run.

import { getSetting } from "../settings.js";
import { AnthropicClient } from "./anthropic.js";
import { FailoverClient, type FailoverInfo } from "./failover.js";
import { OpenAiCompatibleClient } from "./openai-compatible.js";
import { PROVIDERS, PROVIDER_IDS, isProviderId } from "./providers.js";
import type { LlmClient, ProviderId } from "./types.js";

export * from "./types.js";
export { PROVIDERS, PROVIDER_IDS } from "./providers.js";
export { priceUsage, lookupPrice } from "./pricing.js";
export type { FailoverInfo } from "./failover.js";

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

/** The fallback slots, in the order they are tried. */
const FALLBACK_SLOTS = [
  { provider: "fallbackProvider", model: "fallbackModel", label: "Fallback 1" },
  { provider: "fallback2Provider", model: "fallback2Model", label: "Fallback 2" },
] as const;

/** Per-phase override settings, and the env var each one seeds from (used only in error text). */
const PHASE_OVERRIDES: Record<PhaseName, { provider: "researchProvider" | "actProvider" | "reflectProvider"; model: "researchModel" | "actModel" | "reflectModel"; envPrefix: string }> = {
  research_plan: { provider: "researchProvider", model: "researchModel", envPrefix: "AGENT_RESEARCH" },
  act: { provider: "actProvider", model: "actModel", envPrefix: "AGENT_ACT" },
  reflect: { provider: "reflectProvider", model: "reflectModel", envPrefix: "AGENT_REFLECT" },
};

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** `who` names what asked for this client (a phase, or a fallback slot) in the missing-key error. */
function buildClient(providerId: ProviderId, model: string, who: string): LlmClient {
  const spec = PROVIDERS[providerId];

  const apiKey = env(spec.apiKeyEnv);
  if (!apiKey) {
    throw new Error(
      `${who} is configured to use ${spec.label}, which needs ${spec.apiKeyEnv} set in .env (see .env.example).`
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
 * One chain of clients per phase: the phase's own model first, then the fallbacks. Phases
 * that resolve to the same provider+model share an instance -- clients are stateless, and
 * sharing keeps the startup log honest about how many distinct models are actually in play.
 * Failover state lives in the per-run FailoverClient, never on these.
 */
export function resolveLlmClients(): Record<PhaseName, LlmClient[]> {
  const baseProviderRaw = getSetting("llmProvider") || DEFAULT_PROVIDER;
  const baseProvider = resolveProviderId(baseProviderRaw.toLowerCase(), "Provider");
  const baseModel = getSetting("llmModel").trim();

  const cache = new Map<string, LlmClient>();
  const clientFor = (provider: ProviderId, model: string, who: string): LlmClient => {
    const key = `${provider}::${model}`;
    let client = cache.get(key);
    if (!client) {
      client = buildClient(provider, model, who);
      cache.set(key, client);
    }
    return client;
  };

  // Resolved once, outside the phase loop, so a broken slot is reported once and by its own name.
  const fallbacks: { provider: ProviderId; model: string }[] = [];
  for (const slot of FALLBACK_SLOTS) {
    const providerRaw = getSetting(slot.provider).trim();
    const model = getSetting(slot.model).trim();
    if (!model) {
      // A provider with no model would otherwise be silently ignored, and the operator would
      // believe they had a backup they don't.
      if (providerRaw) throw new Error(`${slot.label} has a provider but no model. Set its model, or clear the provider.`);
      continue;
    }
    const provider = providerRaw ? resolveProviderId(providerRaw.toLowerCase(), `${slot.label} provider`) : baseProvider;
    // Built here rather than on first use so a fallback with no API key fails at save time, not
    // in the middle of the outage it was meant to cover.
    clientFor(provider, model, slot.label);
    fallbacks.push({ provider, model });
  }

  const chains = {} as Record<PhaseName, LlmClient[]>;

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

    const chain = [clientFor(provider, model, `The ${phase} phase`)];
    for (const fallback of fallbacks) {
      const client = clientFor(fallback.provider, fallback.model, `The ${phase} phase`);
      if (!chain.includes(client)) chain.push(client);
    }
    chains[phase] = chain;
  }

  return chains;
}

/** Every setting `resolveLlmClients` reads, so a change to any of them invalidates the cache. */
const MODEL_SETTING_KEYS = [
  "llmProvider",
  "llmModel",
  ...Object.values(PHASE_OVERRIDES).flatMap((o) => [o.provider, o.model]),
  ...FALLBACK_SLOTS.flatMap((slot) => [slot.provider, slot.model]),
] as const;

let cached: { signature: string; clients: Record<PhaseName, LlmClient[]> } | null = null;

/**
 * The clients a phase should run on *right now*.
 *
 * Same self-invalidating shape as `getSearchConfig()`, and for the same reason: a settings
 * change has to reach the loop without a restart, and hanging that on a change notification
 * means the loop keeps a stale model whenever the notification doesn't arrive -- a failure
 * with no symptom except the model quietly not being the one the console says it is.
 * Resolving from the current settings at the moment a phase starts has no such gap; the cache
 * only exists so this isn't rebuilt per call, and it is keyed on the settings themselves.
 *
 * A phase already running keeps the client it started with -- the caller reads this once, at
 * the top of the phase. Changing model mid-phase would leave one transcript split across two.
 */
export function getLlmClients(): Record<PhaseName, LlmClient[]> {
  const signature = MODEL_SETTING_KEYS.map((key) => getSetting(key)).join(" ");
  if (!cached || cached.signature !== signature) {
    cached = { signature, clients: resolveLlmClients() };
  }
  return cached.clients;
}

/**
 * The client one phase run talks to: its chain from the current settings, wrapped so a failing
 * model hands over to the next. A fresh wrapper per run, because which model is active is state
 * of *this* run -- research and a deep dive run concurrently, and one failing over must not move
 * the other.
 */
export function createPhaseClient(phase: PhaseName, onFailover?: (info: FailoverInfo) => void): LlmClient {
  return new FailoverClient(getLlmClients()[phase], onFailover);
}

/** One line per distinct chain in use, for the startup log. */
export function describeClients(chains: Record<PhaseName, LlmClient[]>): string[] {
  const byChain = new Map<string, PhaseName[]>();
  for (const [phase, chain] of Object.entries(chains) as [PhaseName, LlmClient[]][]) {
    const key = chain.map((client) => `${client.provider}/${client.model}`).join(" -> ");
    byChain.set(key, [...(byChain.get(key) ?? []), phase]);
  }
  return [...byChain].map(([models, phases]) => `${models} (${phases.join(", ")})`);
}
