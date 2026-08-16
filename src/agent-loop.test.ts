import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runAgent } from "./agent-loop.js";
import type { ChatMessage, ChatResponse, LlmClient, ToolCall } from "./llm/types.js";
import { defineTool, ToolRegistry } from "./tools/registry.js";

// The loop itself is deliberately not unit-tested as a rule -- it's thin over HTTP and a mock of
// a provider's wire format mostly tests the mock. The nudge is the exception: it is loop logic
// rather than wire format, it's driven through `LlmClient`, which is our own neutral interface
// and not any provider's shape, and it is the recovery path for a failure that has now happened
// twice in production (proposals #27 and #29, both leaving an empty repo).

vi.mock("./search/index.js", () => ({
  getSearchConfig: () => ({ mode: "tavily", provider: {} }),
}));

type Turn = Partial<ChatResponse>;

/** Replays a fixed script of model turns, recording the messages it was sent each time. */
function scriptedClient(turns: Turn[]) {
  const seen: ChatMessage[][] = [];
  let index = 0;
  const client: LlmClient = {
    provider: "openrouter",
    model: "test-model",
    supportsNativeSearch: false,
    async chat(req) {
      seen.push(structuredClone(req.messages));
      const turn = turns[Math.min(index++, turns.length - 1)];
      return {
        text: "",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        reportedCostUsd: 0,
        stopReason: "stop",
        ...turn,
      };
    },
    handleNativeToolCall: () => null,
  };
  return { client, seen, callCount: () => index };
}

const commit = (id = "c1"): ToolCall => ({
  id,
  name: "mcp__integrations__github_commit_files",
  args: { owner: "CuplexUser", repo: "machwatch" },
  rawArgs: "{}",
});

function registry() {
  return new ToolRegistry([
    defineTool(
      "mcp__integrations__github_commit_files",
      "commit files",
      { owner: z.string(), repo: z.string() },
      async () => JSON.stringify({ commitSha: "abc123" })
    ),
  ]);
}

const ALLOWED = ["mcp__integrations__github_commit_files"];

