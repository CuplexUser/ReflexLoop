// src/connectors/manifest.ts
//
// The schema a connector manifest is validated against.
//
// A connector is a JSON file describing a REST API -- base URL, auth, and a list
// of operations -- which the loader turns into ordinary ToolDefinitions. The point
// is that adding a connector stops being a nine-file change (a client module, two
// hand-maintained risk lists, a deliverables switch, a frontend label map) and
// becomes one file, with the risk classification declared next to the operation it
// describes rather than in a list three modules away.
//
// What this layer deliberately cannot express:
//
//   - File-upload deploys. Netlify's sha1 digest manifest and Vercel's file payload
//     aren't a JSON request shape, and pretending otherwise would mean a manifest
//     format that's really a programming language. Those stay native TS in
//     src/integrations/; both kinds of tool look identical to the model.
//   - OAuth refresh flows (Reddit, X, LinkedIn). They need a token round trip before
//     the call. Adding `auth.type: "oauth2_refresh"` later is contained to tools.ts.
//
// Manifests are operator-authored files on disk, at the same trust level as .env.
// The agent never writes one -- "declarative" invites the opposite assumption, so
// it's worth saying plainly.

import { z } from "zod";
import type { ArtifactKind } from "../deliverables.js";

/**
 * Artifact kinds a connector operation may declare. Type-only import above, so this
 * file can be checked against deliverables.ts without a runtime import cycle
 * (deliverables.ts -> load.ts -> manifest.ts).
 */
const ARTIFACT_KINDS = ["site", "repo", "pull_request", "payment_link"] as const;

// Fails to compile if deliverables.ts and this list drift apart.
const _kindsAreArtifactKinds: readonly ArtifactKind[] = ARTIFACT_KINDS;
void _kindsAreArtifactKinds;

/**
 * Parameter types are deliberately few. Each maps to a zod primitive that
 * `z.toJSONSchema` is known to convert cleanly -- smoke-test.ts serializes every
 * registered schema, so a shape that can't be converted fails there rather than as
 * an opaque provider 400 on the first live cycle.
 */
const paramSpec = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean", "enum", "string[]"]),
    /** Where the value goes on the wire. */
    in: z.enum(["path", "query", "body"]),
    /**
     * The provider's own name for this field, when it differs from the tool argument.
     * Lets a manifest expose `priceId` while sending `line_items[0][price]`.
     */
    as: z.string().min(1).optional(),
    required: z.boolean().default(false),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    describe: z.string().optional(),
    /** Allowed values, for `type: "enum"`. */
    values: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export type ParamSpec = z.infer<typeof paramSpec>;

const operationSpec = z
  .object({
    /** Unqualified tool name. The loader applies the `mcp__integrations__` namespace. */
    name: z
      .string()
      .regex(/^[a-z][a-z0-9_]*$/, "must be lower_snake_case, starting with a letter"),
    /**
     * Whether this operation touches the real world. Drives `toolRisk`, so it decides
     * both whether the operation needs an approved proposal naming it and whether it
     * may be dispatched concurrently with other calls in the same turn.
     */
    risk: z.enum(["read", "write"]),
    description: z.string().min(1),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    /** Appended to the connector's baseUrl. `{name}` placeholders take `in: "path"` params. */
    path: z.string().startsWith("/"),
    params: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), paramSpec).default({}),
    /**
     * Output key -> dot-path into the JSON response. This is how an API that nests its
     * link (Cloudflare wraps everything in `{result: ...}`) still satisfies the codebase
     * convention that a write tool returns a top-level `url` -- see tool-output.ts's
     * extractResultUrl, which finds it by field name and not by knowing the tool.
     * Omit it and the whole response body comes back.
     */
    result: z.record(z.string().min(1), z.string().min(1)).optional(),
    /** Declares that this operation produces something browsable, for the Deliverables page. */
    deliverable: z
      .object({
        kind: z.enum(ARTIFACT_KINDS),
        /** Qualifier shown next to the label, e.g. "test mode". */
        detail: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type OperationSpec = z.infer<typeof operationSpec>;

const authSpec = z
  .object({
    type: z.enum(["bearer", "header", "query", "none"]),
    /** Env var holding the credential. Also what decides whether the connector is configured. */
    envVar: z.string().min(1).optional(),
    /** Header name, for `type: "header"` (e.g. "X-Auth-Token"). */
    headerName: z.string().min(1).optional(),
    /** Query parameter name, for `type: "query"` (e.g. "api_key"). */
    queryName: z.string().min(1).optional(),
  })
  .strict();

export const connectorManifest = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().min(1),
    baseUrl: z.string().url(),
    auth: authSpec,
    /** How body params are encoded. Stripe wants form encoding; most others want JSON. */
    encoding: z.enum(["json", "form"]).default("json"),
    defaultHeaders: z.record(z.string().min(1), z.string()).default({}),
    /** Docs link for the operator, carried through to the console. */
    docsUrl: z.string().url().optional(),
    operations: z.array(operationSpec).min(1),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const at = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    if (manifest.auth.type !== "none" && !manifest.auth.envVar) {
      at(["auth", "envVar"], `auth.type "${manifest.auth.type}" needs an envVar`);
    }
    if (manifest.auth.type === "header" && !manifest.auth.headerName) {
      at(["auth", "headerName"], 'auth.type "header" needs a headerName');
    }
    if (manifest.auth.type === "query" && !manifest.auth.queryName) {
      at(["auth", "queryName"], 'auth.type "query" needs a queryName');
    }

    const seen = new Set<string>();
    manifest.operations.forEach((op, i) => {
      if (seen.has(op.name)) at(["operations", i, "name"], `duplicate operation name "${op.name}"`);
      seen.add(op.name);

      const placeholders = [...op.path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((m) => m[1]);
      for (const placeholder of placeholders) {
        const param = op.params[placeholder];
        if (!param) {
          at(["operations", i, "path"], `path placeholder {${placeholder}} has no matching param`);
        } else if (param.in !== "path") {
          at(["operations", i, "params", placeholder, "in"], `must be "path" to fill {${placeholder}}`);
        }
      }

      for (const [name, param] of Object.entries(op.params)) {
        const p = ["operations", i, "params", name];
        if (param.in === "path") {
          if (!placeholders.includes(name)) at([...p, "in"], `no {${name}} placeholder in the path`);
          // A missing path segment would silently produce a request to the wrong URL.
          if (!param.required) at([...p, "required"], "path params must be required");
        }
        if (param.type === "enum" && !param.values?.length) {
          at([...p, "values"], 'type "enum" needs a non-empty values list');
        }
        if (param.type !== "enum" && param.values) {
          at([...p, "values"], 'values is only meaningful for type "enum"');
        }
        if (param.required && param.default !== undefined) {
          at([...p, "default"], "a required param cannot also have a default");
        }
        if (op.method === "GET" && param.in === "body") {
          at([...p, "in"], "GET requests have no body -- use \"query\"");
        }
      }
    });
  });

export type ConnectorManifest = z.infer<typeof connectorManifest>;
