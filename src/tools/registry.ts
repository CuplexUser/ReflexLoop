// src/tools/registry.ts
//
// What replaced the Agent SDK's MCP servers. A tool is now just a name, a
// description, a zod schema and a handler; the registry converts the schema to JSON
// Schema for whichever provider is in use, and dispatches calls.
//
// Two things worth knowing:
//
// Tool names keep their `mcp__memory__` / `mcp__integrations__` prefixes even though
// no MCP server exists any more. Those strings are persisted -- every row in
// `actions.tool_name`, every approved proposal's `required_tools`, and the console's
// display code (web/src/format.ts, ToolFence.tsx) all strip or match on them. Renaming
// would invalidate the fence on already-approved proposals for no behavioural gain, so
// the prefixes stay as opaque namespaces.
//
// The tool fence is stronger here than it was under the SDK. There, `allowedTools`
// only suppressed a permission prompt and `canUseTool` had documented gaps for
// SDK-internal calls, which is why the old code needed a PreToolUse hook as well.
// Now the loop owns dispatch outright: a tool outside the phase's grant is never
// described to the model and is refused at `invoke`, with no third path to the handler.

import { z } from "zod";
import type { ToolSchema } from "../llm/types.js";

export type ToolHandlerResult = string | { text: string; isError?: boolean };

export interface ToolDefinition {
  name: string;
  description: string;
  /** Argument shape. Also the validator: bad arguments become an in-band error, not a crash. */
  parameters: z.ZodObject<z.ZodRawShape>;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult> | ToolHandlerResult;
}

/**
 * Same call shape as the SDK's `tool()` helper it replaces, so the ~25 tool definitions
 * in memory-server.ts and integrations-server.ts read the way they always did.
 */
export function defineTool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: Shape,
  handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolHandlerResult> | ToolHandlerResult
): ToolDefinition {
  return {
    name,
    description,
    parameters: z.object(shape),
    handler: handler as ToolDefinition["handler"],
  };
}

/** Applies a namespace prefix to a group of tools, the way an MCP server name used to. */
export function namespaceTools(prefix: string, tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => ({ ...tool, name: `${prefix}${tool.name}` }));
}

/**
 * zod -> JSON Schema for the wire. `io: "input"` matters: it treats a field with a
 * `.default()` as optional, which is what the model is actually allowed to omit.
 */
function toJsonSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
  // Providers reject an unexpected $schema key on a tool parameter object.
  delete json.$schema;
  if (!json.type) json.type = "object";
  if (!json.properties) json.properties = {};
  return json;
}

export interface ToolInvocation {
  text: string;
  isError: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly schemaCache = new Map<string, ToolSchema>();

  constructor(tools: ToolDefinition[]) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * The wire schemas for exactly the named tools, in the order given. Names with no
   * registered tool are skipped rather than erroring -- "WebSearch" is legitimately
   * absent when the operator chose native or no search (see search/index.ts), and the
   * catalog still lists it as grantable.
   */
  schemas(names: string[]): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const name of names) {
      const tool = this.tools.get(name);
      if (!tool) continue;
      let schema = this.schemaCache.get(name);
      if (!schema) {
        schema = { name: tool.name, description: tool.description, parameters: toJsonSchema(tool.parameters) };
        this.schemaCache.set(name, schema);
      }
      out.push(schema);
    }
    return out;
  }

  /**
   * Runs a tool. Every failure -- unknown tool, invalid arguments, a throwing handler --
   * comes back as `isError` text rather than an exception, so one bad call costs the model
   * a turn to correct instead of killing the phase and losing the work already done.
   */
  async invoke(name: string, args: Record<string, unknown>): Promise<ToolInvocation> {
    const tool = this.tools.get(name);
    if (!tool) return { text: `Error: no such tool "${name}".`, isError: true };

    const parsed = tool.parameters.safeParse(args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      return { text: `Error: invalid arguments for ${name}: ${issues}`, isError: true };
    }

    try {
      const result = await tool.handler(parsed.data as Record<string, unknown>);
      if (typeof result === "string") return { text: result, isError: false };
      return { text: result.text, isError: Boolean(result.isError) };
    } catch (err) {
      return { text: `Error: ${name} failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }
}
