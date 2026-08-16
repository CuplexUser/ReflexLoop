# agent-runner

An autonomous agent with persistent memory, run outside any chat UI, with a web
console (React + Ant Design) to watch it work, approve or reject what it wants
to do, and set priority/scheduling on approved work. No sub-agents: nothing in
the tool registry can spawn one.

**Bring your own model.** It calls model APIs directly over HTTP — no Claude
Code, no Agent SDK, no vendor SDK. Set `AGENT_PROVIDER` to `openrouter`,
`openai`, `anthropic`, `xai` (Grok) or `moonshot` (Kimi), set that provider's
key, and name a model in `AGENT_MODEL`. Different phases can use different
models: cheap and wide for research, your best model for writing the code.

## How it works

Each cycle: **research + plan → your approval → act → record outcome →
reflect into a lesson**, then repeat. Research can span several domains at
once and surface more than one proposal per cycle; several proposals can sit
pending review at the same time.

**Every proposal has to say how it will make money.** Alongside the
cost/time/upside estimate, research has to fill in a revenue model, who
specifically pays, at what price, through what mechanism the *first* payment is
actually collected, how many days that takes, the one assumption that would kill
it, and what you'd measure to know it's working — plus an ordered step list from
approval to that first dollar, with the human-only steps marked as such. The
console shows all of it on the review card and in the proposal dialog, so the
decision isn't made on a headline number and a paragraph of prose.

Steps and the tool fence are checked against each other: a step the agent is
meant to do, naming a tool the proposal isn't asking for, is refused at creation
time. The act phase is fenced to exactly the approved tool list, so such a step
could never have run — and the approved steps are now passed into the act phase
verbatim, so execution follows the plan you said yes to rather than re-deriving
one.

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
  memory tools the agent can call: `research_note_add`, `research_note_search`,
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
  oxlint. Tables (Proposals, Actions, Lessons, Research notes) are
  resizable, sortable, filterable, and searchable. The Actions page groups
  every tool call by its parent proposal (expandable rows), shows expected
  vs. actual cost/time/upside, and lets you mark a shipped deliverable "MVP
  done" or "needs refinement" — a human verdict independent of the model's
  self-reported outcome, and the trigger for the reactive research pass
  above. Talks to `src/server.ts` over REST + WebSocket.
- `src/memory-server.test.ts` — Vitest unit tests for `MemoryStore` against an
  in-memory SQLite DB, with `qdrant.ts` mocked out. The real test suite.
- `src/smoke-test.ts` — quick end-to-end sanity check against a throwaway DB
  file, no API key needed. Run this first.

## Setup

```bash
npm install
npm run smoke-test   # sanity-checks the DB and tool wiring, no API calls
npm test             # unit tests (Vitest)
npm run typecheck
```

Copy `.env.example` to `.env` and fill in what you have:

- `AGENT_PROVIDER` + `AGENT_MODEL` + that provider's key — needed for
  `npm start` to run the agent at all. `AGENT_PROVIDER` defaults to
  `openrouter` (one key reaches Claude, GPT, Grok and Kimi, and it reports
  real per-call cost, so the Economics page stays accurate without a pricing
  table). `AGENT_MODEL` is **required and has no default** — model ids change
  too often for a baked-in one to be anything but a future 404; the startup
  error names your provider's model list. Optional per-phase overrides:
  `AGENT_RESEARCH_MODEL`, `AGENT_ACT_MODEL`, `AGENT_REFLECT_MODEL` (and
  `_PROVIDER` variants).
- `TAVILY_API_KEY` or `BRAVE_API_KEY` — optional but recommended. `WebSearch`
  was a Claude Code built-in and is now backed by whichever of these you set
  (both have free tiers). With neither, `AGENT_SEARCH_PROVIDER` falls back to
  `native` — the model provider's own server-side search, which varies in
  quality by provider. `WebFetch` needs no key.
- `AGENT_DOMAINS` — comma-separated lanes research considers each cycle
  (default covers small-business/consumer web tools, a general-audience
  Chrome extension, and a free web calculator/tool — not developer-only).
  See the tradeoff note below before adding many.
- `GITHUB_TOKEN` / `VERCEL_TOKEN` / `NETLIFY_AUTH_TOKEN` — optional; omit any
  of them and that integration's tools simply aren't usable.
- `STRIPE_API_KEY` / `RESEND_API_KEY` / `PLAUSIBLE_API_KEY` /
  `CLOUDFLARE_API_TOKEN` — optional connector keys (see `src/connectors/`).
  Unlike the three above, these are read per call rather than at startup, so
  adding one takes effect on the next cycle without a restart. Use a Stripe
  **test-mode** key (`sk_test_…`) until you're sure. `AGENT_CONNECTORS_DIR`
  points at a directory of extra connector manifests, if you'd rather keep
  them outside the repo.
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
- **Proposals** — full history with status, priority, revenue model, and
  schedule; click a row to open a dialog with the full description, the
  monetization block (who pays, price, path to the first dollar, key
  assumption, validation signal), the ordered step list with the human-only
  steps flagged, stats, tool calls, and Approve/Reject (with priority/schedule
  fields) for pending ones.