describe("runAgent nudge", () => {
  /** The exact shape of the machwatch failure: the model announces the write and calls nothing. */
  const ANNOUNCED_BUT_DID_NOTHING: Turn = {
    text: "All three moving parts verified. Now I'll write the full prototype and commit it in one call.",
    stopReason: "stop",
  };

  it("pushes back when the model stops without doing the work, and it recovers", async () => {
    const { client, callCount } = scriptedClient([
      ANNOUNCED_BUT_DID_NOTHING,
      { text: "Committing now.", toolCalls: [commit()] },
      { text: "Done.", stopReason: "stop" },
    ]);
    const done: string[] = [];

    const result = await runAgent({
      client,
      registry: registry(),
      system: "s",
      prompt: "p",
      allowedTools: ALLOWED,
      maxTurns: 10,
      onToolCall: (name) => void done.push(name),
      nudge: ({ calls }) => (calls.length === 0 ? "You have not committed anything. Call it now." : null),
    });

    expect(done).toEqual(["mcp__integrations__github_commit_files"]);
    expect(callCount()).toBe(3);
    expect(result.stopReason).toBe("end_turn");
  });

  it("sends the nudge as a user turn after the model's own, keeping the transcript intact", async () => {
    const { client, seen } = scriptedClient([ANNOUNCED_BUT_DID_NOTHING, { text: "ok", stopReason: "stop" }]);

    await runAgent({
      client,
      registry: registry(),
      system: "s",
      prompt: "p",
      allowedTools: ALLOWED,
      maxTurns: 10,
      nudge: ({ calls }) => (calls.length === 0 ? "Call github_commit_files now." : null),
    });

    // Second request: the original prompt, the model's announcement, then the nudge. Keeping the
    // model's own turn is the point -- all the reading it did stays in context, so it finishes
    // the job instead of starting over.
    const second = seen[1];
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second[1].content).toContain("Now I'll write the full prototype");
    expect(second[2].content).toBe("Call github_commit_files now.");
  });

  it("stops nudging after two, rather than arguing with a stuck model forever", async () => {
    const { client, callCount } = scriptedClient([ANNOUNCED_BUT_DID_NOTHING]); // never complies
    let nudges = 0;

    const result = await runAgent({
      client,
      registry: registry(),
      system: "s",
      prompt: "p",
      allowedTools: ALLOWED,
      maxTurns: 30,
      nudge: () => {
        nudges++;
        return "Do the work.";
      },
    });

    expect(nudges).toBe(2);
    expect(callCount()).toBe(3); // the original turn plus one per nudge
    expect(result.stopReason).toBe("end_turn");
  });

  it("accepts a null nudge as 'genuinely finished' and ends immediately", async () => {
    const { client, callCount } = scriptedClient([{ text: "All done.", stopReason: "stop" }]);

    await runAgent({
      client,
      registry: registry(),
      system: "s",
      prompt: "p",
      allowedTools: ALLOWED,
      maxTurns: 10,
      nudge: () => null,
    });

    expect(callCount()).toBe(1);
  });

  it("nudges a truncated turn too, and still reports the truncation if it never recovers", async () => {
    const { client } = scriptedClient([{ text: "Writing the files", stopReason: "length" }]);
    const seenStopReasons: string[] = [];

    const result = await runAgent({
      client,
      registry: registry(),
      system: "s",
      prompt: "p",
      allowedTools: ALLOWED,
      maxTurns: 10,
      nudge: ({ stopReason }) => {
        seenStopReasons.push(stopReason);
        return seenStopReasons.length === 1 ? "Split it into smaller commits." : null;
      },
    });

    expect(seenStopReasons[0]).toBe("length");
    expect(result.stopReason).toBe("truncated");
    expect(result.providerStopReason).toBe("length");
  });

  it("replaces an empty assistant turn with a placeholder rather than sending nothing", async () => {
    // An empty assistant message is a 400 from Anthropic, and dropping the turn would put two
    // user messages back to back, which it also rejects.
    const { client, seen } = scriptedClient([{ text: "", stopReason: "stop" }, { text: "ok" }]);

    await runAgent({
      client,
      registry: registry(),
      system: "s",
      prompt: "p",
      allowedTools: ALLOWED,
      maxTurns: 10,
      nudge: ({ calls }) => (calls.length === 0 ? "Do the work." : null),
    });

    expect(seen[1][1]).toMatchObject({ role: "assistant", content: "(no output)" });
  });

  it("reports the provider's finish reason even on an ordinary finish", async () => {
    const { client } = scriptedClient([{ text: "done", stopReason: "stop" }]);

    const result = await runAgent({
      client,
      registry: registry(),
      system: "s",
      prompt: "p",
      allowedTools: ALLOWED,
      maxTurns: 10,
    });

    expect(result.providerStopReason).toBe("stop");
  });

  it("carries the failed calls into the nudge, so a retried tool isn't mistaken for done", async () => {
    const failing = new ToolRegistry([
      defineTool(
        "mcp__integrations__github_commit_files",
        "commit files",
        { owner: z.string(), repo: z.string() },
        async () => {
          throw new Error("409: Git Repository is empty.");
        }
      ),
    ]);
    const { client } = scriptedClient([{ toolCalls: [commit()] }, { text: "Gave up.", stopReason: "stop" }]);
    let observed: { name: string; isError: boolean }[] = [];

    await runAgent({
      client,
      registry: failing,
      system: "s",
      prompt: "p",
      allowedTools: ALLOWED,
      maxTurns: 10,
      nudge: ({ calls }) => {
        observed = calls;
        return null;
      },
    });

    expect(observed).toEqual([{ name: "mcp__integrations__github_commit_files", isError: true }]);
  });
});
