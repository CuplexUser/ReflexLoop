// src/tool-catalog.ts
//
// The one place that knows which tools exist and what kind of tool each one is. The
// orchestrator builds every phase's grant from these lists, the smoke test checks the
// registry against them, and the console badges tools from `toolRisk`.
//
// **There are no write tools.** This agent researches and reports; nothing it can call
// changes anything outside its own database. That is enforced in three places rather than
// promised in a prompt: no write tool is registered (integrations-server.ts carries only
// GitHub reads), a connector manifest declaring `risk: "write"` is refused at load
// (connectors/manifest.ts), and `npm run smoke-test` fails if any registered tool classifies
// as anything but `read` or `memory`.
//
// Read-only integration tools stay defined next to their handlers -- in
// integrations-server.ts for the hand-written GitHub client, in a manifest for the
// declarative connectors. This module merges both so callers get the whole catalog from one
// import. The connector list carries *every* operation, configured or not: what a missing
// credential changes is which tools a phase is granted (see configuredConnectorTools).
import { CONNECTOR_READ_TOOLS } from "./connectors/load.js";
import { READONLY_INTEGRATION_TOOLS as NATIVE_READONLY_INTEGRATION_TOOLS } from "./integrations-server.js";

export const READONLY_INTEGRATION_TOOLS = [
  ...NATIVE_READONLY_INTEGRATION_TOOLS,
  ...CONNECTOR_READ_TOOLS,
];

/** Built-in tools with no side effects beyond a network read. */
export const READONLY_BUILTIN_TOOLS = ["WebSearch", "WebFetch"];

/** Memory tools: they write, but only to the agent's own DB -- nothing outside this process. Every phase gets these. */
export const MEMORY_TOOLS = [
  "mcp__memory__research_note_add",
  "mcp__memory__research_note_search",
  "mcp__memory__lesson_search",
  "mcp__memory__lesson_add",
  "mcp__memory__lesson_reinforce",
  "mcp__memory__proposal_status",
];

/**
 * Research-phase outputs, as opposed to memory utilities: both write a row a *human* then acts
 * on, and neither belongs in the grant every phase gets. `proposal_create` files an idea for
 * review; `goal_suggest` is the same shape one level up -- a proposed direction rather than a
 * proposed idea -- so it's granted in the same place and withheld from the deep dive and reflect,
 * which have no business opening new lanes mid-investigation.
 */
export const RESEARCH_OUTPUT_TOOLS = ["mcp__memory__proposal_create", "mcp__memory__goal_suggest"];

/**
 * The deep dive's one required output. Granted only to the deep dive, and the tool itself
 * refuses a report for any idea but the one whose deep dive is running.
 */
export const DEEP_DIVE_OUTPUT_TOOLS = ["mcp__memory__report_submit"];

/** Every tool the catalog knows about. The smoke test checks the built registry against this. */
export const ALL_CATALOG_TOOLS = [
  ...READONLY_INTEGRATION_TOOLS,
  ...READONLY_BUILTIN_TOOLS,
  ...MEMORY_TOOLS,
  ...RESEARCH_OUTPUT_TOOLS,
  ...DEEP_DIVE_OUTPUT_TOOLS,
];

export type ToolRisk = "read" | "memory" | "unknown";

/**
 * What a tool can touch: `read` reaches the network but changes nothing, `memory` writes only
 * to this agent's database. `unknown` is anything outside the catalog -- including the names of
 * the retired build-mode write tools, which still appear in old `actions` rows.
 */
export function toolRisk(toolName: string): ToolRisk {
  if (READONLY_INTEGRATION_TOOLS.includes(toolName) || READONLY_BUILTIN_TOOLS.includes(toolName)) return "read";
  if (MEMORY_TOOLS.includes(toolName) || RESEARCH_OUTPUT_TOOLS.includes(toolName) || DEEP_DIVE_OUTPUT_TOOLS.includes(toolName)) {
    return "memory";
  }
  return "unknown";
}
