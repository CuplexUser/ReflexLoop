# agent-runner

A Claude Code agent with persistent memory, run outside any chat UI via the
Agent SDK, with a web console (React + Ant Design) to watch it work, approve
or reject what it wants to do, and set priority/scheduling on approved work.
No sub-agents: the `agents` option is never set anywhere in
`orchestrator.ts`, so the model has no Agent/Task tool to spawn one.

## How it works

Each cycle: **research + plan → your approval → act → record outcome →
reflect into a lesson**, then repeat. Research can span several domains at
once and surface more than one proposal per cycle; several proposals can sit
pending review at the same time.

At approval time you also set **priority** (low/normal/high/urgent) and,
optionally, a **schedule** — run now, run at a future date/time, or repeat on
a cadence until cancelled. Only one proposal's act+reflect phase ever runs at
a time, so real-world side-effecting tool calls never overlap — but *which*
approved proposal runs next is priority-then-due-time ordered, not just
arrival order. A scheduler tick (`AGENT_SCHEDULER_TICK_MS`, default 15s)
wakes up anything due; approving something for right now still runs
immediately, same as before this existed.

Marking an approved proposal's shipped deliverable **"needs refinement"**
(Actions page) kicks off a focused, out-of-cycle research+plan pass aimed at
exactly that proposal instead of waiting for the next scheduled cycle — it
can still only ever produce a new proposal for you to review, never an
action, and repeat toggling is cooldown-limited so it can't spam the API.

**Browser notifications** (no email, no push service — only while the tab is
open) fire when a proposal is newly pending review and when a
scheduled/recurring run is about to start. Opt in via the bell icon in the
console; browsers require a user gesture to grant the permission, so it's
never requested automatically.

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
  `proposal_status`, `outcome_record`, `action_history_search`. Approving
  proposals, setting priority/schedule, logging actions, and marking a run
  successful are deliberately *not* tools the model has — those stay with
  the orchestrator and with you. Research notes and lessons are embedded
  (see Semantic search below) and ranked by similarity instead of
  exact/`LIKE` text matching, when Qdrant is configured.
  `action_history_search` lets research/plan see what's already been
  built/deployed/committed on approved proposals so it doesn't propose
  duplicate work.
