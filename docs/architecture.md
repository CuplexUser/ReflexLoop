# Architecture

How the loop works, and what each module in `src/` is for.

## The cycle

Each cycle: **research + plan → your approval → act → record outcome →
reflect into a lesson**, then repeat. Research can span several domains at
once and surface more than one proposal per cycle; several proposals can sit
pending review at the same time.

**No proposal, no action, ever.** Approval happens in the web UI rather than a
stdin prompt, but the invariant is the one this design has always been built
around: nothing with real-world effect runs without a proposal a human
explicitly approved. Don't wire anything to auto-approve "to save time" — that
deletes the one safeguard the rest of the design assumes is there.

## Every proposal has to say how it will make money

Alongside the cost/time/upside estimate, research has to fill in a revenue
model, who specifically pays, at what price, through what mechanism the *first*
payment is actually collected, how many days that takes, the one assumption
that would kill it, and what you'd measure to know it's working — plus an
ordered step list from approval to that first dollar, with the human-only steps
marked as such. The console shows all of it on the review card and in the
proposal dialog, so the decision isn't made on a headline number and a
paragraph of prose.

Steps and the tool fence are checked against each other: a step the agent is
meant to do, naming a tool the proposal isn't asking for, is refused at creation
time. The act phase is fenced to exactly the approved tool list, so such a step
could never have run — and the approved steps are passed into the act phase
verbatim, so execution follows the plan you said yes to rather than re-deriving
one.

## Priority, scheduling and the act queue

At approval time you also set **priority** (low/normal/high/urgent) and,
optionally, a **schedule** — run now, run at a future date/time, or repeat on
a cadence until cancelled. Only one proposal's act+reflect phase ever runs at
a time, so real-world side-effecting tool calls never overlap — but *which*
approved proposal runs next is priority-then-due-time ordered, not just
arrival order. A scheduler tick (`AGENT_SCHEDULER_TICK_MS`, default 15s)
wakes up anything due; approving something for right now still runs
immediately.

## Reactive refinement

Marking an approved proposal's shipped deliverable **"needs refinement"**
(Actions page) kicks off a focused, out-of-cycle research+plan pass aimed at
exactly that proposal instead of waiting for the next scheduled cycle — it
can still only ever produce a new proposal for you to review, never an
action, and repeat toggling is cooldown-limited so it can't spam the API.

## Browser notifications

No email, no push service — they fire only while the tab is open, when a
proposal is newly pending review and when a scheduled/recurring run is about to
start. Opt in via the bell icon in the console; browsers require a user gesture
to grant the permission, so it's never requested automatically.

## Module map

- `src/memory-server.ts` — SQLite-backed memory (`data/agent.db`) plus the
  memory tools the agent can call: `research_note_add`, `research_note_search`,
  `lesson_search`, `lesson_add`, `lesson_reinforce`, `proposal_create`,
  `proposal_status`, `outcome_record`, `action_history_search`. Approving
  proposals, setting priority/schedule, logging actions, and marking a run
  successful are deliberately *not* tools the model has — those stay with
  the orchestrator and with you. Research notes and lessons are embedded (see
  [Semantic search](semantic-search.md)) and ranked by similarity instead of
  exact/`LIKE` text matching, when Qdrant is configured.
  `action_history_search` lets research/plan see what's already been
  built/deployed/committed on approved proposals so it doesn't propose
  duplicate work.
- `src/orchestrator.ts` — the main loop, its four phases, and a priority
  queue + scheduler tick that decides which approved proposal's act+reflect
  runs next. Every tool call is logged, and every phase's model API cost is
  recorded so spend counts against profit — computed from token usage, or
  taken from the provider when it reports a real per-call charge.
- `src/settings.ts` — operator settings stored in the database and editable
  from the console's Settings page, so they no longer need a `.env` edit and
  a restart. `.env` still seeds them; a value set in the console then wins.
  Adding a setting is one entry in the registry — the API and the page are
  driven off it. Secrets and bootstrap values are excluded on purpose.
