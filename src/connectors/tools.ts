// src/connectors/tools.ts
//
// Turns loaded manifests into ordinary ToolDefinitions. Everything downstream --
// the fence in agent-loop.ts, `actions.tool_name`, the console's prefix-stripping,
// the deliverables derivation -- sees a connector tool and a native one as the same
// kind of thing, which is the point: the manifest layer is a cheaper way to write a
// tool, not a second class of tool with its own rules.
//
// Errors follow the convention in integrations-server.ts: nothing throws out of a
// handler. A missing credential, a 404, a rate limit and a malformed response all
// come back as `isError` tool text, so one bad call costs the model a turn instead
// of the phase.
//
// Credentials are read at call time, never captured at module load. That's what
// lets a key filled in while the loop is running work on the next call rather than
// the next restart -- and it's the opposite of what src/integrations/*.ts do, which
// is why those need a dynamic import to be testable.

import { z } from "zod";
import { defineTool, type ToolDefinition, type ToolHandlerResult } from "../tools/registry.js";
import { assertPublicHttpUrl } from "../tools/web.js";
import { CONNECTOR_OPERATIONS, type LoadedOperation } from "./load.js";
import type { ConnectorManifest, OperationSpec, ParamSpec } from "./manifest.js";

const REQUEST_TIMEOUT_MS = 30_000;
/** A read op can return a very long list; the model pays for every character of it. */
const MAX_RESULT_CHARS = 8_000;
const MAX_ERROR_BODY_CHARS = 500;

function zodForParam(param: ParamSpec): z.ZodTypeAny {
  let schema: z.ZodTypeAny;
  switch (param.type) {
    case "string":
      schema = z.string();
      break;
    case "number":
      schema = z.number();
      break;
    case "integer":
      schema = z.number().int();
      break;
    case "boolean":
      schema = z.boolean();
      break;
    case "enum":
      schema = z.enum(param.values as [string, ...string[]]);
      break;
    case "string[]":
      schema = z.array(z.string());
      break;
  }
  if (param.describe) schema = schema.describe(param.describe);
  if (param.default !== undefined) return schema.default(param.default) as z.ZodTypeAny;
  if (!param.required) return schema.optional();
  return schema;
}

function shapeFor(op: LoadedOperation): z.ZodRawShape {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, param] of Object.entries(op.spec.params)) shape[name] = zodForParam(param);
  return shape as z.ZodRawShape;
}

/** Reads a dot-path out of a parsed response, e.g. "result.url" for Cloudflare's wrapper. */
function pick(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, source);
}

function authHeaders(manifest: ConnectorManifest): Record<string, string> {
  const { auth } = manifest;
  if (auth.type === "none") return {};
  const token = auth.envVar ? process.env[auth.envVar] : undefined;
  if (!token) throw new Error(`${auth.envVar} is not set`);
  if (auth.type === "bearer") return { Authorization: `Bearer ${token}` };
  // The env var holds `login:password`; encoding it here is what keeps the operator
  // from having to base64 it by hand, which fails as a 401 rather than as an error
  // saying what is wrong.
  if (auth.type === "basic") {
    return { Authorization: `Basic ${Buffer.from(token, "utf8").toString("base64")}` };
  }
  if (auth.type === "header") return { [auth.headerName as string]: token };
  return {};
}

function authQuery(manifest: ConnectorManifest): [string, string] | null {
  const { auth } = manifest;
  if (auth.type !== "query") return null;
  const token = auth.envVar ? process.env[auth.envVar] : undefined;
  if (!token) throw new Error(`${auth.envVar} is not set`);
  return [auth.queryName as string, token];
}

/**
 * Values go on the wire under the provider's own name (`as`), so a tool argument can
 * read as `priceId` while Stripe receives `line_items[0][price]`.
 */
function wireName(name: string, param: ParamSpec): string {
  return param.as ?? name;
}

/**
 * Assigns into a nested object along a dot-path, creating the intermediate objects.
 * `as: "variables.siteTag"` is what turns a flat tool signature into a GraphQL body.
 * A path with no dot is a plain assignment, which is every pre-existing manifest.
 */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let node = target;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    if (next === null || typeof next !== "object") node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]] = value;
}

/**
 * The key each declared field is projected under: its last dot segment, which is what
 * flattens `ruleset.zone_name` to `zone_name`. Two fields can collapse to the same one --
 * TED returns `notice-title` and `buyer-name` as per-language maps, so `notice-title.swe`
 * and `buyer-name.swe` both end in `swe` -- and whichever came second used to overwrite
 * the first silently, i.e. the manifest looked like it asked for both and one was simply
 * missing. Colliding fields keep their full path as the key instead.
 *
 * Computed once per projection rather than per item, so a field that happens to be absent
 * from one element can't change the keys the other elements come back under.
 */
