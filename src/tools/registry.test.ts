import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ToolRegistry, defineTool, namespaceTools } from "./registry.js";

const echo = defineTool(
  "echo",
  "Echo a message back.",
  { message: z.string(), times: z.number().int().positive().default(1) },
  ({ message, times }) => message.repeat(times)
);

describe("schema conversion", () => {
  it("emits JSON Schema the wire will accept", () => {
    const [schema] = new ToolRegistry([echo]).schemas(["echo"]);
    expect(schema).toMatchObject({ name: "echo", description: "Echo a message back." });
    expect(schema.parameters).toMatchObject({ type: "object" });
    // No $schema key: providers reject an unexpected one on a tool parameter object.
    expect(schema.parameters).not.toHaveProperty("$schema");
    expect(Object.keys(schema.parameters.properties as object)).toEqual(["message", "times"]);
  });

  it("treats a defaulted field as optional, since the model may omit it", () => {
    const [schema] = new ToolRegistry([echo]).schemas(["echo"]);
    expect(schema.parameters.required).toEqual(["message"]);
  });

  it("skips names with no registered tool rather than erroring", () => {
    // WebSearch is legitimately absent in native/none search mode while still being
    // a granted, catalogued tool name -- see search/index.ts.
    const schemas = new ToolRegistry([echo]).schemas(["echo", "WebSearch"]);
    expect(schemas.map((s) => s.name)).toEqual(["echo"]);
  });
});

describe("invoke", () => {
  it("runs a tool and returns its text", async () => {
    const result = await new ToolRegistry([echo]).invoke("echo", { message: "hi", times: 2 });
    expect(result).toEqual({ text: "hihi", isError: false });
  });

  it("reports invalid arguments in-band instead of throwing", async () => {
    const result = await new ToolRegistry([echo]).invoke("echo", { message: 42 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("message");
  });

  it("reports an unknown tool in-band", async () => {
    const result = await new ToolRegistry([echo]).invoke("nope", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no such tool");
  });

  it("catches a throwing handler so one bad call costs a turn, not the phase", async () => {
    const boom = defineTool("boom", "Always fails.", {}, () => {
      throw new Error("upstream exploded");
    });
    const result = await new ToolRegistry([boom]).invoke("boom", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("upstream exploded");
  });

  it("honours a handler's own isError flag", async () => {
    const failing = defineTool("failing", "Returns an error result.", {}, () => ({
      text: "GITHUB_TOKEN is not set",
      isError: true,
    }));
    const result = await new ToolRegistry([failing]).invoke("failing", {});
    expect(result).toEqual({ text: "GITHUB_TOKEN is not set", isError: true });
  });
});

describe("namespacing", () => {
  it("prefixes names the way the old MCP server names did", () => {
    const [tool] = namespaceTools("mcp__memory__", [echo]);
    expect(tool.name).toBe("mcp__memory__echo");
  });

  it("rejects duplicate names", () => {
    expect(() => new ToolRegistry([echo, echo])).toThrow(/Duplicate tool name/);
  });
});
