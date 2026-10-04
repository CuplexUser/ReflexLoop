// src/integrations-server.ts
//
// Tools wrapping the GitHub client in src/integrations/. Read-only, like every
// tool this agent has: they are for checking whether something similar already
// exists, not for building anything. READONLY_INTEGRATION_TOOLS is exported for
// tool-catalog.ts, which merges it with the connector read tools.
//
// Every handler catches its own errors and returns them as tool text
// rather than throwing, including "GITHUB_TOKEN is not set" when nobody
// configured it -- so a phase run degrades to a clear in-band error
// instead of crashing.
//
// The `mcp__integrations__` prefix these tools carry is just a namespace --
// there is no MCP server behind it. It stays because the string is persisted
// in `actions.tool_name`; see the note in tools/registry.ts.

import { z } from "zod";
import { defineTool, namespaceTools, type ToolDefinition, type ToolHandlerResult } from "./tools/registry.js";
import * as github from "./integrations/github.js";

export const READONLY_INTEGRATION_TOOLS = [
  "mcp__integrations__github_read_repo",
  "mcp__integrations__github_read_file",
  "mcp__integrations__github_search_repos",
];

async function toResult(fn: () => Promise<unknown>): Promise<ToolHandlerResult> {
  try {
    return JSON.stringify(await fn(), null, 2);
  } catch (err) {
    return { text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}

export function buildIntegrationsTools(): ToolDefinition[] {
  const githubReadRepo = defineTool(
    "github_read_repo",
    "Read a GitHub repo's metadata (description, stars, language, default branch). Read-only.",
    { owner: z.string(), repo: z.string() },
    ({ owner, repo }) => toResult(() => github.readRepo(owner, repo))
  );

  const githubReadFile = defineTool(
    "github_read_file",
    "Read a single file's contents from a GitHub repo, e.g. a competitor's README or pricing notes. Read-only.",
    { owner: z.string(), repo: z.string(), path: z.string(), ref: z.string().optional().describe("branch, tag, or commit SHA") },
    ({ owner, repo, path, ref }) => toResult(() => github.readFile(owner, repo, path, ref))
  );

  const githubSearchRepos = defineTool(
    "github_search_repos",
    "Search public GitHub repos -- for a software idea, a quick check of whether something similar already exists and how much traction it has. Read-only.",
    { query: z.string(), limit: z.number().int().positive().max(30).optional() },
    ({ query, limit }) => toResult(() => github.searchRepos(query, limit ?? 10))
  );

  return namespaceTools("mcp__integrations__", [githubReadRepo, githubReadFile, githubSearchRepos]);
}
