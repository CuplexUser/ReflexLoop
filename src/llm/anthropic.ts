// src/llm/anthropic.ts
//
// Adapter for Anthropic's native Messages API. Anthropic also publishes an
// OpenAI-compatible endpoint, but it lags on exactly the features this loop leans
// on (tool use, prompt caching, server-side search), so Claude gets its own ~200
// lines rather than being squeezed through openai-compatible.ts.
//
// Three shape differences drive everything below:
//   - content is a list of typed blocks, not a string plus a tool_calls array;
//   - tool results are blocks inside a *user* message, and consecutive results must
//     share one message rather than getting one message each;
//   - server-side tools (web search) run inside a single request and can park the
//     turn with stop_reason "pause_turn", which the caller resumes by re-posting.
//
// Note what is NOT sent: no `temperature`/`top_p`/`top_k` and no `thinking` config.
// Current Claude models reject non-default sampling parameters outright, and leaving
// `thinking` unset lets each model use its own default rather than this file guessing.

import { postJson } from "./http.js";
import type { ChatMessage, ChatRequest, ChatResponse, LlmClient, ProviderId, ToolCall, Usage } from "./types.js";
import { LlmError } from "./types.js";
import type { ProviderSpec } from "./providers.js";

const API_VERSION = "2023-06-01";
/** A parked turn is resumed by re-posting; bounded so a misbehaving run can't spin. */
const MAX_PAUSE_RESUMES = 4;

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  [key: string]: unknown;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { message?: string };
}

/**
 * Models on the newer server-tool generation, which adds dynamic filtering. Older
 * models only accept the basic variant, so picking the wrong one is a 400 either way.
 */
const NEW_SEARCH_TOOL_MODELS = [
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
];

function webSearchToolFor(model: string): Record<string, unknown> {
  const normalized = model.trim().toLowerCase();
  const isNew = NEW_SEARCH_TOOL_MODELS.some((known) => normalized.startsWith(known));
  return { type: isNew ? "web_search_20260209" : "web_search_20250305", name: "web_search", max_uses: 8 };
}

/**
 * Neutral history -> Anthropic messages. Runs of tool results collapse into a single
 * user message: Anthropic requires every tool_result for one assistant turn to arrive
 * together, and splitting them is both an error and a signal that trains the model out
 * of parallel tool calls.
 */
function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: { role: string; content: unknown }[] = [];
  let pendingResults: unknown[] = [];

  const flush = () => {
    if (pendingResults.length > 0) {
      out.push({ role: "user", content: pendingResults });
      pendingResults = [];
    }
  };

  for (const message of messages) {
    if (message.role === "tool") {
      pendingResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      });
      continue;
    }
    flush();
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else if (Array.isArray(message.providerRaw) && message.providerRaw.length > 0) {
      // Replay the original blocks so thinking / server-tool pairs survive the round trip.
      // The emptiness check matters on the nudge path in agent-loop.ts, which replays a turn
      // that produced nothing: an empty content array is a 400 from this API, not an empty turn.
      out.push({ role: "assistant", content: message.providerRaw });
    } else {
      const blocks: unknown[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      out.push({ role: "assistant", content: blocks.length > 0 ? blocks : "" });
    }
  }
  flush();
  return out;
}

export class AnthropicClient implements LlmClient {
  readonly provider: ProviderId = "anthropic";
  readonly supportsNativeSearch = true;

  constructor(
    private readonly spec: ProviderSpec,
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string
  ) {}

  /** Anthropic's server tools resolve entirely server-side; nothing for the client to answer. */
  handleNativeToolCall(): string | null {
    return null;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const tools: unknown[] = req.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
    if (req.nativeSearch) tools.push(webSearchToolFor(this.model));

    const messages = toAnthropicMessages(req.messages);
    const usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    let text = "";
    let toolCalls: ToolCall[] = [];
    let stopReason = "end_turn";
    let providerRaw: AnthropicBlock[] = [];

    for (let resume = 0; ; resume++) {
      const json = await postJson<AnthropicResponse>({
        url: `${this.baseUrl}/messages`,
        headers: { "x-api-key": this.apiKey, "anthropic-version": API_VERSION },
        body: {
          model: this.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages,
          ...(tools.length > 0 ? { tools } : {}),
        },
        signal: req.signal,
        label: "Anthropic messages",
      });

      if (json.error?.message) throw new LlmError(`Anthropic: ${json.error.message}`);
      const blocks = json.content ?? [];

      // Usage accumulates across resumes -- each leg is separately billed. input_tokens is
      // the uncached remainder on this API, so the cache fields are added back to keep
      // Usage.inputTokens meaning "total prompt tokens" for every provider.
      const cacheRead = json.usage?.cache_read_input_tokens ?? 0;
      const cacheWrite = json.usage?.cache_creation_input_tokens ?? 0;
      usage.inputTokens += (json.usage?.input_tokens ?? 0) + cacheRead + cacheWrite;
      usage.outputTokens += json.usage?.output_tokens ?? 0;
      usage.cachedInputTokens += cacheRead;

      text += blocks
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
      providerRaw = providerRaw.concat(blocks);
      stopReason = json.stop_reason ?? "end_turn";

      // server_tool_use / web_search_tool_result blocks are Anthropic's own bookkeeping for
      // a search it already ran -- they are not calls for us to answer, so only genuine
      // tool_use blocks become ToolCalls.
      toolCalls = blocks
        .filter((block) => block.type === "tool_use" && block.name)
        .map((block, index) => {
          const args = (block.input ?? {}) as Record<string, unknown>;
          return {
            id: (block.id as string) ?? `call_${index}`,
            name: block.name as string,
            args,
            rawArgs: JSON.stringify(args),
          };
        });

      if (stopReason !== "pause_turn" || resume >= MAX_PAUSE_RESUMES) break;
      // A parked turn resumes by echoing the partial assistant turn back and re-posting;
      // no extra user message, the API picks up from the trailing server_tool_use block.
      messages.push({ role: "assistant", content: blocks });
    }

    if (stopReason === "refusal") {
      // Not an HTTP error: a 200 whose content is empty or partial. Surfaced as an error so
      // the phase fails loudly instead of recording a silently truncated run as a success.
      throw new LlmError(`Anthropic declined the request (stop_reason: refusal): ${text.slice(0, 300)}`);
    }

    return { text, toolCalls, usage, reportedCostUsd: null, stopReason, providerRaw };
  }
}
