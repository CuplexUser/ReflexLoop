import { describe, expect, it } from "vitest";
import { AbortedError, isAbortError } from "./aborted.js";

// Both shapes matter, and only one of them is ours. If this stops recognizing fetch's
// DOMException, a Ctrl-C goes back to printing a stack trace and calling itself a failure.
describe("isAbortError", () => {
  it("recognizes an aborted fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await fetch("http://127.0.0.1:1/", { signal: controller.signal }).then(
      () => null,
      (e: unknown) => e
    );
    expect(isAbortError(err)).toBe(true);
  });

  it("recognizes our own throw, raised when a loop notices the signal between calls", () => {
    expect(isAbortError(new AbortedError())).toBe(true);
  });

  it("does not swallow a real failure", () => {
    expect(isAbortError(new Error("HTTP 500"))).toBe(false);
    expect(isAbortError(new TypeError("fetch failed"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});
