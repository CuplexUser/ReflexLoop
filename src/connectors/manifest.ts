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
//   - OAuth token round trips (Reddit, X, LinkedIn, Google Search Console). They need a
//     token fetched before the call, and the user-delegated ones a consent screen on top.
//     Adding `auth.type: "oauth2_refresh"` later is contained to tools.ts.
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
     *
     * On a JSON-encoded body a dotted name nests: `as: "variables.siteTag"` sends
     * `{"variables": {"siteTag": ...}}`. That is what lets a flat, model-friendly tool
     * signature drive a GraphQL request, whose body is always `{query, variables}` --
     * the alternative was an `object` param type, i.e. asking the model to hand-write
     * the nested payload. Form encoding is unaffected (Stripe's bracket syntax has no
     * dots) and a name without a dot behaves exactly as before.
     */
    as: z.string().min(1).optional(),
    required: z.boolean().default(false),
    /**
     * A list default is what lets an API that *requires* an array still be driven by a
     * tool signature the model can ignore: TED's search rejects a request whose `fields`
     * is absent or empty, so without this the model would have to retype the same nine
     * field names on every call, and a typo in one of them is a 400.
     */
    default: z.union([z.string(), z.number(), z.boolean(), z.array(z.string().min(1)).min(1)]).optional(),
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
     * How the assembled body params are wrapped. "array" sends `[{...}]` instead of
     * `{...}` -- DataForSEO's live endpoints take a JSON array of task objects and
     * reject an object outright, so without this the connector layer simply cannot
     * call them. JSON encoding only.
     */
    bodyStyle: z.enum(["object", "array"]).default("object"),
    /**
     * Output key -> dot-path into the JSON response. This is how an API that nests its
     * link (Cloudflare wraps everything in `{result: ...}`) still satisfies the codebase
     * convention that a write tool returns a top-level `url` -- see tool-output.ts's
     * extractResultUrl, which finds it by field name and not by knowing the tool.
     * Omit it and the whole response body comes back.
     */
    result: z.record(z.string().min(1), z.string().min(1)).optional(),
    /**
     * Projects a list response down to the fields worth paying for.
     *
     * This is not cosmetic. A tool result is rendered into the transcript and the model
     * pays for every character; connector results are hard-capped at MAX_RESULT_CHARS.
     * A Reddit listing of ten posts is ~80 KB of thumbnails, award metadata and flair,
     * so without projection the useful part is *what gets truncated away* -- the tool
     * would be worse than not having it. `path` is a dot-path to the array (numeric
     * segments index it), `item` a dot-path into each element, `fields` the dot-paths
     * to keep from each item, `limit` a cap on how many items come back. Returns
     * `{count, items}` -- `count` is the length before the cap, so the model can tell
     * "that was everything" from "there was more".
     */
    resultList: z
      .object({
        path: z.string().min(1),
        item: z.string().min(1).optional(),
        fields: z.array(z.string().min(1)).min(1).optional(),
        limit: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
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
    /**
     * "basic" holds `login:password` in the env var and base64-encodes it per call.
     * DataForSEO (and most older REST APIs) want that, and the alternative -- `header`
     * with an env var the operator has to remember to pre-encode *and* prefix with
     * "Basic " -- fails as a silent 401 when they don't.
     */
    type: z.enum(["bearer", "basic", "header", "query", "none"]),
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

    if (manifest.encoding === "form") {
      manifest.operations.forEach((op, i) => {
        if (op.bodyStyle === "array") {
          at(["operations", i, "bodyStyle"], 'bodyStyle "array" needs encoding "json"');
        }
      });
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
        // A default that doesn't match its param's type reaches zod as a value it will
        // reject on the first call, i.e. a manifest that loads and a tool that cannot be
        // used -- which is exactly the failure the meta-schema exists to catch at load.
        if (Array.isArray(param.default) !== (param.type === "string[]") && param.default !== undefined) {
          at([...p, "default"], `a "${param.type}" param needs a ${param.type === "string[]" ? "list" : "scalar"} default`);
        }
        if (op.method === "GET" && param.in === "body") {
          at([...p, "in"], "GET requests have no body -- use \"query\"");
        }
      }
    });
  });

export type ConnectorManifest = z.infer<typeof connectorManifest>;
