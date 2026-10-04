import { describe, expect, it, vi } from "vitest";
import { AbortedError } from "../aborted.js";
import { FailoverClient } from "./failover.js";
import type { ChatMessage, ChatRequest, ChatResponse, LlmClient, ProviderId } from "./types.js";
import { LlmError } from "./types.js";

// Driven through LlmClient, our own neutral interface, for the same reason agent-loop.test.ts is:
// this is routing logic, not anyone's wire format.

vi.mock("./http.js", () => ({ sleep: async () => {} }));

type Step = ChatResponse | Error;

function fakeClient(provider: ProviderId, model: string, steps: Step[]) {
  const seen: ChatMessage[][] = [];
  let index = 0;
  const client: LlmClient = {
    provider,
    model,
    supportsNativeSearch: false,
    async chat(req) {
      seen.push(structuredClone(req.messages));
      const step = steps[Math.min(index++, steps.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    },
    handleNativeToolCall: () => null,
  };
  return { client, seen, calls: () => index };
}

const ok = (text: string, providerRaw?: unknown): ChatResponse => ({
  text,
  toolCalls: [],
  usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  reportedCostUsd: 0,
  stopReason: "stop",
  providerRaw,
});

const transient = () => new LlmError("OpenRouter: Provider returned an empty response", undefined, undefined, true);
const outage = () => new LlmError("OpenRouter chat: HTTP 503 Service Unavailable", 503);

function request(messages: ChatMessage[] = [{ role: "user", content: "go" }]): ChatRequest {
  return { system: "", messages, tools: [], nativeSearch: false, maxTokens: 100 };
}

describe("FailoverClient", () => {
  it("retries a transient in-body error once on the same model before failing over", async () => {
    const primary = fakeClient("openrouter", "a", [transient(), ok("recovered")]);
    const backup = fakeClient("anthropic", "b", [ok("backup")]);
    const failover = new FailoverClient([primary.client, backup.client]);

    const response = await failover.chat(request());

    expect(response.text).toBe("recovered");
    expect(primary.calls()).toBe(2);
    expect(backup.calls()).toBe(0);
    expect(failover.model).toBe("a");
  });

  it("walks the chain in order and reports the switch", async () => {
    const primary = fakeClient("openrouter", "a", [outage()]);
    const second = fakeClient("openrouter", "b", [transient()]);
    const third = fakeClient("anthropic", "c", [ok("third")]);
    const onFailover = vi.fn();
    const failover = new FailoverClient([primary.client, second.client, third.client], onFailover);

    const response = await failover.chat(request());

    expect(response.text).toBe("third");
    // The non-transient outage is not retried here (postJson already did); the transient one is.
    expect([primary.calls(), second.calls(), third.calls()]).toEqual([1, 2, 1]);
    expect(onFailover).toHaveBeenCalledOnce();
    expect(onFailover.mock.calls[0][0]).toMatchObject({ from: "openrouter/a", to: "anthropic/c" });
    // Pricing reads these right after the call, so they must name the model that answered.
    expect([failover.provider, failover.model]).toEqual(["anthropic", "c"]);
  });

  it("stays on the fallback for the rest of the run", async () => {
    const primary = fakeClient("openrouter", "a", [outage(), ok("primary is back")]);
    const backup = fakeClient("anthropic", "b", [ok("one"), ok("two")]);
    const failover = new FailoverClient([primary.client, backup.client]);

    await failover.chat(request());
    const second = await failover.chat(request());

    expect(second.text).toBe("two");
    expect(primary.calls()).toBe(1);
  });

  it("names every model when the whole chain fails", async () => {
    const failover = new FailoverClient([
      fakeClient("openrouter", "a", [outage()]).client,
      fakeClient("anthropic", "b", [new LlmError("Anthropic: HTTP 529 Overloaded", 529)]).client,
    ]);

    await expect(failover.chat(request())).rejects.toThrow(/All 2 models failed.*openrouter\/a.*anthropic\/b/);
  });

  it("does not fail over an abort", async () => {
    const backup = fakeClient("anthropic", "b", [ok("backup")]);
    const failover = new FailoverClient([fakeClient("openrouter", "a", [new AbortedError()]).client, backup.client]);

    await expect(failover.chat(request())).rejects.toBeInstanceOf(AbortedError);
    expect(backup.calls()).toBe(0);
  });

  it("replays a model's raw turn only to the model that produced it", async () => {
    const primary = fakeClient("anthropic", "a", [ok("first", [{ type: "thinking" }]), outage()]);
    const backup = fakeClient("openrouter", "b", [ok("second")]);
    const failover = new FailoverClient([primary.client, backup.client]);

    const first = await failover.chat(request());
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: first.text, toolCalls: [], providerRaw: first.providerRaw },
      { role: "user", content: "continue" },
    ];
    await failover.chat(request(history));

    const replayed = (seen: ChatMessage[][]) => seen.at(-1)?.[1] as Extract<ChatMessage, { role: "assistant" }>;
    expect(replayed(primary.seen).providerRaw).toEqual([{ type: "thinking" }]);
    expect(replayed(backup.seen).providerRaw).toBeUndefined();
    expect(replayed(backup.seen).content).toBe("first");
  });
});
