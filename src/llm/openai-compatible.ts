// src/llm/openai-compatible.ts
//
// Adapter for every provider that speaks OpenAI's /chat/completions: OpenRouter,
// OpenAI, xAI (Grok) and Moonshot (Kimi). The wire format is identical across all
// four; what differs is exactly three things, all keyed off the provider id below:
//
//   1. how you cap output tokens (OpenAI renamed max_tokens -> max_completion_tokens),
//   2. how you turn on server-side web search, and
//   3. whether the provider bills the call back to you (OpenRouter does).
//
// Everything else -- message mapping, tool calls, usage -- is shared.

import { postJson } from "./http.js";
import type { ChatMessage, ChatRequest, ChatResponse, LlmClient, ProviderId, ToolCall } from "./types.js";
import { LlmError } from "./types.js";
import type { ProviderSpec } from "./providers.js";

/** Moonshot exposes its server-side search as a builtin function whose call we echo back. */
const MOONSHOT_SEARCH_TOOL = "$web_search";

interface OaiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OaiResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: OaiToolCall[] };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    /** OpenRouter only: real USD charged for this call, when `usage.include` was requested. */
    cost?: number;
  };
  error?: { message?: string };
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    // Left as {} deliberately: the loop still dispatches, the tool's zod schema rejects it,
    // and the model gets a validation error it can correct on the next turn.
    return {};
  }
}

/** Neutral history -> OpenAI message array. Tool results are their own messages here. */
function toOaiMessages(system: string, messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    } else if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.rawArgs },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: "tool", tool_call_id: message.toolCallId, name: message.name, content: message.content });
    }
  }
  return out;
}

/** The one provider-specific knob: how each one is asked to search the web itself. */
function applyNativeSearch(provider: ProviderId, body: Record<string, unknown>, tools: unknown[]): void {
  switch (provider) {
    case "openrouter":
      body.plugins = [{ id: "web", max_results: 5 }];
      break;
    case "xai":
      body.search_parameters = { mode: "auto", max_search_results: 8 };
      break;
    case "openai":
      body.web_search_options = {};
      break;
    case "moonshot":
      tools.push({ type: "builtin_function", function: { name: MOONSHOT_SEARCH_TOOL } });
      break;
    default:
      break;
  }
}

export class OpenAiCompatibleClient implements LlmClient {
  readonly provider: ProviderId;
  readonly supportsNativeSearch: boolean;

  constructor(
    private readonly spec: ProviderSpec,
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string
  ) {
    this.provider = spec.id;
    this.supportsNativeSearch = spec.nativeSearch;
  }

  handleNativeToolCall(call: ToolCall): string | null {
    // Moonshot's builtin search runs on their side but is surfaced as a tool call whose
    // own arguments are the expected result -- echo them straight back and the server
    // resolves the search on the next turn. No other provider needs client involvement.
    if (this.provider === "moonshot" && call.name === MOONSHOT_SEARCH_TOOL) {
      return call.rawArgs || "{}";
    }
    return null;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const tools: unknown[] = req.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));

    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOaiMessages(req.system, req.messages),
    };

    // OpenAI's newer models reject `max_tokens`; everyone else still expects it.
    if (this.provider === "openai") body.max_completion_tokens = req.maxTokens;
    else body.max_tokens = req.maxTokens;

    // Off unless the operator asks for it: several current models reject any non-default
    // sampling parameter outright, so sending one by default would break them.
    const temperature = Number(process.env.AGENT_TEMPERATURE);
    if (Number.isFinite(temperature)) body.temperature = temperature;

    if (req.nativeSearch) applyNativeSearch(this.provider, body, tools);
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    // Makes OpenRouter return the real dollar cost of the call, which beats pricing it
    // ourselves from a table that can go stale.
    if (this.provider === "openrouter") body.usage = { include: true };

    const headers: Record<string, string> = { authorization: `Bearer ${this.apiKey}` };
    if (this.provider === "openrouter") {
      // Optional attribution headers OpenRouter surfaces on its dashboard.
      headers["x-title"] = "ReflexLoop";
    }

    const json = await postJson<OaiResponse>({
      url: `${this.baseUrl}/chat/completions`,
      headers,
      body,
      signal: req.signal,
      label: `${this.spec.label} chat`,
    });

    if (json.error?.message) throw new LlmError(`${this.spec.label}: ${json.error.message}`);
    const choice = json.choices?.[0];
    if (!choice) throw new LlmError(`${this.spec.label}: response contained no choices`);

    const toolCalls: ToolCall[] = (choice.message?.tool_calls ?? [])
      .filter((call) => call.function?.name)
      .map((call, index) => {
        const rawArgs = call.function?.arguments ?? "";
        return {
          id: call.id ?? `call_${index}`,
          name: call.function!.name!,
          args: parseArgs(rawArgs),
          rawArgs,
        };
      });

    const promptTokens = json.usage?.prompt_tokens ?? 0;
    return {
      text: choice.message?.content ?? "",
      toolCalls,
      usage: {
        inputTokens: promptTokens,
        outputTokens: json.usage?.completion_tokens ?? 0,
        cachedInputTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
      reportedCostUsd: typeof json.usage?.cost === "number" ? json.usage.cost : null,
      stopReason: choice.finish_reason ?? "stop",
    };
  }
}