function projectionKeys(fields: string[]): string[] {
  const short = fields.map((field) => field.split(".").pop() as string);
  return fields.map((field, i) =>
    short.some((name, j) => j !== i && name === short[i]) ? field : short[i]
  );
}

/**
 * The list projection declared by `resultList`. Kept separate from the scalar `result`
 * shaping because the failure mode differs: a scalar map that resolves nothing means the
 * API changed shape, while a `path` that isn't an array usually means the request itself
 * failed in a way the provider reported with a 200.
 */
function projectList(parsed: unknown, spec: NonNullable<OperationSpec["resultList"]>): unknown {
  const raw = pick(parsed, spec.path);
  if (!Array.isArray(raw)) return null;
  const keys = spec.fields ? projectionKeys(spec.fields) : [];
  const items = raw.slice(0, spec.limit ?? raw.length).map((element) => {
    const item = spec.item ? pick(element, spec.item) : element;
    if (!spec.fields) return item;
    const projected: Record<string, unknown> = {};
    spec.fields.forEach((field, i) => {
      const value = pick(item, field);
      if (value !== undefined) projected[keys[i]] = value;
    });
    return projected;
  });
  // `count` is the length before the cap, so "that was all of them" is distinguishable
  // from "there was more and you only got the top N".
  return { count: raw.length, items };
}

function appendValue(target: URLSearchParams, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) target.append(key, String(item));
    return;
  }
  target.append(key, String(value));
}

async function callOperation(op: LoadedOperation, args: Record<string, unknown>): Promise<unknown> {
  const { connector, spec } = op;

  let path = spec.path;
  const query = new URLSearchParams();
  const bodyParams: [string, unknown][] = [];

  for (const [name, param] of Object.entries(spec.params)) {
    const value = args[name];
    if (value === undefined || value === null) continue;
    if (param.in === "path") {
      path = path.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
    } else if (param.in === "query") {
      appendValue(query, wireName(name, param), value);
    } else {
      bodyParams.push([wireName(name, param), value]);
    }
  }

  const credentialQuery = authQuery(connector);
  if (credentialQuery) query.append(credentialQuery[0], credentialQuery[1]);

  const search = query.toString();
  const url = assertPublicHttpUrl(
    `${connector.baseUrl.replace(/\/$/, "")}${path}${search ? `?${search}` : ""}`
  );

  const headers: Record<string, string> = {
    accept: "application/json",
    ...connector.defaultHeaders,
    ...authHeaders(connector),
  };

  let body: string | undefined;
  if (bodyParams.length > 0) {
    if (connector.encoding === "form") {
      const form = new URLSearchParams();
      for (const [key, value] of bodyParams) appendValue(form, key, value);
      body = form.toString();
      headers["content-type"] ??= "application/x-www-form-urlencoded";
    } else {
      const payload: Record<string, unknown> = {};
      for (const [key, value] of bodyParams) setPath(payload, key, value);
      body = JSON.stringify(spec.bodyStyle === "array" ? [payload] : payload);
      headers["content-type"] ??= "application/json";
    }
  }

  const res = await fetch(url, {
    method: spec.method,
    headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${connector.label} ${spec.method} ${spec.path} -> ${res.status}: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = text;
  }

  // GraphQL reports failure with a 200 and an `errors` array, and Cloudflare's REST
  // wrapper uses the same key (empty on success). Without this a failed query would be
  // handed back as a successful call returning nothing.
  if (parsed && typeof parsed === "object") {
    const errors = (parsed as Record<string, unknown>).errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new Error(
        `${connector.label} ${spec.method} ${spec.path} -> ${JSON.stringify(errors).slice(0, MAX_ERROR_BODY_CHARS)}`
      );
    }
  }

  const list = spec.resultList ? projectList(parsed, spec.resultList) : null;

  if (!spec.result) return list ?? parsed;

  const shaped: Record<string, unknown> = {};
  for (const [key, dotPath] of Object.entries(spec.result)) {
    const value = pick(parsed, dotPath);
    if (value !== undefined) shaped[key] = value;
  }
  if (list) Object.assign(shaped, list);
  // A shaping map that resolved nothing usually means the API changed its response
  // shape. Handing back `{}` would report success with no information; the raw body
  // at least lets the model (and the action log) see what actually came back.
  return Object.keys(shaped).length > 0 ? shaped : parsed;
}

function render(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n... [truncated, ${text.length} chars total]`;
}

export function buildConnectorTools(): ToolDefinition[] {
  return CONNECTOR_OPERATIONS.map((op) =>
    defineTool(op.toolName, op.spec.description, shapeFor(op), async (args): Promise<ToolHandlerResult> => {
      try {
        return render(await callOperation(op, args as Record<string, unknown>));
      } catch (err) {
        return { text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    })
  );
}
