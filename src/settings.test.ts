// The guards, mostly. A settings module that saves a bad value is worse than one that
// doesn't exist: the failure surfaces an hour later on the next cycle, a long way from the
// click that caused it, and for the model settings it surfaces as an opaque provider 404.
//
// The precedence rules get the same attention, because "I edited .env and nothing happened"
// is the confusing failure once a stored value can beat the environment.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSetting,
  getSettingSource,
  initSettings,
  listSettings,
  resetSettings,
  updateSettings,
  validateSetting,
} from "./settings.js";

beforeEach(() => {
  vi.unstubAllEnvs();
  resetSettings();
});

describe("precedence", () => {
  it("falls back to the built-in default when nothing else supplies a value", () => {
    initSettings({});
    expect(getSetting("maxPendingProposals")).toBe(5);
    expect(getSettingSource("maxPendingProposals")).toBe("default");
  });

  it("seeds from the environment when the console has never set the key", () => {
    vi.stubEnv("AGENT_MAX_PENDING_PROPOSALS", "12");
    initSettings({});
    expect(getSetting("maxPendingProposals")).toBe(12);
    expect(getSettingSource("maxPendingProposals")).toBe("environment");
  });

  it("lets a stored value beat the environment, and says so", () => {
    // The confusing case this reporting exists for: .env says 12, the console said 3, and
    // the operator needs to be able to see why editing .env changed nothing.
    vi.stubEnv("AGENT_MAX_PENDING_PROPOSALS", "12");
    initSettings({ stored: { maxPendingProposals: 3 } });
    expect(getSetting("maxPendingProposals")).toBe(3);
    expect(getSettingSource("maxPendingProposals")).toBe("database");
  });

  it("ignores a stored value that no longer validates", () => {
    // A range narrowed in the registry, or a hand-edited row. Same stance as
    // loadControlSettings: fall back rather than refuse to start.
    vi.stubEnv("AGENT_MAX_PENDING_PROPOSALS", "9");
    initSettings({ stored: { maxPendingProposals: -4 } });
    expect(getSetting("maxPendingProposals")).toBe(9);
    expect(getSettingSource("maxPendingProposals")).toBe("environment");
  });

  it("treats an empty env var as unset rather than as an empty value", () => {
    vi.stubEnv("AGENT_MODEL", "   ");
    initSettings({});
    expect(getSetting("llmModel")).toBe("");
    expect(getSettingSource("llmModel")).toBe("default");
  });
});

describe("validation", () => {
  it("rejects a non-numeric integer setting", () => {
    expect(validateSetting("maxPendingProposals", "lots")).toContain("must be a number");
  });

  it("rejects an out-of-range integer at both ends", () => {
    expect(validateSetting("maxPendingProposals", 0)).toContain("at least 1");
    expect(validateSetting("maxPendingProposals", 1000)).toContain("at most 100");
  });

  it("rejects a value outside an enum, and lists what is allowed", () => {
    const error = validateSetting("searchProvider", "google");
    expect(error).toContain("must be one of");
    expect(error).toContain("tavily");
  });

  it("rejects an unknown provider id", () => {
    expect(validateSetting("llmProvider", "definitely-not-a-provider")).toContain("must be one of");
  });

  it("rejects an unknown key outright", () => {
    expect(validateSetting("nonsense" as never, 1)).toContain("is not a setting");
  });

  it("allows empty only where it means 'inherit'", () => {
    // Per-phase overrides fall back to the base model; the base model itself cannot be blank.
    expect(validateSetting("actModel", "")).toBeNull();
    expect(validateSetting("llmModel", "")).toContain("cannot be empty");
  });
});

describe("updateSettings", () => {
  it("persists and reports the new source", () => {
    const saved: Record<string, unknown>[] = [];
    initSettings({ persist: (patch) => saved.push(patch) });

    expect(updateSettings({ maxPendingProposals: 9 }).error).toBeNull();
    expect(getSetting("maxPendingProposals")).toBe(9);
    expect(getSettingSource("maxPendingProposals")).toBe("database");
    expect(saved).toEqual([{ maxPendingProposals: 9 }]);
  });

  it("applies none of a patch when any one value is invalid", () => {
    const saved: Record<string, unknown>[] = [];
    initSettings({ persist: (patch) => saved.push(patch) });

    const { error } = updateSettings({ maxPendingProposals: 7, searchProvider: "google" });
    expect(error).toContain("must be one of");
    // A half-applied model change is a configuration nobody asked for.
    expect(getSetting("maxPendingProposals")).toBe(5);
    expect(saved).toEqual([]);
  });

  it("rolls back and persists nothing when verify fails", () => {
    const saved: Record<string, unknown>[] = [];
    initSettings({ stored: { llmModel: "good-model" }, persist: (patch) => saved.push(patch) });

    // This is the guard field validation structurally cannot provide: "anthropic" is a
    // perfectly valid provider id, and still wrong if ANTHROPIC_API_KEY isn't set.
    const { error } = updateSettings({ llmProvider: "anthropic" }, () => {
      throw new Error("ANTHROPIC_API_KEY is not set");
    });

    expect(error).toContain("ANTHROPIC_API_KEY");
    expect(getSetting("llmProvider")).toBe("openrouter");
    expect(getSetting("llmModel")).toBe("good-model");
    expect(saved).toEqual([]);
  });

  it("commits when verify passes", () => {
    const saved: Record<string, unknown>[] = [];
    initSettings({ persist: (patch) => saved.push(patch) });

    const { error } = updateSettings({ llmProvider: "anthropic", llmModel: "some-model" }, () => null);
    expect(error).toBeNull();
    expect(getSetting("llmProvider")).toBe("anthropic");
    expect(saved).toEqual([{ llmProvider: "anthropic", llmModel: "some-model" }]);
  });

  it("coerces a numeric string, the way an HTML input sends it", () => {
    initSettings({});
    expect(updateSettings({ maxPendingProposals: "8" }).error).toBeNull();
    expect(getSetting("maxPendingProposals")).toBe(8);
  });
});

describe("listSettings", () => {
  it("returns every registered setting with its value and source", () => {
    vi.stubEnv("AGENT_MODEL", "from-env");
    initSettings({ stored: { maxPendingProposals: 2 } });

    const view = listSettings();
    const byKey = new Map(view.map((s) => [s.key, s]));
    expect(byKey.get("llmModel")).toMatchObject({ value: "from-env", source: "environment" });
    expect(byKey.get("maxPendingProposals")).toMatchObject({ value: 2, source: "database" });
    // The page is driven entirely off this, so every setting has to carry its own metadata.
    expect(view.every((s) => s.label && s.help && s.group && s.envVar)).toBe(true);
  });
});
