// Two things are tested here, and they fail in different ways.
//
// The manifest schema is the only thing standing between a typo and a connector that
// looks registered and quietly calls the wrong URL -- an unsubstituted `{zoneId}` in a
// path, a param declared in the wrong place. Those are cheap to catch and expensive to
// notice later, so each one gets a case.
//
// The loader itself is exercised through AGENT_CONNECTORS_DIR against real files in a
// temp dir, because the interesting failures (a duplicate operation name across two
// manifests, a malformed file) only exist once there is more than one file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectorManifest } from "./manifest.js";
import { CONNECTORS, configuredConnectorTools, isConfigured } from "./load.js";

const validOperation = {
  name: "example_read_thing",
  risk: "read",
  description: "Reads a thing.",
  method: "GET",
  path: "/things",
};

const validManifest = {
  id: "example",
  label: "Example",
  baseUrl: "https://api.example.com",
  auth: { type: "bearer", envVar: "EXAMPLE_TOKEN" },
  operations: [validOperation],
};

function errorsFor(patch: Record<string, unknown>): string {
  const parsed = connectorManifest.safeParse({ ...validManifest, ...patch });
  if (parsed.success) return "";
  return parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ");
}

describe("manifest schema", () => {
  it("accepts a minimal well-formed manifest", () => {
    expect(connectorManifest.safeParse(validManifest).success).toBe(true);
  });

  it("refuses a path placeholder with no matching param", () => {
    const errors = errorsFor({
      operations: [{ ...validOperation, path: "/zones/{zoneId}/records" }],
    });
    expect(errors).toContain("{zoneId} has no matching param");
  });

  it("refuses an optional path param -- a missing segment would build a wrong URL", () => {
    const errors = errorsFor({
      operations: [
        {
          ...validOperation,
          path: "/zones/{zoneId}",
          params: { zoneId: { type: "string", in: "path" } },
        },
      ],
    });
    expect(errors).toContain("path params must be required");
  });

  it("refuses a body param on a GET", () => {
    const errors = errorsFor({
      operations: [
        { ...validOperation, params: { q: { type: "string", in: "body" } } },
      ],
    });
    expect(errors).toContain('GET requests have no body -- use "query"');
  });

  it("refuses an enum with no values", () => {
    const errors = errorsFor({
      operations: [{ ...validOperation, params: { mode: { type: "enum", in: "query" } } }],
    });
    expect(errors).toContain('type "enum" needs a non-empty values list');
  });

  it("refuses auth that names no env var", () => {
    expect(errorsFor({ auth: { type: "bearer" } })).toContain("needs an envVar");
    expect(errorsFor({ auth: { type: "header", envVar: "X" } })).toContain("needs a headerName");
  });

  it("refuses two operations with the same name in one manifest", () => {
    const errors = errorsFor({ operations: [validOperation, validOperation] });
    expect(errors).toContain('duplicate operation name "example_read_thing"');
  });

  it("refuses an unknown top-level key rather than ignoring it", () => {
    // A misspelled "operation" would otherwise produce a connector with no tools and
    // no complaint.
    expect(errorsFor({ opperations: [] })).not.toBe("");
  });
});

describe("bundled connectors", () => {
  it("declares an env var for every connector that needs one", () => {
    for (const { manifest } of CONNECTORS) {
      if (manifest.auth.type !== "none") expect(manifest.auth.envVar).toBeTruthy();
    }
  });

  it("reads configuration from the environment at call time, not at import", () => {
    const stripe = CONNECTORS.find((c) => c.manifest.id === "stripe");
    expect(stripe).toBeDefined();
    const manifest = stripe!.manifest;

    delete process.env.STRIPE_API_KEY;
    expect(isConfigured(manifest)).toBe(false);
    expect(configuredConnectorTools()).not.toContain("mcp__integrations__stripe_list_products");

    process.env.STRIPE_API_KEY = "sk_test_1";
    expect(isConfigured(manifest)).toBe(true);
    expect(configuredConnectorTools()).toContain("mcp__integrations__stripe_list_products");
  });
});

describe("loading from AGENT_CONNECTORS_DIR", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reflexloop-connectors-"));
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.AGENT_CONNECTORS_DIR;
    rmSync(dir, { recursive: true, force: true });
    vi.resetModules();
  });

  const write = (file: string, contents: unknown) =>
    writeFileSync(join(dir, file), typeof contents === "string" ? contents : JSON.stringify(contents));

  // resetModules in beforeEach is what makes this a fresh evaluation: load.ts does its
  // work at module scope, so re-importing it is the only way to load a different set of
  // manifests.
  async function loadFrom(): Promise<typeof import("./load.js")> {
    process.env.AGENT_CONNECTORS_DIR = dir;
    return import("./load.js");
  }

  it("picks up an operator's own manifest alongside the bundled ones", async () => {
    write("custom.json", {
      ...validManifest,
      id: "custom",
      operations: [{ ...validOperation, name: "custom_read_thing" }],
    });

    const loaded = await loadFrom();
    expect(loaded.CONNECTOR_ERRORS).toEqual([]);
    expect(loaded.CONNECTOR_READ_TOOLS).toContain("mcp__integrations__custom_read_thing");
    // Bundled connectors are still there.
    expect(loaded.CONNECTOR_READ_TOOLS).toContain("mcp__integrations__stripe_list_products");
  });

  it("refuses an operation name a bundled connector already owns, naming the owner", async () => {
    write("clash.json", {
      ...validManifest,
      id: "clash",
      operations: [{ ...validOperation, name: "stripe_list_products" }],
    });

    const loaded = await loadFrom();
    // ToolRegistry would throw "Duplicate tool name" at startup with no clue which two
    // files disagree; this is the same refusal with the answer attached.
    expect(loaded.CONNECTOR_ERRORS).toHaveLength(1);
    expect(loaded.CONNECTOR_ERRORS[0].message).toContain('operation "stripe_list_products" is already defined by');
    expect(loaded.CONNECTOR_ERRORS[0].message).toContain("stripe.json");
  });

  it("skips a malformed manifest instead of taking the process down with it", async () => {
    write("broken.json", "{ not json");
    write("fine.json", {
      ...validManifest,
      id: "fine",
      operations: [{ ...validOperation, name: "fine_read_thing" }],
    });

    const loaded = await loadFrom();
    expect(loaded.CONNECTOR_ERRORS).toHaveLength(1);
    expect(loaded.CONNECTOR_ERRORS[0].source).toContain("broken.json");
    expect(loaded.CONNECTOR_READ_TOOLS).toContain("mcp__integrations__fine_read_thing");
  });

  it("records a schema violation as a load error with the offending path", async () => {
    write("bad.json", {
      ...validManifest,
      id: "bad",
      operations: [{ ...validOperation, name: "bad_read_thing", risk: "destroy" }],
    });

    const loaded = await loadFrom();
    expect(loaded.CONNECTOR_ERRORS).toHaveLength(1);
    expect(loaded.CONNECTOR_ERRORS[0].message).toContain("operations.0.risk");
  });
});
