# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An autonomous Claude agent (via the Agent SDK, not the chat UI) that researches money-making
opportunities, proposes concrete plans, and — only after a human approves in a web console — acts on
them, records the real outcome, and distills a lesson for next time. No sub-agents: `agents` is never
set in `orchestrator.ts`, so the model has no Agent/Task tool to spawn one.

**The core invariant: no proposal, no action, ever.** Every real-world side-effecting tool call
(creating a repo, deploying, etc.) only runs inside `actPhase`, gated by a `canUseTool` fence limited to
exactly the tools the human-approved proposal named. Don't add anything that auto-approves proposals or
lets `actPhase` reach beyond `proposal.required_tools` — that removes the one safeguard the rest of the
design assumes is there.

## Commands

```bash
npm install
npm run smoke-test    # sanity-checks the DB + tool wiring directly, no API key needed — run this first
npm run typecheck     # tsc --noEmit over src/
npm start             # tsx src/orchestrator.ts — runs the agent loop + web console together (one process, one SQLite connection)
```

There is no automated test suite beyond `smoke-test.ts` (`src/smoke-test.ts`) — it exercises
`MemoryStore` directly against a throwaway `./data/smoke-test.db`.

Frontend (`web/`), run from `web/` or via the root proxies:

```bash
npm run web:dev       # Vite dev server with hot reload; proxies /api and /ws to the backend on AGENT_SERVER_PORT
npm run web:build     # production build to web/dist — this is what src/server.ts serves during `npm start`
npm run web:lint      # oxlint over web/
```

For frontend work, run `npm start` (backend) and `npm run web:dev` (frontend) side by side rather than
rebuilding `web/dist` on every change.

`.env` (copy from `.env.example`): `ANTHROPIC_API_KEY` (skip if logged in via `claude setup-token`),
`AGENT_DOMAINS`, `AGENT_DB_PATH`, `AGENT_CYCLE_INTERVAL_MS`, `AGENT_MAX_PENDING_PROPOSALS`,
`AGENT_SERVER_PORT`, and optional integration keys `GITHUB_TOKEN` / `VERCEL_TOKEN` /
`NETLIFY_AUTH_TOKEN` / `VOYAGE_API_KEY` — each integration or feature is simply unavailable, not a
startup error, when its key is missing.

## Architecture

### The four-phase loop (`src/orchestrator.ts`)

Each cycle: **research + plan → human review → act → outcome + reflect**.

- **research + plan** (`researchAndPlanPhase`) — runs with `permissionMode: "bypassPermissions"` since
  every tool available to it is read-only or writes only to the agent's own memory DB. Can span multiple
  `AGENT_DOMAINS` per cycle and create 0-3 proposals; not forced to cover domains evenly. Calls
  `lesson_search`/`research_note_search` first so it doesn't re-research what's already known.
- **human review** (`humanReviewPhase`) — emits a `proposal_pending` event and blocks on
  `waitForDecision()` (`review-gateway.ts`), resolved when a person clicks Approve/Reject in the web UI
  (`POST /api/proposals/:id/decision`). Multiple proposals can be under review concurrently, each on its
  own promise.
- **act** (`actPhase`) — tool access is hard-limited to exactly `proposal.required_tools` plus memory
  tools, enforced by both `allowedTools` and an independent `canUseTool` callback (belt and suspenders:
  `allowedTools` alone only works if the model is never told about the broader tool at all).
- **reflect** (`reflectPhase`) — calls `lesson_search` first; reinforces an existing lesson via
  `lesson_reinforce` if this outcome confirmed/contradicted it, otherwise adds one new generalized lesson.

**Concurrency**: research runs one cycle at a time on `AGENT_CYCLE_INTERVAL_MS`. Every new proposal
immediately starts waiting for review in parallel with any others already pending. Once approved, a
proposal's act+reflect is pushed onto a single serialized chain (`scheduleActAndReflect`/`actChainTail`)
so side-effecting tool calls from different proposals never run concurrently, even if several are
approved back to back.

Every tool call in every phase is logged via a `PostToolUse` hook in `runPhase`, and every phase's Claude
API cost (`total_cost_usd` from the SDK) is recorded — spend counts against profit.

### Backend modules (`src/`)

- `memory-server.ts` — SQLite-backed memory (`data/agent.db`) plus the MCP tools the model can call:
  `research_note_add`, `research_note_search`, `lesson_search`, `lesson_add`, `lesson_reinforce`,
  `proposal_create`, `proposal_status`, `outcome_record`. Approving proposals, logging actions, and
  marking a run successful are deliberately *not* model-callable tools — those stay with the
  orchestrator and the human. Notes/lessons are embedded and ranked by cosine similarity when embeddings
  are available, falling back to `LIKE` text matching otherwise.
- `embeddings.ts` — Voyage AI (`voyage-3.5`) client for semantic search. Fails soft: no `VOYAGE_API_KEY`,
  or any request error, and `embed()` resolves to `null` so callers fall back to `LIKE`-based search
  instead of throwing.
- `integrations/{github,vercel,netlify}.ts` + `integrations-server.ts` — thin API wrappers and their MCP
  tools. Read-only tools (`github_read_repo`, `vercel_list_projects`, etc.) are free for the research
  phase to call. Write tools (`github_create_repo`, `vercel_deploy`, `netlify_deploy`, etc.) only work in
  `actPhase`, and only when named in the approved proposal's `required_tools`.
- `events.ts` / `review-gateway.ts` / `server.ts` — the live layer under the web UI. `events.ts` is an
  in-process bus the orchestrator emits to; `server.ts` rebroadcasts those events over WebSocket and
  serves the REST API (including proposal history), and in production also serves the built `web/dist`
  static files; `review-gateway.ts` resolves a proposal's pending approval promise when a decision comes
  in via the API.
- `smoke-test.ts` — exercises `MemoryStore` directly against a throwaway DB, no API key needed.

### Frontend (`web/`)

React + TypeScript + Ant Design (dark theme, see `web/src/theme.ts` for the palette), linted with
oxlint, talking to `src/server.ts` over REST (`web/src/api.ts`) and WebSocket
(`web/src/useAgentSocket.ts`). Pages live in `web/src/pages/`: Dashboard (pending proposals + stat tiles
+ recent activity), Live feed (full filterable activity stream), Proposals (full history; click a row to
open `ProposalDialog` with full description/stats/tool calls and Approve/Reject for pending ones),
Lessons, Research notes.

`useAgentSocket.ts` tracks a `historyVersion` counter that bumps on state-changing WebSocket events
(`proposal_decided`, etc.); `App.tsx` refetches `/api/proposals` and `/api/outcomes` whenever it changes,
so REST-fetched state stays in sync with what the WebSocket reports without polling.

The web console has **no authentication** — `server.ts` binds on all interfaces with nothing gating
`/api/proposals/:id/decision`. Fine on localhost; don't expose it beyond that without adding auth first.
