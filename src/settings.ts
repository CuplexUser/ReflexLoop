// src/settings.ts
//
// Operator settings that used to require a .env edit and a restart.
//
// The rule that makes this work, and the one to keep: **read at use, not at module
// load.** Most of this codebase captures `process.env.X` into a module-level const,
// which freezes the answer at import time -- so a setting that "saved" would appear
// to change nothing until a restart, which is worse than not moving it at all. Every
// consumer here calls `getSetting()` at the point of use instead.
//
// Same shape as agent-control.ts, deliberately: in-memory state plus an injected
// `persist` callback, importing nothing from MemoryStore. That keeps this module
// dependency-free, keeps it from being able to read anything else out of the
// database, and means console-only mode can write these through its own narrow
// writer rather than being handed the store.
//
// **What is deliberately NOT here.** Credentials -- provider keys, GITHUB_TOKEN,
// connector keys -- stay in .env. Putting them in data/agent.db would mean plaintext
// secrets in a file that console-only mode also opens, that gets copied into
// agent.db.bak-* next to it, and that gets handed around as "the database": today a
// leaked DB costs you the agent's memory, afterwards it would cost you a Stripe key.
// Bootstrap settings (AGENT_DB_PATH, the port, the bind host, AGENT_API_TOKEN) can't
// move either -- you need the database before you can read settings out of it, and
// the API token gates the very console that would edit it.
//
// Precedence is **stored value > environment > default**, and `source` on each
// setting reports which one won. That matters: once a stored value beats .env, an
// operator editing .env and seeing nothing happen is the confusing failure mode --
// the same one AGENT_DOMAINS already has.

import { EventEmitter } from "node:events";
import { PROVIDER_IDS } from "./llm/providers.js";

export const SEARCH_MODES = ["auto", "tavily", "brave", "native", "none"] as const;

/**
 * Every setting that can be changed from the console. Adding one here is most of the
 * work: the API, the source reporting and the settings page are all driven off this.
 */
export interface SettingsValues {
  maxPendingProposals: number;
  searchProvider: (typeof SEARCH_MODES)[number];
  llmProvider: string;
  llmModel: string;
  /** Per-phase overrides. "" means "inherit the base provider/model" -- see llm/index.ts. */
  researchProvider: string;
  researchModel: string;
  actProvider: string;
  actModel: string;
  reflectProvider: string;
  reflectModel: string;
}

export type SettingKey = keyof SettingsValues;

export type SettingGroup = "loop" | "search" | "model";

export interface SettingSpec {
  key: SettingKey;
  label: string;
  help: string;
  group: SettingGroup;
  type: "integer" | "string" | "enum";
  /** The env var this seeds from, and what an operator would have edited before. */
  envVar: string;
  options?: readonly string[];
  min?: number;
  max?: number;
  /** True when "" is meaningful (a per-phase override that falls back to the base setting). */
  allowsEmpty?: boolean;
}

