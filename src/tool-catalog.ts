// src/tool-catalog.ts
//
// The one place that knows which tools exist and which of them touch the real
// world. Three consumers need to agree on that, and used to each carry their
// own copy of the answer:
//
//   - orchestrator.ts, listing act-phase write tools in the research prompt;
//   - server.ts, validating an operator's edits to a proposal's required_tools
//     (a human can narrow or widen the fence, but only to tools that actually
//     exist -- never to an arbitrary string);
//   - the web console, badging which requested tools are side-effecting so the
//     fence is legible at the moment someone decides on it.
//
// Read-only integration tools stay defined in integrations-server.ts next to
// the handlers they describe; this module re-exports them so callers get the
// whole catalog from one import.

import { READONLY_INTEGRATION_TOOLS } from "./integrations-server.js";

export { READONLY_INTEGRATION_TOOLS };

/**
 * Act-phase-only tools that create, commit, or deploy something real. A proposal can only
 * use one of these if a human approved a proposal naming it.
 */
export const WRITE_INTEGRATION_TOOLS = [
  "mcp__integrations__github_create_repo",
  "mcp__integrations__github_create_branch",
  "mcp__integrations__github_commit_file",
  "mcp__integrations__github_commit_files",
  "mcp__integrations__github_create_pr",
  "mcp__integrations__github_merge_pr",
  "mcp__integrations__vercel_deploy",
  "mcp__integrations__netlify_create_site",
  "mcp__integrations__netlify_deploy",
];

/** Built-in tools with no side effects beyond a network read. */
export const READONLY_BUILTIN_TOOLS = ["WebSearch", "WebFetch"];

/** Memory tools: they write, but only to the agent's own DB -- nothing outside this process. */
export const MEMORY_TOOLS = [
  "mcp__memory__research_note_add",
  "mcp__memory__research_note_search",
  "mcp__memory__lesson_search",
  "mcp__memory__lesson_add",
  "mcp__memory__lesson_reinforce",
  "mcp__memory__proposal_status",
  "mcp__memory__outcome_record",
  "mcp__memory__action_history_search",
];

/**
 * Research-phase outputs, as opposed to memory utilities: both write a row a *human* then acts
 * on, and neither belongs in the grant every phase gets. `proposal_create` was already handled
 * this way; `goal_suggest` is the same shape one level up -- a proposed direction rather than a
 * proposed action -- so it's granted in the same place and withheld from act/reflect, which have
 * no business opening new lanes mid-execution.
 *
 * Neither is in ALL_GRANTABLE_TOOLS: a proposal can't name them, because they aren't things the
 * act phase does.
 */
export const RESEARCH_OUTPUT_TOOLS = ["mcp__memory__proposal_create", "mcp__memory__goal_suggest"];

/** Every tool a proposal may legitimately name. Anything outside this is rejected, not merely denied later. */
export const ALL_GRANTABLE_TOOLS = [
  ...WRITE_INTEGRATION_TOOLS,
  ...READONLY_INTEGRATION_TOOLS,
  ...READONLY_BUILTIN_TOOLS,
  ...MEMORY_TOOLS,
];

export type ToolRisk = "write" | "read" | "memory" | "unknown";

/** How much damage a tool can do if the proposal naming it turns out to be a bad idea. */
export function toolRisk(toolName: string): ToolRisk {
  if (WRITE_INTEGRATION_TOOLS.includes(toolName)) return "write";
  if (READONLY_INTEGRATION_TOOLS.includes(toolName) || READONLY_BUILTIN_TOOLS.includes(toolName)) return "read";
  if (MEMORY_TOOLS.includes(toolName)) return "memory";
  return "unknown";
}
