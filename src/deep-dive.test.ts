import { describe, expect, it } from "vitest";
import { deepDiveNudge, REPORT_SUBMIT_TOOL, verifyDeepDive } from "./deep-dive.js";

const call = (name: string, isError = false) => ({ name, isError });

describe("verifyDeepDive", () => {
  it("is complete once report_submit was accepted", () => {
    const verdict = verifyDeepDive({
      toolCalls: [call("WebSearch"), call("mcp__memory__research_note_add"), call(REPORT_SUBMIT_TOOL)],
      stopReason: "end_turn",
    });
    expect(verdict).toEqual({ complete: true, problems: [] });
  });

  it("does not count a refused report", () => {
    const verdict = verifyDeepDive({
      toolCalls: [call("WebSearch"), call(REPORT_SUBMIT_TOOL, true)],
      stopReason: "end_turn",
    });
    expect(verdict.complete).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/refused/);
  });

  it("reports a phase that never researched separately from a missing report", () => {
    const verdict = verifyDeepDive({ toolCalls: [], stopReason: "end_turn", providerStopReason: "stop" });
    expect(verdict.complete).toBe(false);
    expect(verdict.problems[0]).toMatch(/no tool calls/);
    expect(verdict.problems[0]).toMatch(/"stop"/);
    expect(verdict.problems.at(-1)).toBe("No report was submitted.");
  });

  it("names truncation and exhausted turns", () => {
    expect(verifyDeepDive({ toolCalls: [call("WebFetch")], stopReason: "truncated" }).problems[0]).toMatch(/cut off/);
    expect(verifyDeepDive({ toolCalls: [call("WebFetch")], stopReason: "max_turns" }).problems[0]).toMatch(/turns/);
  });
});

describe("deepDiveNudge", () => {
  it("lets the run end once a report is in", () => {
    expect(deepDiveNudge([call(REPORT_SUBMIT_TOOL)], "end_turn")).toBeNull();
  });

  it("insists on the report otherwise", () => {
    const nudge = deepDiveNudge([call("WebSearch"), call(REPORT_SUBMIT_TOOL, true)], "end_turn");
    expect(nudge).toMatch(/report_submit/);
    expect(nudge).not.toMatch(/cut off/);
  });

  it("tells a truncated turn to put the report in the call", () => {
    expect(deepDiveNudge([call("WebSearch")], "max_tokens")).toMatch(/cut off/);
  });
});