export const SETTINGS: readonly SettingSpec[] = [
  {
    key: "maxPendingProposals",
    label: "Max pending proposals",
    help:
      "Research skips its turn while this many proposals are already awaiting your decision. " +
      "A throttle on the queue, not on the agent -- approved work still runs.",
    group: "loop",
    type: "integer",
    envVar: "AGENT_MAX_PENDING_PROPOSALS",
    min: 1,
    max: 100,
  },
  {
    key: "searchProvider",
    label: "Search provider",
    help:
      "How WebSearch is performed. 'auto' picks the first usable: Tavily, then Brave, then the " +
      "model provider's own server-side search. 'native' uses that server-side search directly; " +
      "'none' leaves research with WebFetch only. Tavily and Brave need their key in .env.",
    group: "search",
    type: "enum",
    envVar: "AGENT_SEARCH_PROVIDER",
    options: SEARCH_MODES,
  },
  {
    key: "llmProvider",
    label: "Provider",
    help: "Which model API every phase uses unless overridden below. Its key must be set in .env.",
    group: "model",
    type: "enum",
    envVar: "AGENT_PROVIDER",
    options: PROVIDER_IDS,
  },
  {
    key: "llmModel",
    label: "Model",
    help:
      "Model id, exactly as the provider names it. There is deliberately no default -- providers " +
      "rename and retire models constantly, and a stale one fails at the first API call.",
    group: "model",
    type: "string",
    envVar: "AGENT_MODEL",
  },
  {
    key: "researchProvider",
    label: "Research provider",
    help: "Leave empty to use the base provider.",
    group: "model",
    type: "enum",
    envVar: "AGENT_RESEARCH_PROVIDER",
    options: PROVIDER_IDS,
    allowsEmpty: true,
  },
  {
    key: "researchModel",
    label: "Research model",
    help: "Research is long and wide; a cheaper model is often the right call. Empty inherits the base model.",
    group: "model",
    type: "string",
    envVar: "AGENT_RESEARCH_MODEL",
    allowsEmpty: true,
  },
  {
    key: "actProvider",
    label: "Act provider",
    help: "Leave empty to use the base provider.",
    group: "model",
    type: "enum",
    envVar: "AGENT_ACT_PROVIDER",
    options: PROVIDER_IDS,
    allowsEmpty: true,
  },
  {
    key: "actModel",
    label: "Act model",
    help:
      "Act writes real code into real repos with no build step to catch a mistake -- this is where " +
      "your best model earns its cost. Empty inherits the base model.",
    group: "model",
    type: "string",
    envVar: "AGENT_ACT_MODEL",
    allowsEmpty: true,
  },
  {
    key: "reflectProvider",
    label: "Reflect provider",
    help: "Leave empty to use the base provider.",
    group: "model",
    type: "enum",
    envVar: "AGENT_REFLECT_PROVIDER",
    options: PROVIDER_IDS,
    allowsEmpty: true,
  },
  {
    key: "reflectModel",
    label: "Reflect model",
    help: "Reflect is two short memory calls. Empty inherits the base model.",
    group: "model",
    type: "string",
    envVar: "AGENT_REFLECT_MODEL",
    allowsEmpty: true,
  },
];

const SPEC_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** Used when neither a stored value nor an env var supplies one. */
const DEFAULTS: SettingsValues = {
  maxPendingProposals: 5,
  searchProvider: "auto",
  llmProvider: "openrouter",
  // Empty on purpose. AGENT_MODEL has no default anywhere in this project: a baked-in
  // model id fails at the first API call with an opaque 404 instead of at startup with
  // a message naming the provider's model list.
  llmModel: "",
  researchProvider: "",
  researchModel: "",
  actProvider: "",
  actModel: "",
  reflectProvider: "",
  reflectModel: "",
};

export type SettingSource = "database" | "environment" | "default";

const bus = new EventEmitter();
bus.setMaxListeners(20);

let values: SettingsValues = { ...DEFAULTS };
let sources = new Map<SettingKey, SettingSource>();
let persist: (patch: Partial<SettingsValues>) => void = () => {};
let initialized = false;

function coerce(spec: SettingSpec, raw: unknown): unknown {
  if (spec.type === "integer") {
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return typeof raw === "string" ? raw.trim() : undefined;
}

/**
 * Why a value is rejected, or null when it's fine. Returned to the console as a 400 rather
 * than being applied and failing an hour later on the next cycle -- which is what moving
 * model selection out of startup validation would otherwise cost.
 */
export function validateSetting(key: SettingKey, raw: unknown): string | null {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) return `"${key}" is not a setting.`;

  const value = coerce(spec, raw);
  if (value === undefined) return `${spec.label} must be ${spec.type === "integer" ? "a number" : "a string"}.`;

  if (spec.type === "integer") {
    const n = value as number;
    if (spec.min !== undefined && n < spec.min) return `${spec.label} must be at least ${spec.min}.`;
    if (spec.max !== undefined && n > spec.max) return `${spec.label} must be at most ${spec.max}.`;
    return null;
  }

  const text = value as string;
  if (text === "") {
    return spec.allowsEmpty ? null : `${spec.label} cannot be empty.`;
  }
  if (spec.options && !spec.options.includes(text)) {
    return `${spec.label} must be one of: ${spec.options.join(", ")}.`;
  }
  return null;
}

function applyRaw(key: SettingKey, raw: unknown): boolean {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec || validateSetting(key, raw) !== null) return false;
  (values as unknown as Record<string, unknown>)[key] = coerce(spec, raw);
  return true;
}

/**
 * Called once at startup with whatever the console previously saved. Env seeds a key the
 * console has never set; a stored value wins after that, which is the same precedence
 * domains/interval/pause have had since they moved.
 */
