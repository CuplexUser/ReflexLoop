# agent-runner

A Claude Code agent with persistent memory, run outside any chat UI via the
Agent SDK, with a web console (React + Ant Design) to watch it work and
approve or reject what it wants to do. No sub-agents: the `agents` option is
never set anywhere in `orchestrator.ts`, so the model has no Agent/Task tool
to spawn one.

## How it works

Each cycle: **research + plan → your approval → act → record outcome →
reflect into a lesson**, then repeat. Research can span several domains at
once and surface more than one proposal per cycle; several proposals can sit
pending review at the same time, but only one proposal's act+reflect phase
ever runs at a time, so real-world side-effecting tool calls never overlap.

**No proposal, no action, ever.** Approval happens in the web UI now instead
of a stdin prompt, but the invariant is the same one this design has always
been built around: nothing with real-world effect runs without a proposal a
human explicitly approved. Don't wire anything to auto-approve "to save
time" — that deletes the one safeguard the rest of the design assumes is
there.

## Files

- `src/memory-server.ts` — SQLite-backed memory (`data/agent.db`) plus the
  MCP tools the agent can call: `research_note_add`, `research_note_search`,
  `lesson_search`, `lesson_add`, `lesson_reinforce`, `proposal_create`,
  `proposal_status`, `outcome_record`. Approving proposals, logging actions,
  and marking a run successful are deliberately *not* tools the model has —
  those stay with the orchestrator and with you. Research notes and lessons
  are embedded (see Semantic search below) and ranked by similarity instead
  of exact/`LIKE` text matching, when embeddings are available.
- `src/orchestrator.ts` — the main loop and its four phases. Every tool call
  is logged automatically via a `PostToolUse` hook, and every phase's Claude
  API cost is recorded so spend counts against profit.
- `src/integrations/{github,vercel,netlify}.ts` + `src/integrations-server.ts`
  — thin API wrappers and the MCP tools built on them. Read-only tools
  (`github_read_repo`, `vercel_list_projects`, etc.) are free for research to
  call, same as `WebSearch`. Write tools (`github_create_repo`,
  `vercel_deploy`, `netlify_deploy`, etc.) only work when an approved
  proposal's `required_tools` names them — enforced by the `canUseTool` fence
  in `actPhase`, not just by convention.
- `src/embeddings.ts` — Voyage AI client for semantic search. Fails soft: with
  no `VOYAGE_API_KEY`, everything falls back to the old `LIKE`-based search.
- `src/events.ts` / `src/review-gateway.ts` / `src/server.ts` — the live layer
  the web UI runs on. `events.ts` is an in-process bus the orchestrator emits
  to as it works; `server.ts` rebroadcasts those over WebSocket and serves a
  REST API for history; `review-gateway.ts` is how a proposal's approval
  promise gets resolved when someone clicks Approve/Reject.
- `web/` — the console itself: React + TypeScript + Ant Design, linted with
  oxlint. Talks to `src/server.ts` over REST + WebSocket.
- `src/smoke-test.ts` — exercises the memory store directly, no API key
  needed. Run this first.

## Setup

```bash
npm install
npm run smoke-test   # sanity-checks the DB and tool wiring, no API calls
npm run typecheck
```

Copy `.env.example` to `.env` and fill in what you have:

- `ANTHROPIC_API_KEY` — needed for `npm start` to actually run the agent
  (skip if you're logged in via `claude setup-token`).
- `AGENT_DOMAINS` — comma-separated lanes research considers each cycle
  (default covers micro-SaaS/Chrome-extension/VS Code-extension ideas for
  developers). See the tradeoff note below before adding many.
- `GITHUB_TOKEN` / `VERCEL_TOKEN` / `NETLIFY_AUTH_TOKEN` — optional; omit any
  of them and that integration's tools simply aren't usable. No Stripe
  integration yet.
- `VOYAGE_API_KEY` — optional; enables semantic search.

Then:

```bash
npm start
```

This starts the agent loop *and* the web console together (they share one
process and one SQLite connection — no multi-process file locking). Open
`http://localhost:4001` (or your `AGENT_SERVER_PORT`) to watch it research,
review proposals as they come in, and see history/lessons/research notes.

For frontend development with hot reload, run the backend and the Vite dev
server side by side:

```bash
npm start          # backend + API on AGENT_SERVER_PORT
npm run web:dev     # Vite dev server, proxies /api and /ws to the backend
```

`npm run web:build` produces the static build `src/server.ts` serves in the
`npm start` flow above; `npm run web:lint` runs oxlint over `web/`.

## The web console

- **Dashboard** — pending proposals (if any), spend/revenue/net stat tiles,
  and a live activity feed.
- **Live feed** — the full activity stream, filterable by phase: every tool
  call and model narration as it happens.
- **Proposals** — full history with status, expandable to the outcome and
  every tool call a given proposal's act phase made.
- **Lessons** / **Research notes** — the accumulated memory, browsable.

Approving or rejecting a proposal calls `POST /api/proposals/:id/decision`,
which resolves that proposal's pending promise in `review-gateway.ts` —
nothing is polled or written to a file.

## Semantic search

`research_note_search` and `lesson_search` embed with Voyage AI (Anthropic's
recommended embeddings provider) and rank by cosine similarity when
`VOYAGE_API_KEY` is set, so a lesson written for "VS Code extension for
productivity" can still surface for a proposal in "VS Code extensions" —
wording doesn't have to match. Without a key, both fall back to the original
`LIKE`-based search, so nothing breaks if you skip it.

## Multiple domains, multiple proposals

`AGENT_DOMAINS` can list more than one lane, and a single research cycle can
propose across whichever domain looks best rather than being forced to
rotate evenly. Several proposals can be pending review at once — useful if
you're triaging in batches — but `AGENT_MAX_PENDING_PROPOSALS` (default 5)
pauses research once the queue is that full, so it can't grow unbounded
while you're away.

The tradeoff: `lesson_search`'s domain matching is now semantic rather than
exact, which offsets some of this, but outcomes still accumulate faster
per-domain with fewer, narrower lanes. More lanes means more breadth, slower
signal in any one of them.

## Before running unattended

- **The `canUseTool` gate in `actPhase` is a hard fence, not the whole
  safety story.** It stops the agent from touching tools outside what you
  approved; it doesn't stop it from using an approved tool badly. Keep
  `expectedCost` realistic and don't approve proposals whose downside you
  wouldn't accept.
- **The web console has no authentication.** `src/server.ts` binds on all
  interfaces with nothing gating `/api/proposals/:id/decision` — anyone who
  can reach the port can approve spending. Fine on localhost; if you expose
  it beyond that (a tunnel, a VPS), put auth in front of it first.
- **No proposal, no action, ever.** Still true, still the point.
