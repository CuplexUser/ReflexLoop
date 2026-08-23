// src/mcp/args.ts
//
// Argument schemas shared across tool modules, so `limit` means the same thing and carries
// the same description wherever it appears.

import "../mcp-env.js";
import { z } from "zod";
import { NOTE_KINDS } from "../memory-server.js";

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;
/** Over-fetch for filters the store has no SQL for, then narrow in JS. */
export const FILTER_SCAN = 500;

export const limitArg = z
  .number()
  .int()
  .min(1)
  .max(MAX_LIMIT)
  .optional()
  .describe(`How many rows to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`);

export const goalArg = z
  .string()
  .optional()
  .describe("Restrict to one goal, by its title (case-insensitive; a substring is enough).");

export const kindArg = z
  .enum(NOTE_KINDS)
  .optional()
  .describe("Restrict to one kind of finding. 'saturated' means ground already ruled out.");