export function initSettings(opts: {
  stored?: Partial<Record<string, unknown>>;
  persist?: (patch: Partial<SettingsValues>) => void;
}): void {
  values = { ...DEFAULTS };
  sources = new Map();

  for (const spec of SETTINGS) {
    const stored = opts.stored?.[spec.key];
    if (stored !== undefined && applyRaw(spec.key, stored)) {
      sources.set(spec.key, "database");
      continue;
    }
    const fromEnv = process.env[spec.envVar];
    if (fromEnv !== undefined && fromEnv.trim() !== "" && applyRaw(spec.key, fromEnv)) {
      sources.set(spec.key, "environment");
      continue;
    }
    sources.set(spec.key, "default");
  }

  // Assigned last so seeding the initial state doesn't write it straight back out.
  persist = opts.persist ?? (() => {});
  initialized = true;
}

/**
 * Every entry point that isn't the orchestrator -- vitest, smoke-test, a script -- reads
 * settings without ever calling initSettings. Falling back to env+defaults on first read
 * keeps those working and keeps this module's behaviour identical to the direct
 * `process.env` reads it replaced.
 */
function ensureInitialized(): void {
  if (!initialized) initSettings({});
}

export function getSetting<K extends SettingKey>(key: K): SettingsValues[K] {
  ensureInitialized();
  return values[key];
}

export function getSettingSource(key: SettingKey): SettingSource {
  ensureInitialized();
  return sources.get(key) ?? "default";
}

/**
 * Applies a patch, or applies none of it.
 *
 * Three guards, in order, because per-field validation is not enough on its own:
 *
 *  1. **Per field**, against the registry -- type, range, enum membership, emptiness.
 *  2. **All or nothing.** A half-applied model change (new provider, old model) is a
 *     configuration nobody asked for, and it would fail on the next cycle rather than at
 *     the click that caused it.
 *  3. **`verify`**, run against the *already-applied* state and rolled back if it fails.
 *     This is the one that catches what field validation structurally cannot: a provider
 *     that is spelled correctly but has no API key in .env, or a search mode that needs a
 *     key nobody set. The caller supplies it (server.ts re-resolves the LLM clients and
 *     the search config), which keeps this module free of imports from llm/ and search/.
 *
 * Moving model selection out of startup was the risky half of this whole change: startup
 * validation produced a good error naming the provider's model list, and without (3) the
 * equivalent mistake made from the console would surface an hour later as an opaque 404.
 */
export function updateSettings(
  patch: Partial<Record<string, unknown>>,
  verify?: () => string | null
): { error: string | null } {
  ensureInitialized();

  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  for (const [key, value] of entries) {
    const error = validateSetting(key as SettingKey, value);
    if (error) return { error };
  }

  const previousValues = { ...values };
  const previousSources = new Map(sources);

  const applied: Partial<SettingsValues> = {};
  for (const [key, value] of entries) {
    const settingKey = key as SettingKey;
    if (applyRaw(settingKey, value)) {
      sources.set(settingKey, "database");
      (applied as Record<string, unknown>)[settingKey] = values[settingKey];
    }
  }

  if (Object.keys(applied).length === 0) return { error: null };

  if (verify) {
    let failure: string | null = null;
    try {
      failure = verify();
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    if (failure) {
      values = previousValues;
      sources = previousSources;
      // The rollback has to be announced too: a verifier that caches (resolveLlmClients,
      // getSearchConfig) may have rebuilt itself from the rejected state on the way past.
      bus.emit("changed", applied);
      return { error: failure };
    }
  }

  persist(applied);
  bus.emit("changed", applied);
  return { error: null };
}

export interface SettingView extends SettingSpec {
  value: string | number;
  source: SettingSource;
}

/** What the console renders. Driven off the registry so a new setting needs no UI change. */
export function listSettings(): SettingView[] {
  ensureInitialized();
  return SETTINGS.map((spec) => ({ ...spec, value: values[spec.key], source: getSettingSource(spec.key) }));
}

/**
 * Fires after any successful update, with the keys that actually changed. Consumers use it
 * to drop whatever they cached from a setting -- the LLM clients, the search config -- so
 * "no restart needed" is true rather than merely intended.
 */
export function onSettingsChanged(listener: (changed: Partial<SettingsValues>) => void): void {
  bus.on("changed", listener);
}

/** Test seam: forgets everything, so the next read re-seeds from the current environment. */
export function resetSettings(): void {
  initialized = false;
  persist = () => {};
  bus.removeAllListeners("changed");
}
