// src/llm/types.ts
//
// The provider-neutral vocabulary every phase speaks. Nothing above this file
// knows whether the model behind it is Claude, GPT, Grok or Kimi -- the two
// adapters (openai-compatible.ts, anthropic.ts) translate to and from these
// shapes, and agent-loop.ts drives them.
//
// Deliberately smaller than any provider's own message model: one text field
// plus tool calls per assistant turn, one tool result per tool message. The
// orchestrator never needed images, citations, or thinking blocks, and keeping
// the surface narrow is what lets a second adapter be ~200 lines.

export type ProviderId = "openrouter" | "openai" | "anthropic" | "xai" | "moonshot";

/** A tool as the model sees it: name, description, and a JSON Schema for its arguments. */
export interface ToolSchema {
  name: string;
  description: string;
  /** JSON Schema object (draft-07 flavoured); always `{"type": "object", ...}`. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  /** Provider-assigned id; the tool result must quote it back. */
  id: string;
  name: string;
  /** Parsed arguments. `{}` when the model emitted unparseable JSON -- see `rawArgs`. */
  args: Record<string, unknown>;
  /** Exactly what the model produced, kept so a parse failure is still visible in the log. */
  rawArgs: string;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      toolCalls: ToolCall[];
      /**
       * The provider's own representation of this turn, stashed by the adapter that
       * produced it and replayed verbatim on the next request. Load-bearing for
       * Anthropic: an assistant turn's thinking and server-tool blocks must come back
       * unedited alongside its tool_use blocks or the API rejects the turn, and
       * rebuilding the turn from `content` + `toolCalls` alone would drop them.
       * Opaque to everyone else; the OpenAI-compatible adapter never sets it.
       */
      providerRaw?: unknown;
    }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface Usage {
  /**
   * TOTAL prompt tokens, cached ones included. Adapters must normalize to this:
   * OpenAI-compatible `prompt_tokens` already counts cached tokens, but Anthropic's
   * `input_tokens` is the uncached remainder only, so its adapter adds the cache
   * fields back in. pricing.ts subtracts `cachedInputTokens` to bill them cheaper,
   * and would under-count the bill if a provider reported the remainder here.
   */
  inputTokens: number;
  outputTokens: number;
  /** Of `inputTokens`, how many were served from the provider's prompt cache. */
  cachedInputTokens: number;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  /**
   * Ask the provider to run web search server-side for this request. Only set when
   * the operator chose AGENT_SEARCH_PROVIDER=native *and* the phase was granted
   * WebSearch -- see search/index.ts. Providers that can't do it ignore it.
   */
  nativeSearch: boolean;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /**
   * Real USD for this call, when the provider bills it back to us (OpenRouter does).
   * `null` means "price it yourself from the table" -- see pricing.ts.
   */
  reportedCostUsd: number | null;
  /**
   * The provider's own finish reason, verbatim. Read by {@link isTruncationStop} -- a
   * turn that stopped because it ran out of output budget looks exactly like one that
   * stopped because the model was done, and only this field tells them apart.
   */
  stopReason: string;
  /** Adapter-owned native form of this turn; agent-loop carries it onto the assistant message. */
  providerRaw?: unknown;
}

/**
 * Whether a provider's finish reason means "cut off mid-generation" rather than "finished".
 *
 * This matters because of how the loop decides a run is over: it stops when a turn comes
 * back with no tool calls. A truncated turn also has no tool calls -- the model was still
 * writing when the output budget ran out -- so without this check the two are the same
 * event, and a phase that died halfway through reports success. That is exactly how
 * proposal #27 created a repo, announced "now I'll write the full prototype", and finished
 * clean with an empty repo and nothing committed.
 *
 * Matched case-insensitively and across vocabularies because OpenRouter passes the
 * upstream provider's spelling straight through: OpenAI-compatible says `length`,
 * Anthropic says `max_tokens`, Google says `MAX_TOKENS`.
 */
const TRUNCATION_STOPS = new Set(["length", "max_tokens", "max_output_tokens", "model_length", "token_limit"]);

export function isTruncationStop(stopReason: string): boolean {
  return TRUNCATION_STOPS.has(stopReason.trim().toLowerCase());
}

export interface LlmClient {
  readonly provider: ProviderId;
  readonly model: string;
  /** Whether this provider can search the web itself, so `nativeSearch` is worth setting. */
  readonly supportsNativeSearch: boolean;
  chat(req: ChatRequest): Promise<ChatResponse>;
  /**
   * Native search on some providers arrives as a tool call the *client* has to answer
   * (Moonshot's `$web_search` wants its own arguments echoed straight back). Returns the
   * result text for such a call, or null when the call is an ordinary one for us to run.
   */
  handleNativeToolCall(call: ToolCall): string | null;
}

/** Thrown for a non-retryable provider error, so the phase fails with something readable. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string
  ) {
    super(message);
    this.name = "LlmError";
  }
}
