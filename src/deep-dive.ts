// src/deep-dive.ts
//
// Did a deep dive do the one thing it exists to do -- submit a report?
//
// Pure functions over the phase's tool calls, so no store and no API key, and unit-tested in
// deep-dive.test.ts. Replaces the build-mode act verifier, which checked each approved step's
// declared tool against the calls that ran. A deep dive has no step list to check: its only
// required output is one `report_submit` that the tool itself accepted.
//
// Truncation, exhausted turns and a phase with zero tool calls are reported separately from
// "no report", because they call for different responses -- the first two say the model ran out
// of room, the third that it never researched at all.

import type { AgentStopReason, ObservedCall } from "./agent-loop.js";
import { isTruncationStop } from "./llm/types.js";

export const REPORT_SUBMIT_TOOL = "mcp__memory__report_submit";

export interface DeepDiveVerdict {
  /** True iff a report was accepted. */
  complete: boolean;
  /** Everything that went wrong, in the order it matters. Empty when complete. */
  problems: string[];
}

/** Whether a `report_submit` call landed. One the tool refused (isError) does not count. */
export function reportSubmitted(calls: ObservedCall[]): boolean {
  return calls.some((c) => c.name === REPORT_SUBMIT_TOOL && !c.isError);
}

export function verifyDeepDive(run: {
  toolCalls: ObservedCall[];
  stopReason: AgentStopReason;
  providerStopReason?: string;
}): DeepDiveVerdict {
  if (reportSubmitted(run.toolCalls)) return { complete: true, problems: [] };

  const problems: string[] = [];
  if (run.toolCalls.length === 0) {
    problems.push(
      `The deep dive made no tool calls at all, so it never researched anything${
        run.providerStopReason ? ` (provider finish reason "${run.providerStopReason}")` : ""
      }.`
    );
  }
  if (run.stopReason === "truncated") {
    problems.push("The model was cut off at the output limit before it finished.");
  } else if (run.stopReason === "max_turns") {
    problems.push("The deep dive used all of its turns before submitting a report.");
  }
  const refused = run.toolCalls.filter((c) => c.name === REPORT_SUBMIT_TOOL && c.isError).length;
  problems.push(
    refused > 0
      ? `No report was saved: report_submit was called ${refused} time(s) and refused each time.`
      : "No report was submitted."
  );
  return { complete: false, problems };
}

/**
 * The push-back when a deep dive stops without a report, or null to let it end.
 *
 * The truncated case gets different advice on purpose: a deep dive cut off mid-turn was almost
 * always writing the report as a message, and "submit the report" alone would be answered by
 * writing it as a message again.
 */
export function deepDiveNudge(calls: ObservedCall[], providerStopReason: string): string | null {
  if (reportSubmitted(calls)) return null;
  return [
    `Stop. This deep dive does not end until report_submit has accepted your report.`,
    ...(isTruncationStop(providerStopReason)
      ? [
          `Your last turn was cut off, which usually means the report was being written as a message. Put it in the report_submit call instead, and keep the body under about 2,500 words.`,
        ]
      : []),
    `Call report_submit now with what you have. If the evidence is thin, say so: set confidence to "low" and list what is unknown under Open questions. Do not describe the report -- submit it.`,
  ].join("\n");
}
