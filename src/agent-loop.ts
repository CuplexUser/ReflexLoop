// src/agent-loop.ts
//
// The agentic loop that replaced the Agent SDK's `query()`: ask the model, run the
// tools it asked for, feed the results back, repeat until it stops asking or the turn
// budget runs out. Provider-agnostic -- it only ever touches an LlmClient.
//
// The tool fence lives here, and it is materially stronger than what it replaced.
// Under the SDK, `allowedTools` merely skipped a permission prompt, `canUseTool` was
// documented as not covering every call the SDK made internally, and a PreToolUse hook
// had to be layered on as the actual boundary -- three mechanisms, each with a gap the
// next one patched. Here there is one mechanism and no gap: a tool outside
// `allowedTools` is never described to the model, and if the model names it anyway the
// dispatch below refuses it. There is no other path from this process to a tool handler,
// so the core invariant -- act can only touch what the approved proposal named -- is
// enforced by the shape of the code rather than by configuration.

import { MAX_OUTPUT_TOKENS } from "./llm/index.js";
import { priceUsage } from "./llm/pricing.js";
import type { ChatMessage, LlmClient } from "./llm/types.js";
import { getSearchConfig } from "./search/index.js";
import type { ToolRegistry } from "./tools/registry.js";

export interface AgentRunOptions {
  client: LlmClient;
  registry: ToolRegistry;
  system: string;
  prompt: string;
  /** Exactly the tools this phase may use. Anything else is invisible and refused. */
  allowedTools: string[];
  maxTurns: number;
  signal?: AbortSignal;
  onAssistantText?: (text: string) => void;
  onToolCall?: (name: string, input: unknown, output: string, isError: boolean) => void;
  /**
   * Fired after every model call with that call's cost. The caller accumulates from
   * here rather than from the return value, so an aborted or failed phase still lands
   * in the ledger with the spend it actually incurred instead of a zero.
   */
  onTurnCost?: (usd: number) => void;
}

export interface AgentRunResult {
  /** The model's last text, i.e. what it said when it stopped calling tools. */
  finalText: string;
  costUsd: number;
  turns: number;
  stopReason: "end_turn" | "max_turns";
}

/**
 * True when "WebSearch" in this phase's grant should be satisfied by the provider
 * searching server-side rather than by a local tool. Keeps one grantable tool name
 * meaning the same thing to the operator whichever search mode is configured.
 */
function wantsNativeSearch(client: LlmClient, allowedTools: string[]): boolean {
  return getSearchConfig().mode === "native" && client.supportsNativeSearch && allowedTools.includes("WebSearch");
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { client, registry, allowedTools, signal } = opts;
  const tools = registry.schemas(allowedTools);
  const nativeSearch = wantsNativeSearch(client, allowedTools);
  const messages: ChatMessage[] = [{ role: "user", content: opts.prompt }];

  let costUsd = 0;
  let finalText = "";
  let turns = 0;

  for (turns = 1; turns <= opts.maxTurns; turns++) {
    if (signal?.aborted) throw new Error("Aborted");

    const response = await client.chat({
      system: opts.system,
      messages,
      tools,
      nativeSearch,
      maxTokens: MAX_OUTPUT_TOKENS,
      signal,
    });

    const turnCost = priceUsage(client.provider, client.model, response.usage, response.reportedCostUsd);
    costUsd += turnCost;
    opts.onTurnCost?.(turnCost);
    if (response.text.trim()) {
      finalText = response.text;
      opts.onAssistantText?.(response.text);
    }
    if (response.toolCalls.length === 0) {
      return { finalText, costUsd, turns, stopReason: "end_turn" };
    }

    messages.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
      providerRaw: response.providerRaw,
    });

    for (const call of response.toolCalls) {
      if (signal?.aborted) throw new Error("Aborted");

      // A provider whose server-side search surfaces as a call we have to answer
      // (Moonshot) gets answered here; it isn't ours to dispatch or to fence.
      const nativeResult = client.handleNativeToolCall(call);
      if (nativeResult !== null) {
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: nativeResult });
        opts.onToolCall?.(call.name, call.args, nativeResult, false);
        continue;
      }

      if (!allowedTools.includes(call.name)) {
        // Not logged to the actions table: nothing happened, and recording a refusal as
        // an action would make action_history_search report work that was never done.
        console.warn(`[agent-loop] refused out-of-scope tool: ${call.name}`);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: `Error: ${call.name} is not available to you. Available tools: ${allowedTools.join(", ")}.`,
          isError: true,
        });
        continue;
      }

      const result = await registry.invoke(call.name, call.args);
      messages.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result.text,
        isError: result.isError,
      });
      opts.onToolCall?.(call.name, call.args, result.text, result.isError);
    }
  }

  return { finalText, costUsd, turns: opts.maxTurns, stopReason: "max_turns" };
}
