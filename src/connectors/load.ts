// src/connectors/load.ts
//
// Reads connector manifests off disk and validates them, once, at module load.
//
// Two directories: the manifests bundled with the project (src/connectors/defs),
// and whatever AGENT_CONNECTORS_DIR points at, so an operator can add a connector
// without touching the repo. Bundled ones load first; a duplicate operation name
// from either source is refused with both filenames named, because the alternative
// is ToolRegistry throwing "Duplicate tool name: x" at startup with no clue which
// two files disagree.
//
// A malformed manifest is skipped rather than fatal, and recorded in
// CONNECTOR_ERRORS. Killing the process would mean one typo in an operator's own
// connector file takes down the console, which is where they'd go to find out what
// broke. smoke-test.ts asserts CONNECTOR_ERRORS is empty, so a broken *bundled*
// manifest still fails the build rather than quietly shipping.
//
// Nothing here reads a credential. `isConfigured` is a function rather than a
// captured boolean on purpose: a key that appears after startup (an operator
// filling it in) has to take effect without a restart, and a module-level const
// would freeze the answer at import time.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectorManifest, type ConnectorManifest, type OperationSpec } from "./manifest.js";

/** Same namespace the native integration tools carry. See tools/registry.ts. */
export const CONNECTOR_PREFIX = "mcp__integrations__";

export interface LoadedOperation {
  /** Fully-qualified tool name, e.g. "mcp__integrations__stripe_create_payment_link". */
  toolName: string;
  spec: OperationSpec;
  connector: ConnectorManifest;
}

export interface LoadedConnector {
  manifest: ConnectorManifest;
  /** Manifest filename, for error messages. */
  source: string;
  operations: LoadedOperation[];
}

export interface ConnectorLoadError {
  source: string;
  message: string;
}

const BUNDLED_DIR = join(dirname(fileURLToPath(import.meta.url)), "defs");

function manifestFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    // A missing bundled dir means no connectors; a missing AGENT_CONNECTORS_DIR is
    // the operator's typo. Either way it's a load error, not a crash.
    return [];
  }
}

function load(): { connectors: LoadedConnector[]; errors: ConnectorLoadError[] } {
  const connectors: LoadedConnector[] = [];
  const errors: ConnectorLoadError[] = [];
  const claimedTools = new Map<string, string>();
  const claimedIds = new Map<string, string>();

  const dirs = [BUNDLED_DIR, ...(process.env.AGENT_CONNECTORS_DIR ? [process.env.AGENT_CONNECTORS_DIR] : [])];

  for (const file of dirs.flatMap(manifestFiles)) {
    let manifest: ConnectorManifest;
    try {
      const parsed = connectorManifest.safeParse(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed.success) {
        errors.push({
          source: file,
          message: parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; "),
        });
        continue;
      }
      manifest = parsed.data;
    } catch (err) {
      errors.push({ source: file, message: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const idOwner = claimedIds.get(manifest.id);
    if (idOwner) {
      errors.push({ source: file, message: `connector id "${manifest.id}" is already defined by ${idOwner}` });
      continue;
    }

    const clash = manifest.operations.find((op) => claimedTools.has(`${CONNECTOR_PREFIX}${op.name}`));
    if (clash) {
      const owner = claimedTools.get(`${CONNECTOR_PREFIX}${clash.name}`);
      errors.push({ source: file, message: `operation "${clash.name}" is already defined by ${owner}` });
      continue;
    }

    claimedIds.set(manifest.id, file);
    const operations = manifest.operations.map((spec) => ({
      toolName: `${CONNECTOR_PREFIX}${spec.name}`,
      spec,
      connector: manifest,
    }));
    for (const op of operations) claimedTools.set(op.toolName, file);
    connectors.push({ manifest, source: file, operations });
  }

  return { connectors, errors };
}

const loaded = load();

export const CONNECTORS: LoadedConnector[] = loaded.connectors;
export const CONNECTOR_ERRORS: ConnectorLoadError[] = loaded.errors;

for (const err of CONNECTOR_ERRORS) {
  console.error(`[connectors] ignoring ${err.source}: ${err.message}`);
}

export const CONNECTOR_OPERATIONS: LoadedOperation[] = CONNECTORS.flatMap((c) => c.operations);

/** Fully-qualified names by risk. Every operation, configured or not -- see tool-catalog.ts. */
export const CONNECTOR_READ_TOOLS = CONNECTOR_OPERATIONS.filter((o) => o.spec.risk === "read").map(
  (o) => o.toolName
);
export const CONNECTOR_WRITE_TOOLS = CONNECTOR_OPERATIONS.filter((o) => o.spec.risk === "write").map(
  (o) => o.toolName
);

const byToolName = new Map(CONNECTOR_OPERATIONS.map((o) => [o.toolName, o]));

export function connectorOperation(toolName: string): LoadedOperation | undefined {
  return byToolName.get(toolName);
}

/** Whether the credential this connector needs is present *right now*. */
export function isConfigured(manifest: ConnectorManifest): boolean {
  if (manifest.auth.type === "none") return true;
  return Boolean(manifest.auth.envVar && process.env[manifest.auth.envVar]);
}

/**
 * The connector tools worth telling the model about this cycle. Callers recompute
 * per cycle / per request rather than caching, so a credential added while the loop
 * is running takes effect on the next cycle instead of the next restart.
 */
export function configuredConnectorTools(): string[] {
  return CONNECTOR_OPERATIONS.filter((o) => isConfigured(o.connector)).map((o) => o.toolName);
}

export interface ConnectorStatus {
  id: string;
  label: string;
  configured: boolean;
  envVar: string | null;
  docsUrl: string | null;
  operations: { name: string; toolName: string; risk: "read" | "write"; description: string }[];
}

/** What the console shows: which connectors exist, and which are missing a key. */
export function connectorStatus(): ConnectorStatus[] {
  return CONNECTORS.map(({ manifest, operations }) => ({
    id: manifest.id,
    label: manifest.label,
    configured: isConfigured(manifest),
    envVar: manifest.auth.envVar ?? null,
    docsUrl: manifest.docsUrl ?? null,
    operations: operations.map((o) => ({
      name: o.spec.name,
      toolName: o.toolName,
      risk: o.spec.risk,
      description: o.spec.description,
    })),
  }));
}
