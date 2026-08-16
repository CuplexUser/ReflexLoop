// src/aborted.ts
//
// One way to say "this was interrupted on purpose", so the callers unwinding a phase can tell
// a deliberate stop from a real failure.
//
// Both deliberate stops -- Ctrl-C (shutdown.ts aborts every in-flight phase) and the console's
// abort button -- surface as a thrown error at the top of a phase, exactly like a provider 500
// or a bug would. Reported as failures they read as one: a clean Ctrl-C printed
// `[act] proposal #30 failed: DOMException [AbortError]` and a stack pointing at our own
// `abortController.abort()`, immediately above `Bye.` -- an error message for the success path.
//
// Sniffing this off the message text isn't enough, because an abort arrives in two shapes: a
// `DOMException` named `AbortError` when it interrupts an in-flight fetch, and our own throw
// when a loop notices `signal.aborted` between calls. `AbortedError` gives the second one a
// type, and `isAbortError` covers both.

export class AbortedError extends Error {
  constructor(message = "Aborted") {
    super(message);
    this.name = "AbortedError";
  }
}

/** True for either shape of deliberate abort: our own throw, or fetch's `AbortError`. */
export function isAbortError(err: unknown): boolean {
  if (err instanceof AbortedError) return true;
  // Duck-typed rather than `instanceof DOMException`: the platform class is what fetch throws,
  // and its identity is not something this module should depend on.
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}
