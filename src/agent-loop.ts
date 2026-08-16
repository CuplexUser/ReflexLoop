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
import { isTruncationStop } from "./llm/types.js";
import type { ChatMessage, LlmClient } from "./llm/types.js";
import { getSearchConfig } from "./search/index.js";
import type { ToolRegistry } from "./tools/registry.js";
import { toolRisk } from "./tool-catalog.js";

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

/**
 * Why the loop stopped.
 *
 * `truncated` is the one that used to be invisible. The loop ends a run when a turn comes
 * back with no tool calls -- and a turn cut off at the output limit has no tool calls either,
 * because the model was still writing when the budget ran out. Both adapters have always
 * reported the provider's finish reason and nothing read it, so the two were the same event:
 * a phase that died mid-sentence returned `end_turn` and its caller treated it as a clean
 * finish. Callers that care whether the work actually got done must branch on this.
 */
export type AgentStopReason = "end_turn" | "max_turns" | "truncated";

export interface AgentRunResult {
  /** The model's last text, i.e. what it said when it stopped calling tools. */
  finalText: string;
  costUsd: number;
  turns: number;
  stopReason: AgentStopReason;
  /** The provider's own finish reason for the last turn, verbatim, for the log and the feed. */
  providerStopReason: string;
}

/**
 * True when "WebSearch" in this phase's grant should be satisfied by the provider
 * searching server-side rather than by a local tool. Keeps one grantable tool name
 * meaning the same thing to the operator whichever search mode is configured.
 */
function wantsNativeSearch(client: LlmClient, allowedTools: string[]): boolean {
  return getSearchConfig().mode === "native" && client.supportsNativeSearch && allowedTools.includes("WebSearch");
}

/**
 * Whether a turn's tool calls can all be dispatched at once.
 *
 * Research is latency-bound on the network, not on tokens -- a single research run in the ledger
 * took 39 minutes, almost all of it WebSearch and WebFetch waiting in series. Running a batch of
 * those concurrently costs nothing extra and is the one free speedup available here.
 *
 * The bar is deliberately high: **every** call must be a pure read, or the whole batch runs
 * sequentially exactly as before.
 *
 *   - `write` tools are ordered by nature -- create the repo, then commit to it, then deploy it.
 *     Act-phase behaviour is therefore completely unchanged.
 *   - `memory` tools are excluded too, even though they only touch the agent's own DB, because
 *     several now check for a near-duplicate before inserting. Two similar notes dispatched
 *     together would both pass that check before either wrote, and the guard would let through
 *     exactly the duplicate it exists to stop.
 *   - `unknown` covers proposal_create and goal_suggest, which have the same read-then-write
 *     race, so the conservative default is already the correct one for them.
 *
 * Native search calls are excluded by the registry check: they are answered by the client rather
 * than dispatched, and `handleNativeToolCall` performs the work rather than merely reporting
 * whether it would, so it can't be used as a predicate here.
 */
function canRunConcurrently(calls: { name: string }[], allowedTools: string[], registry: ToolRegistry): boolean {
  if (calls.length < 2) return false;
  return calls.every(
    (call) => allowedTools.includes(call.name) && registry.has(call.name) && toolRisk(call.name) === "read"
  );
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const { client, registry, allowedTools, signal } = opts;
  const nativeSearch = wantsNativeSearch(client, allowedTools);
  // The local WebSearch tool is always registered, so which modes actually offer it is
  // decided here, per run, from the current setting -- that's what lets the search mode
  // change without a restart. In `native` the provider searches server-side and describing
  // a local tool as well would mean two searches; in `none` there is nothing behind it.
  const describable =
    getSearchConfig().provider === null ? allowedTools.filter((name) => name !== "WebSearch") : allowedTools;
  const tools = registry.schemas(describable);
  const messages: ChatMessage[] = [{ role: "user", content: opts.prompt }];

  let costUsd = 0;
  let finalText = "";
  let turns = 0;
  let lastStopReason = "";

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

    lastStopReason = response.stopReason;
    const turnCost = priceUsage(client.provider, client.model, response.usage, response.reportedCostUsd);
    costUsd += turnCost;
    opts.onTurnCost?.(turnCost);
    if (response.text.trim()) {
      finalText = response.text;
      opts.onAssistantText?.(response.text);
    }
    if (response.toolCalls.length === 0) {
      // The one place "the model is done" and "the model was cut off" have to be told
      // apart -- they arrive here identically. See AgentStopReason.
      const truncated = isTruncationStop(response.stopReason);
      if (truncated) {
        console.warn(
          `[agent-loop] the model's last turn was cut off at the output limit (${MAX_OUTPUT_TOKENS} tokens, finish_reason=${response.stopReason}) before it called any tool; the run stopped mid-task.`
        );
      }
      return {
        finalText,
        costUsd,
        turns,
        stopReason: truncated ? "truncated" : "end_turn",
        providerStopReason: response.stopReason,
      };
    }

    // Truncated *with* tool calls is a different, self-correcting failure: the last call's
    // argument JSON is incomplete, parseArgs hands the tool `{}`, and its zod schema returns
    // a validation error the model can act on. Worth saying out loud anyway -- if the payload
    // that overflowed is the one the task needs, the retry overflows the same way and the
    // phase burns turns until the budget runs out.
    if (isTruncationStop(response.stopReason)) {
      console.warn(
        `[agent-loop] turn ${turns} hit the ${MAX_OUTPUT_TOKENS}-token output limit mid-call; ${response.toolCalls.map((c) => c.name).join(", ")} may have incomplete arguments.`
      );
    }

    messages.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
      providerRaw: response.providerRaw,
    });

    // A batch of pure reads is dispatched concurrently; anything else runs exactly as it
    // always has, one at a time. See canRunConcurrently for where that line is drawn.
    const precomputed = canRunConcurrently(response.toolCalls, allowedTools, registry)
      ? await Promise.all(
          response.toolCalls.map(async (call) => {
            if (signal?.aborted) throw new Error("Aborted");
            return registry.invoke(call.name, call.args);
          })
        )
      : null;

    for (const [index, call] of response.toolCalls.entries()) {
      if (signal?.aborted) throw new Error("Aborted");

      // Results are consumed in the model's original call order regardless of which finished
      // first, so the transcript, the actions table and the console's activity feed read the
      // same as they always did. Concurrency is a latency change, not an ordering one.
      const done = precomputed?.[index];
      if (done) {
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: done.text, isError: done.isError });
        opts.onToolCall?.(call.name, call.args, done.text, done.isError);
        continue;
      }

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

  return { finalText, costUsd, turns: opts.maxTurns, stopReason: "max_turns", providerStopReason: lastStopReason };
}