- `src/orchestrator.ts` — the main loop, its four phases, and a priority
  queue + scheduler tick that decides which approved proposal's act+reflect
  runs next. Every tool call is logged via a `PostToolUse` hook, and every
  phase's Claude API cost is recorded so spend counts against profit. Tool
  access in every phase is enforced in three independent layers, not one:
  `settingSources: []` (ignore this machine's own Claude Code settings, so a
  developer's local allow-rules can't leak permissions into the agent),
  `canUseTool` (denies anything outside the phase's declared allowlist), and
  a `PreToolUse` hook (the layer that actually catches *everything*,
  including SDK-internal tool calls that bypass `canUseTool` — see "Before
  running unattended" below for why all three are needed).
- `src/reactive-triggers.ts` — a small fire-and-forget bridge: marking a
  proposal "needs refinement" in the UI wakes a targeted research+plan pass
  for that one proposal, independent of the hourly cycle.
- `src/integrations/{github,vercel,netlify}.ts` + `src/integrations-server.ts`
  — thin API wrappers and the MCP tools built on them. Read-only tools
  (`github_read_repo`, `vercel_list_projects`, etc.) are free for research to
  call, same as `WebSearch`. Write tools (`github_create_repo`,
  `github_commit_files`, `github_merge_pr`, `vercel_deploy`,
  `netlify_deploy`, etc.) only work when an approved proposal's
  `required_tools` names them — enforced by the same layered fence as above,
  not just by convention. `github_commit_files` writes any number of files
  as a single commit (Git Data API: blob → tree → commit → ref update) and
  is preferred over the older one-file-per-call `github_commit_file`;
  `github_merge_pr` exists so a proposal that opens a PR can also land it
  instead of leaving the default branch empty.
- `src/qdrant.ts` — Qdrant Cloud client: vector storage/search plus
  server-side embedding inference (Cloud Inference) in the same request, so
  there's no separate embeddings provider to rate-limit against. Fails soft:
  without `QDRANT_URL` + `QDRANT_API_KEY` + `QDRANT_EMBEDDING_MODEL` +
  `QDRANT_EMBEDDING_DIM` all set, everything falls back to the old
  `LIKE`-based search.
- `src/events.ts` / `src/review-gateway.ts` / `src/server.ts` — the live layer
  the web UI runs on. `events.ts` is an in-process bus the orchestrator emits
  to as it works (including `proposal_scheduled` and `scheduled_run_starting`
  for the scheduling feature); `server.ts` persists each event and
  rebroadcasts it over WebSocket, and serves a REST API for history;
  `review-gateway.ts` is how a proposal's approval promise gets resolved
  when someone clicks Approve/Reject, priority/schedule included.
- `web/` — the console itself: React + TypeScript + Ant Design, linted with
  oxlint. Tables (Proposals, Actions, Lessons, Research notes) are
  resizable, sortable, filterable, and searchable. The Actions page groups
  every tool call by its parent proposal (expandable rows), shows expected
  vs. actual cost/time/upside, and lets you mark a shipped deliverable "MVP
  done" or "needs refinement" — a human verdict independent of the model's
  self-reported outcome, and the trigger for the reactive research pass
  above. Talks to `src/server.ts` over REST + WebSocket.
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
  (default covers small-business/consumer web tools, a general-audience
  Chrome extension, and a free web calculator/tool — not developer-only).
  See the tradeoff note below before adding many.
- `GITHUB_TOKEN` / `VERCEL_TOKEN` / `NETLIFY_AUTH_TOKEN` — optional; omit any
  of them and that integration's tools simply aren't usable. No Stripe
  integration yet.
- `QDRANT_URL` + `QDRANT_API_KEY` + `QDRANT_EMBEDDING_MODEL` +
  `QDRANT_EMBEDDING_DIM` (+ `QDRANT_EMBEDDING_DISTANCE`) — optional, but all
  four of the first group are required together; enables semantic search.
  Free cluster at [cloud.qdrant.io](https://cloud.qdrant.io), no credit card
  needed — model name and dimension are listed per-cluster in the Cloud
  Console's Inference tab.
- `AGENT_SCHEDULER_TICK_MS` — optional, default 15000; how often the
  scheduler checks for approved proposals whose scheduled/recurring run is
  due.

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
  and a live activity feed. The activity feed is persisted server-side
  (`events` table) and reloaded on page load, so a refresh doesn't lose it.
- **Live feed** — the full activity stream, filterable by phase: every tool
  call and model narration as it happens.
- **Proposals** — full history with status, priority, and schedule; click a
  row to open a dialog with the full description, stats, tool calls, and
  Approve/Reject (with priority/schedule fields) for pending ones.
- **Actions** — grouped by parent proposal (expandable rows): every tool call
  across its act and reflect phases, expected vs. actual cost/time/upside,
  priority/schedule, and a "MVP done"/"needs refinement" review control.
  Setting "needs refinement" triggers the reactive research pass described
  above. Click a row for the full input/output JSON.
- **Lessons** / **Research notes** — the accumulated memory, browsable.

Approving or rejecting a proposal calls `POST /api/proposals/:id/decision`,
which resolves that proposal's pending promise in `review-gateway.ts` —
nothing is polled or written to a file.

## Semantic search

`research_note_search` and `lesson_search` embed with Qdrant Cloud Inference
and rank by vector similarity when Qdrant is configured, so a lesson written
for "VS Code extension for productivity" can still surface for a proposal in
"VS Code extensions" — wording doesn't have to match. Without it configured,
both fall back to the original `LIKE`-based search, so nothing breaks if you
skip it. `MemoryStore.syncToQdrant()` runs once at startup to backfill any
rows that were written before Qdrant was configured.

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

- **Tool access is enforced in three layers, and all three matter.**
  Earlier versions of this app relied on `canUseTool` alone in the
  research/reflect phases, plus this machine's default filesystem settings —
  that turned out to be insufficient in practice: a developer's own
  accumulated Claude Code allow-rules (`~/.claude/settings.json`,
  `.claude/settings.local.json`) can grant a tool before `canUseTool` is
  ever consulted, and some SDK-internal tool calls (e.g. paging back a tool
  result too large to inline) bypass `canUseTool` entirely regardless of
  settings. `settingSources: []` + `canUseTool` + a `PreToolUse` hook
  together are what actually hold research and reflect to their declared
  tool lists — confirmed live by observing `Bash`/`Read`/`Grep`/`Agent`
  attempts get denied. `actPhase`'s fence uses the same three layers, scoped
  to exactly `proposal.required_tools`.
- **That fence is a hard boundary, not the whole safety story.** It stops
  the agent from touching tools outside what you approved; it doesn't stop
  it from using an approved tool badly. `required_tools` on a proposal is
  free text (nothing server-side restricts it to known tool names), so
  actually check what's listed before approving — don't approve a proposal
  requesting a tool you don't recognize. Keep `expectedCost` realistic and
  don't approve proposals whose downside you wouldn't accept.
- **The web console has no authentication.** `src/server.ts` binds on all
  interfaces with nothing gating `/api/proposals/:id/decision` — anyone who
  can reach the port can approve spending. Fine on localhost; if you expose
  it beyond that (a tunnel, a VPS), put auth in front of it first.
- **No proposal, no action, ever.** Still true, still the point.

## Roadmap

See `TODO.md` for known follow-ups (moving large blobs off SQLite, switching
to npm workspaces).
