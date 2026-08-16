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
import type { ConnectorManifest, ParamSpec } from "./manifest.js";

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
      body = JSON.stringify(Object.fromEntries(bodyParams));
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

  if (!spec.result) return parsed;

  const shaped: Record<string, unknown> = {};
  for (const [key, dotPath] of Object.entries(spec.result)) {
    const value = pick(parsed, dotPath);
    if (value !== undefined) shaped[key] = value;
  }
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
