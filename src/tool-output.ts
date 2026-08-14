// src/tool-output.ts
//
// Reading back what a tool actually returned, from what `actions.tool_output`
// holds on disk. That column has carried two different shapes over this
// project's life and both are still in the DB:
//
//   1. Rows written under the old Agent SDK: the MCP `tool_response`, i.e. a
//      JSON array of content blocks -- [{"type":"text","text":"{...}"}].
//   2. Rows written since agent-loop.ts replaced it: `result.text`, a plain
//      string, JSON.stringify'd by logAction -- so a double-encoded JSON string.
//
// Anything that wants a field out of a tool result has to handle both, or it
// silently reports "no result" for one era of rows. That is exactly what
// happened to the Actions page's result links: the extractor only knew shape 1,
// so every deploy after the SDK removal showed no URL at all.

/**
 * The tool's own JSON result, decoded from whichever storage shape the row uses.
 * Returns the raw text when the result wasn't JSON (a WebFetch page dump, an
 * "Error: ..." string), and null when there's nothing to read.
 */
export function parseToolResult(raw: string | null): unknown {
  if (!raw) return null;

  let outer: unknown;
  try {
    outer = JSON.parse(raw);
  } catch {
    return raw;
  }

  // Shape 1: MCP content blocks -- the payload is inside the first text block.
  if (Array.isArray(outer)) {
    const text = (outer as { type?: string; text?: string }[]).find((c) => c?.type === "text")?.text;
    return text === undefined ? null : reparse(text);
  }

  // Shape 2: the tool's text, JSON.stringify'd once by logAction.
  if (typeof outer === "string") return reparse(outer);

  return outer;
}

function reparse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** True when the handler reported an in-band failure rather than a result. */
export function isErrorResult(result: unknown): boolean {
  return typeof result === "string" && result.startsWith("Error:");
}

/**
 * Tool results that create or deploy something (github_create_repo,
 * github_create_pr, vercel_deploy, netlify_create_site, netlify_deploy) all
 * return a plain `url` field, so this pulls it out generically by field name
 * rather than switching per tool.
 */
export function extractResultUrl(rawToolOutput: string | null): string | null {
  const result = parseToolResult(rawToolOutput);
  if (!result || typeof result !== "object") return null;
  const url = (result as { url?: unknown }).url;
  return typeof url === "string" ? url : null;
}
