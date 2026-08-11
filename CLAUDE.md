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
`NETLIFY_AUTH_TOKEN` / `VOYAGE_API_KEY` (+ `VOYAGE_API_BASE_URL`, only needed for a MongoDB
Atlas-issued Voyage key) — each integration or feature is simply unavailable, not a startup error,
when its key is missing.

## Architecture

### The four-phase loop (`src/orchestrator.ts`)

Each cycle: **research + plan → human review → act → outcome + reflect**.

- **research + plan** (`researchAndPlanPhase`) — runs with `permissionMode: "bypassPermissions"` since
  every tool available to it is read-only or writes only to the agent's own memory DB. Can span multiple
  `AGENT_DOMAINS` per cycle and create 0-3 proposals; not forced to cover domains evenly. Calls
  `lesson_search`/`research_note_search` first so it doesn't re-research what's already known, and
  `action_history_search` to see what's already been built/deployed so it doesn't propose duplicate work.
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
  `proposal_create`, `proposal_status`, `outcome_record`, `action_history_search`. Approving proposals,
  logging actions, and marking a run successful are deliberately *not* model-callable tools — those stay
  with the orchestrator and the human. Notes/lessons are embedded and ranked by cosine similarity when
  embeddings are available, falling back to `LIKE` text matching otherwise. Also owns the `events` table
  (persisted activity feed, capped at `EVENTS_KEEP`) and `action_history_search`'s backing query, which
  joins `actions` to `proposals` to answer "what's already been done" for research/plan — restricted to
  `phase = 'act'` on `status = 'approved'` proposals to stay low-noise, unlike the Actions page below
  which shows every phase.
- `embeddings.ts` — Voyage AI (`voyage-3.5`) client for semantic search. Fails soft: no `VOYAGE_API_KEY`,
  or any request error, and `embed()` resolves to `null` so callers fall back to `LIKE`-based search
  instead of throwing. `VOYAGE_API_BASE_URL` (default `api.voyageai.com`) exists because a key only
  authenticates against the endpoint it was issued for — a MongoDB Atlas-issued "Model API key" needs
  `ai.mongodb.com` instead; same request/response schema either way.
- `integrations/{github,vercel,netlify}.ts` + `integrations-server.ts` — thin API wrappers and their MCP
  tools. Read-only tools (`github_read_repo`, `vercel_list_projects`, etc.) are free for the research
  phase to call. Write tools (`github_create_repo`, `vercel_deploy`, `netlify_deploy`, etc.) only work in
  `actPhase`, and only when named in the approved proposal's `required_tools`. Each write tool that
  creates/deploys something returns a plain `url` field on success — `memory-server.ts`'s
  `extractResultUrl` pulls that out generically (by field name, not per-tool switching) to back the
  Actions page's browsable result links.
- `events.ts` / `review-gateway.ts` / `server.ts` — the live layer under the web UI. `events.ts` is an
  in-process bus the orchestrator emits to; `server.ts` persists each event via `store.logEvent()` *then*
  rebroadcasts it over WebSocket with the same `{id, occurredAt}` the DB assigned, and serves the REST API
  (proposal/action/event history), and in production also serves the built `web/dist` static files;
  `review-gateway.ts` resolves a proposal's pending approval promise when a decision comes in via the API.
- `smoke-test.ts` — exercises `MemoryStore` directly against a throwaway DB, no API key needed.

### Frontend (`web/`)

React + TypeScript + Ant Design (dark theme, see `web/src/theme.ts` for the palette), linted with
oxlint, talking to `src/server.ts` over REST (`web/src/api.ts`) and WebSocket
(`web/src/useAgentSocket.ts`). Pages live in `web/src/pages/`: Dashboard (pending proposals + stat tiles
+ recent activity), Live feed (full filterable activity stream), Proposals (full history; click a row to
open `ProposalDialog` with full description/stats/tool calls and Approve/Reject for pending ones),
Actions (every tool call on an *approved* proposal — action type, an input-derived description, and a
browsable result URL when the tool returned one; phase-filterable, click a row for full input/output
JSON via `ActionDialog`), Lessons, Research notes.

Table cells that need to show long free text (a proposal description, a lesson, etc.) use the column's
own `ellipsis: true` (plain CSS truncation + native title tooltip) and a click-to-open dialog for the
full text — not AntD's `Typography.Text ellipsis={{tooltip}}`, which double-measures against the
column's own truncation and visibly flickers on hover. Keep new long-text columns consistent with this.

`useAgentSocket.ts` tracks a `historyVersion` counter that bumps on state-changing WebSocket events
(`proposal_decided`, etc.); `App.tsx`/page components refetch their REST data (`/api/proposals`,
`/api/outcomes`, `/api/actions`, etc.) whenever it changes, so REST-fetched state stays in sync with what
the WebSocket reports without polling. The activity feed itself is seeded from `GET /api/events` on
mount and merged with live WebSocket events by server-assigned id (de-duped, ordered) so a page reload
doesn't lose history — replaying that same event log is also what reconstructs `pendingProposals` and
`runningPhase` on load, not just the visible feed.

The web console has **no authentication** — `server.ts` binds on all interfaces with nothing gating
`/api/proposals/:id/decision`. Fine on localhost; don't expose it beyond that without adding auth first.