- **Actions** — grouped by parent proposal (expandable rows): every tool call
  across its act and reflect phases, expected vs. actual cost/time/upside,
  priority/schedule, and a "MVP done"/"needs refinement" review control.
  Setting "needs refinement" triggers the reactive research pass described
  above. Click a row for the full input/output JSON.
- **Deliverables** — one card per approved proposal that produced something
  reachable, with every artifact a real link: repo, live deployment, PR, and
  now Stripe payment links.
- **Lessons** / **Research notes** — the accumulated memory, browsable.
- **Agent control** — pause, run-now, abort, a one-shot research directive,
  and a connector list showing which are configured and which are still
  missing a key.
- **Settings** — the knobs that used to need a `.env` edit and a restart:
  the pending-proposal cap, the search mode, and the provider and model each
  phase runs on (with per-phase overrides). Changes apply from the next
  phase; a cycle already in flight finishes on the model it started with.

  Every field says whether its value is coming from the database, `.env`, or
  a built-in default — once a saved value beats `.env`, "I edited `.env` and
  nothing happened" is otherwise a confusing few minutes. Saves are
  all-or-nothing and verified before they commit: switching to a provider
  whose key isn't in `.env`, or a search mode whose key is missing, is
  refused at the click with the same message startup used to give, rather
  than failing an hour later on the next cycle.

  **API keys and secrets deliberately stayed in `.env`** — provider keys,
  `GITHUB_TOKEN`, the connector keys. A leaked `agent.db` (or one of the
  `.bak` files next to it) costs you the agent's memory; it shouldn't also
  cost you a live Stripe key. The database path, port, bind host and
  `AGENT_API_TOKEN` stay there too, for the plainer reason that you need the
  database before you can read settings out of it.

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

- **Tool access is enforced by this process, not by a permission setting.**
  Earlier versions of this app ran on the Claude Agent SDK and needed three
  overlapping mechanisms to hold a phase to its tool list — `settingSources: []`
  (so a developer's own accumulated Claude Code allow-rules in
  `~/.claude/settings.json` couldn't leak permissions into the agent),
  `canUseTool`, and a `PreToolUse` hook — because each had a gap the next one
  patched, and `Bash`/`Read` calls were observed slipping through the first two.
  Off the SDK, that whole class of problem is gone: `agent-loop.ts` dispatches
  every tool call itself, so a tool outside the phase's grant is never described
  to the model and there is no other path from this process to a tool handler.
  `actPhase`'s grant is exactly `proposal.required_tools` plus memory and
  read-only tools (the read-only GitHub/Vercel/Netlify calls, `WebSearch` and
  `WebFetch`) — those are always granted because none of them can change
  anything outside the process, so they widen what the act phase can *learn*,
  never what it can *do*.
- **You can still narrow the fence after approving.** Up until an approved
  proposal's act phase actually starts, "Edit fence" in the proposal dialog
  reworks its `required_tools` — so a queued or scheduled proposal you notice
  is slightly wrong doesn't have to be cancelled and re-proposed. The window
  closes the moment it acts.
- **That fence is a hard boundary, not the whole safety story.** It stops
  the agent from touching tools outside what you approved; it doesn't stop
  it from using an approved tool badly. The `required_tools` the *model*
  writes on a proposal is free text — a name that isn't a real tool simply
  never fires — so actually read what's listed before approving, and don't
  approve a proposal requesting a tool you don't recognize. (Tool names you
  add yourself at approval time *are* validated against the catalog.) Keep
  `expectedCost` realistic and don't approve proposals whose downside you
  wouldn't accept.
- **Connector write tools spend real money or reach real people.** A Stripe
  key creates live products and charges; a Resend key sends mail that can't be
  recalled; a Cloudflare token edits DNS for a real domain. They are behind the
  same approval fence as everything else, but the fence only limits *which*
  tools run, not how well. Start with scoped, minimum-permission tokens and a
  Stripe test-mode key, and read a proposal's step list before approving it.
- **Set `AGENT_API_TOKEN` before exposing the console.** With it unset the
  API is open and nothing gates `/api/proposals/:id/decision` — anyone who
  can reach the port can approve spending. That's why `AGENT_BIND_HOST`
  defaults to loopback and startup warns. Set the token before changing the
  bind host; it's one shared secret for the whole console, not per-user auth.
- **No proposal, no action, ever.** Still true, still the point.

## Roadmap

See `TODO.md` for known follow-ups (moving large blobs off SQLite, switching
to npm workspaces).