- `src/agent-loop.ts` — the agentic loop itself: ask the model, run the tools
  it asked for, feed the results back, repeat. This is also where each phase's
  tool fence is enforced — a tool outside the phase's grant is never described
  to the model, and is refused if the model names it anyway.
- `src/llm/` — the only provider-specific code in the project. One adapter
  covers every provider that speaks OpenAI's `/chat/completions` (OpenRouter,
  OpenAI, xAI, Moonshot); a second covers Anthropic's Messages API natively.
  Also holds the pricing table that turns tokens into the dollar figures on
  the Economics page.
- `src/tools/` — the tool registry (name + description + zod schema + handler,
  converted to JSON Schema for the wire) and `web.ts`, which implements
  `WebSearch` and `WebFetch`.
- `src/search/` — pluggable search behind `WebSearch`: Tavily, Brave, or the
  model provider's own server-side search, chosen with
  `AGENT_SEARCH_PROVIDER`. Whichever you pick, `WebSearch` stays one tool name
  in a proposal and one badge in the console.
- `src/reactive-triggers.ts` — a small fire-and-forget bridge: marking a
  proposal "needs refinement" in the UI wakes a targeted research+plan pass
  for that one proposal, independent of the hourly cycle.
- `src/integrations/{github,vercel,netlify}.ts` + `src/integrations-server.ts`
  — thin API wrappers and the tools built on them. Read-only tools
  (`github_read_repo`, `vercel_list_projects`, etc.) are free for research to
  call, same as `WebSearch`. Write tools (`github_create_repo`,
  `github_commit_files`, `github_merge_pr`, `vercel_deploy`,
  `netlify_deploy`, etc.) only work when an approved proposal's
  `required_tools` names them — enforced by the fence in `agent-loop.ts`,
  not by convention. `github_commit_files` writes any number of files
  as a single commit (Git Data API: blob → tree → commit → ref update) and
  is preferred over the older one-file-per-call `github_commit_file`;
  `github_merge_pr` exists so a proposal that opens a PR can also land it
  instead of leaving the default branch empty.
- `src/connectors/` — **connectors declared as JSON, not code.** A manifest in
  `src/connectors/defs/` describes a REST API (base URL, auth, and a list of
  operations with typed params); the loader turns each operation into a normal
  tool, with the same read/write risk split and the same fence. Shipped:
  **Stripe** (products, prices, hosted payment links, plus balance and charge
  reads), **Resend** (email), **Plausible** (traffic stats), **Cloudflare**
  (zones, Pages, DNS). Add your own by dropping a file in that directory, or
  point `AGENT_CONNECTORS_DIR` somewhere outside the repo.

  Stripe is the one that changes what the loop can do: a payment link is a
  real path from an approved proposal to a first dollar, and the balance/charge
  reads let the act phase record **measured** revenue instead of an estimate.

  A connector with no key set is still listed — its tools just report
  `<KEY> is not set` if called, and research isn't told about them. Filling a
  key in takes effect on the next cycle, with no restart. File-upload deploys
  (Vercel, Netlify) and OAuth-refresh APIs (Reddit, X) can't be expressed this
  way and stay hand-written.
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
  oxlint. See [The web console](web-console.md).
- `src/mcp-server.ts` — an MCP server exposing the agent's record to Claude
  Desktop, read-only: goals, research notes, lessons, proposals and
  deliverables. Wiring only; the tools live in `src/mcp/`, one module per
  subject over a shared store handle and a pure rendering layer. See
  [Reading the record from Claude Desktop](mcp-server.md). `src/mcp-env.ts` is
  its `.env` loader and stdout guard, split out because the import order is
  load-bearing.
- `src/memory-server.test.ts` — Vitest unit tests for `MemoryStore` against an
  in-memory SQLite DB, with `qdrant.ts` mocked out. The real test suite.
- `src/smoke-test.ts` — quick end-to-end sanity check against a throwaway DB
  file, no API key needed. Run this first.
