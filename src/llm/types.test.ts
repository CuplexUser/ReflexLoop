import { describe, expect, it } from "vitest";
import { isTruncationStop } from "./types.js";

// The vocabulary is the whole content of this function, and it's easy to break by adding a
// provider: OpenRouter passes the upstream provider's spelling through untouched, so a new
// backend can introduce a new word for "I ran out of room" that silently reads as "I finished".
describe("isTruncationStop", () => {
  it("recognizes each provider's spelling of a truncated response", () => {
    expect(isTruncationStop("length")).toBe(true); // OpenAI-compatible
    expect(isTruncationStop("max_tokens")).toBe(true); // Anthropic
    expect(isTruncationStop("MAX_TOKENS")).toBe(true); // Google, via OpenRouter
    expect(isTruncationStop(" Length ")).toBe(true);
  });

  it("treats a deliberate finish as a finish", () => {
    for (const reason of ["stop", "end_turn", "tool_calls", "tool_use", ""]) {
      expect(isTruncationStop(reason)).toBe(false);
    }
  });
});
