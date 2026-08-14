# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An autonomous agent that researches money-making opportunities, proposes concrete plans, and — only
after a human approves in a web console — acts on them, records the real outcome, and distills a lesson
for next time. No sub-agents: the tool registry contains no tool that spawns one, and `agent-loop.ts`
only ever dispatches tools from that registry.

**It is not tied to any one model vendor.** It talks to model APIs directly over HTTP — there is no
Claude Code, no Agent SDK, no vendor SDK of any kind. `AGENT_PROVIDER` selects OpenRouter, OpenAI,
Anthropic, xAI (Grok) or Moonshot (Kimi); `AGENT_MODEL` names the model. Phases can use different
models (`AGENT_ACT_MODEL` etc.). Nothing outside `src/llm/` should contain provider-specific code.

**The core invariant: no proposal, no action, ever.** Every real-world side-effecting tool call
(creating a repo, deploying, etc.) only runs inside `actPhase`, fenced to exactly the tools the
human-approved proposal named. Don't add anything that auto-approves proposals or lets `actPhase` reach
beyond `proposal.required_tools` — that removes the one safeguard the rest of the design assumes is
there. The fence is now enforced structurally rather than by configuration: `agent-loop.ts` owns tool
dispatch, so a tool outside the phase's grant is never described to the model and is refused if the
model names it anyway. (Under the old Agent SDK this needed three overlapping mechanisms —
`allowedTools`, `canUseTool` and a `PreToolUse` hook — because each had a documented gap the next one
patched. Those are gone; don't reintroduce that shape.)

A human *may* edit `required_tools` — that's the operator reshaping the fence deliberately, not the agent
escaping it. Two windows, and they're different endpoints on purpose:

- **At approval time** (`POST /api/proposals/:id/decision`, see approve-with-edits below), the edit is
  applied *before* the status flips, so a proposal is never approved while still carrying its pre-edit
  fence.
- **After approval, until the act phase starts** (`POST /api/proposals/:id/scope`). A queued or scheduled
  proposal you can see is slightly wrong should be narrowable without cancelling it outright. The window
  closes at `store.hasActed(id)` (or while it's the running proposal): after that, narrowing can't
  un-commit anything and widening would authorise work retroactively.

Either way the original is preserved on the row (`original_required_tools` / `original_description`).
A name that isn't in the tool catalog is **allowed but flagged**, not rejected — `agent-loop.ts` matches
tools by exact name, so an unrecognized entry grants nothing, and rejecting it blocked legitimate cases
(a console whose catalog predates a newly added tool). The console badges it; the server logs it.

Every other lever the console offers (pause, abort, directives, domains) can only reduce activity or
redirect research; none of them grants the agent anything.

## Commands

```bash
npm install
npm run smoke-test    # sanity-checks the DB + tool wiring directly, no API key needed — run this first
npm test              # vitest run — unit tests over src/**/*.test.ts, no API key needed
npm run typecheck     # tsc --noEmit over src/
npm start             # tsx src/orchestrator.ts — runs the agent loop + web console together (one process, one SQLite connection)
```

Vitest covers the parts that can be tested without an API key: `src/memory-server.test.ts`
(`MemoryStore` against an in-memory SQLite DB, with `qdrant.ts` mocked so semantic-search tests exercise
the deterministic LIKE-fallback path regardless of ambient `QDRANT_*` env vars), `src/tools/registry.test.ts`
(schema conversion and in-band error handling), `src/tools/web.test.ts` (HTML-to-text, and that WebFetch
refuses loopback/private addresses), and `src/llm/pricing.test.ts` (the cost table, the OpenRouter
reported-cost path, and the deliberate $0-for-unknown-model behaviour). The adapters and the loop itself
aren't unit-tested — they're thin over HTTP, and a mock of a provider's wire format mostly tests the mock.
`smoke-test.ts` runs end-to-end against a throwaway `./data/smoke-test.db`, and also builds the real tool
registry and serializes every schema — which is the cheap way to catch a zod shape that can't be converted,
since otherwise it surfaces as a provider 400 on the first live cycle.

Frontend (`web/`) is an npm workspace of the root project — `npm install` at the root sets up both.
Run its scripts from the root (below) or with `npm run <script> -w web` from anywhere:

```bash
npm run web:dev       # Vite dev server with hot reload; proxies /api and /ws to the backend on AGENT_SERVER_PORT
npm run web:build     # production build to web/dist — this is what src/server.ts serves during `npm start`
npm run web:lint      # oxlint over web/
```

For frontend work, run `npm start` (backend) and `npm run web:dev` (frontend) side by side rather than
rebuilding `web/dist` on every change.

`.env` (copy from `.env.example`). The three that must be right for `npm start` to work at all:
`AGENT_PROVIDER` (default `openrouter`), `AGENT_MODEL` (**required, no default** — see below), and that
provider's key (`OPENROUTER_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `XAI_API_KEY` /
`MOONSHOT_API_KEY`). Then `AGENT_DOMAINS`, `AGENT_DB_PATH`, `AGENT_CYCLE_INTERVAL_MS`,
`AGENT_MAX_PENDING_PROPOSALS`, `AGENT_SERVER_PORT`, `AGENT_API_TOKEN`, `AGENT_BIND_HOST`; optional
search keys `TAVILY_API_KEY` / `BRAVE_API_KEY` (see below); optional integration keys `GITHUB_TOKEN` /
`VERCEL_TOKEN` / `NETLIFY_AUTH_TOKEN` / `QDRANT_URL` + `QDRANT_API_KEY` + `QDRANT_EMBEDDING_MODEL` +
`QDRANT_EMBEDDING_DIM` (all four required together for semantic search) — each integration or feature
is simply unavailable, not a startup error, when its keys are missing.

**`AGENT_MODEL` has no default on purpose.** Providers rename and retire models constantly; a model id
baked into the code fails at the first API call with an opaque 404 instead of at startup with a message
naming the provider and its model list. Don't add one.

## Architecture

### The four-phase loop (`src/orchestrator.ts`)

Each cycle: **research + plan → human review → act → outcome + reflect**.

- **research + plan** (`researchAndPlanPhase`) — gets its whole tool grant up front with no human in the
  loop, since every tool available to it is read-only or writes only to the agent's own memory DB. Can span multiple
  `AGENT_DOMAINS` per cycle and create 0-3 proposals; not forced to cover domains evenly. Calls
  `lesson_search`/`research_note_search` first so it doesn't re-research what's already known, and
  `action_history_search` to see what's already been built/deployed so it doesn't propose duplicate work.
  Proposing **zero** is a legitimate result — the prompt tells it not to force a weak proposal, and a
  domain whose ideas keep getting rejected will eventually stop producing any. That state used to be
  invisible (stdout only), which is indistinguishable from a broken loop, so a cycle that creates
  nothing now emits a `no_proposal` event carrying the model's own stated reason. It also carries the
  phase's tool-call count, because **zero tool calls is a different thing entirely** — the phase never
  researched at all (an empty or failed model response) and the console says so rather than reporting
  it as a considered decision.
- **human review** (`humanReviewPhase`) — emits a `proposal_pending` event and blocks on
  `waitForDecision()` (`review-gateway.ts`), resolved when a person clicks Approve/Reject in the web UI
  (`POST /api/proposals/:id/decision`). Multiple proposals can be under review concurrently, each on its
  own promise. The decision can carry **scope edits** (`editedDescription`, `editedRequiredTools`);
  those are applied via `store.applyProposalEdits` *before* `decideProposal` flips the status, so a
  proposal is never approved while still carrying its pre-edit fence. `original_required_tools` /
  `original_description` preserve what the model asked for. A **rejection** now runs
  `reflectOnRejectionPhase` (memory-only tools, same grant as reflect) with the human's stated reason,
  so being told no produces a lesson instead of teaching the agent nothing.
- **act** (`actPhase`) — side-effecting tool access is hard-limited to exactly `proposal.required_tools`.
  On top of that it always gets the same no-side-effect set research gets freely: memory tools, the
  read-only integration tools (`github_read_repo`/`github_read_file`/etc.) so the model can read back what
  it just committed/deployed and self-check it, and `WebSearch`/`WebFetch` so it can check a library's
  current API mid-build rather than committing what it half-remembers with no build step to catch it.
  None of those can change anything outside the process, so they widen what act can *learn*, never what
  it can *do*. The prompt requires it to fully implement the described scope (no stub/placeholder files),
  proofread for syntax/import errors since there's no build step available to actually run the code, and
  re-read the real committed/deployed state before calling `outcome_record`. The whole grant is passed to
  `runAgent` as `allowedTools`, which is now the entire fence — see the note at the top of this file.
- **reflect** (`reflectPhase`) — calls `lesson_search` first; reinforces an existing lesson via
  `lesson_reinforce` if this outcome confirmed/contradicted it, otherwise adds one new generalized lesson.

**Concurrency**: research runs one cycle at a time on `AGENT_CYCLE_INTERVAL_MS`. Every new proposal
immediately starts waiting for review in parallel with any others already pending. Once approved, a
proposal's act+reflect is pushed onto a single serialized chain (`scheduleActAndReflect`/`actChainTail`)
so side-effecting tool calls from different proposals never run concurrently, even if several are
approved back to back.

Every tool call in every phase is logged by `runPhase`'s `onToolCall` callback, and every phase's model
API cost is recorded — spend counts against profit. Cost is no longer handed over the way the SDK's
`total_cost_usd` was: it's computed from token usage against `llm/pricing.ts`, or taken from the provider
when it reports a real per-call charge (OpenRouter does). It accumulates via `onTurnCost` per model call
rather than being read off the result, and the ledger write lives in a `finally`, so an aborted or crashed
phase still lands in `runs` with the spend it actually incurred — a phase missing from the ledger, or
present with a zero, would understate what the loop cost. `runs` also records the `provider`/`model` that
produced each row, since phases can be pointed at different models.

**Runtime control** (`agent-control.ts`) holds state the operator drives from the console: paused,
domains, cycle interval, a one-shot research directive, and a live view of what's executing. `mainLoop`
re-reads it each pass instead of closing over the env constants, so changes take effect without a
restart. "Run a cycle now" resolves `sleepUntilNextCycle` early; aborting an act phase fires the
`AbortController` passed to that run's `query()` (skipping reflect, since there's no outcome to reflect
on). A directive is consumed — injected into one research prompt, then cleared.

### Backend modules (`src/`)

- `llm/` — everything provider-specific, and the only place it should live. `types.ts` is the neutral
  vocabulary (messages, tool calls, usage) every phase speaks. Two adapters implement it:
  `openai-compatible.ts` covers OpenRouter, OpenAI, xAI and Moonshot (they share the `/chat/completions`
  wire format and differ only in how you cap output tokens, how you turn on server-side search, and
  whether the provider bills the call back to you), and `anthropic.ts` covers Claude's Messages API
  natively — worth its own file rather than going through Anthropic's OpenAI-compat shim, which lags on
  tool use. `providers.ts` is the registry of base URLs / key env vars / model-list links; `http.ts` is
  one retrying JSON POST (429 and 5xx only — a 400 from a bad model id is returned immediately);
  `pricing.ts` turns tokens into dollars; `index.ts` resolves one client per phase from the env.
  Adapters must normalize `Usage.inputTokens` to *total* prompt tokens including cached ones — Anthropic
  reports the uncached remainder, so its adapter adds the cache fields back or pricing under-counts.
- `agent-loop.ts` — the replacement for the SDK's `query()`: ask the model, run the tools it asked for,
  feed results back, repeat to `maxTurns`. Provider-agnostic (it only touches an `LlmClient`), and the
  place the tool fence is enforced.
- `tools/registry.ts` — what replaced the MCP servers. A tool is a name, description, zod schema and
  handler; the registry converts schemas to JSON Schema (`z.toJSONSchema`, `io: "input"`) and dispatches.
  Every failure — unknown tool, invalid args, throwing handler — comes back as `isError` tool text rather
  than an exception, so one bad call costs a turn instead of the phase. **Tool names keep their
  `mcp__memory__` / `mcp__integrations__` prefixes** even though no MCP server exists any more: those
  strings are persisted in `actions.tool_name` and in approved proposals' `required_tools`, and the
  console strips them for display. Treat them as opaque namespaces; renaming would invalidate the fence
  on already-approved proposals for no behavioural gain.
- `tools/web.ts` — `WebSearch` and `WebFetch`, which were Claude Code built-ins and had to be rebuilt.
  `WebFetch` is always registered (fetch + a regex HTML-to-text pass, with private/loopback addresses
  refused). `WebSearch` is registered only in `tavily`/`brave` search mode.
- `search/` — the seam behind `WebSearch`: `tavily.ts` and `brave.ts` implement one small interface, and
  `index.ts` resolves the mode from `AGENT_SEARCH_PROVIDER` (`auto` | `tavily` | `brave` | `native` |
  `none`). In `native` mode no local tool is registered at all and `agent-loop.ts` instead sets
  `ChatRequest.nativeSearch`, which each adapter translates to its provider's own knob (OpenRouter
  `plugins`, xAI `search_parameters`, OpenAI `web_search_options`, Moonshot's `$web_search` builtin,
  Anthropic's `web_search_*` server tool). **The point of the seam: "WebSearch" means the same thing to
  the operator in all modes** — one grantable tool name, one badge in the console, one entry in
  `required_tools`. Keep it that way.
- `memory-server.ts` — SQLite-backed memory (`data/agent.db`) plus the tools the model can call:
  `research_note_add`, `research_note_search`, `lesson_search`, `lesson_add`, `lesson_reinforce`,
  `proposal_create`, `proposal_status`, `outcome_record`, `action_history_search`. Approving proposals,
  logging actions, marking a run successful, and **curating memory** (editing, muting, or deleting a
  lesson; deleting or merging research notes) are deliberately *not* model-callable tools — those stay
  with the orchestrator and the human. `buildMemoryTools(store)` returns them; `MemoryStore` itself is a
  plain class the orchestrator and `server.ts` call directly for everything the model must not control.
  Muting matters most: `searchLessons` is the single chokepoint
  every `lesson_search` goes through, so muting there removes a wrong lesson from the agent's reasoning
  everywhere at once while keeping the record of what was believed and when. `searchLessonsByText` is a
  deliberate sibling of `searchLessons` for the console's operator — the agent looks lessons up *by
  domain* (its LIKE fallback matches domain equality), which finds nothing for a human typing a phrase
  from a lesson body. Same semantic path, same muted filter, different fallback. Notes/lessons are ranked by Qdrant vector similarity when Qdrant
  is configured, falling back to `LIKE` text matching otherwise; `syncToQdrant()` (called once at
  startup in `orchestrator.ts`) backfills any rows that predate Qdrant being configured. Also owns the
  `events` table (persisted activity feed, capped at `EVENTS_KEEP`) and `action_history_search`'s
  backing query, which joins `actions` to `proposals` to answer "what's already been done" for
  research/plan — restricted to `phase = 'act'` on `status = 'approved'` proposals to stay low-noise,
  unlike the Actions page below which shows every phase.
- `qdrant.ts` — REST client for Qdrant Cloud, both vector storage/search and (via Cloud Inference)
  server-side embedding generation in the same request — no separate embeddings provider needed. Fails
  soft: without all of `QDRANT_URL` / `QDRANT_API_KEY` / `QDRANT_EMBEDDING_MODEL` / `QDRANT_EMBEDDING_DIM`
  set, or on any request error, calls resolve to `null`/`false` so callers fall back to `LIKE`-based
  search instead of throwing. Model + dimension aren't hardcoded (Qdrant Cloud's free model lineup and
  each model's vector size are only listed per-cluster, in the Cloud Console's Inference tab), so both
  are required env config.
- `integrations/{github,vercel,netlify}.ts` + `integrations-server.ts` — thin API wrappers and the tools
  that expose them (`buildIntegrationsTools()`). Read-only tools (`github_read_repo`, `vercel_list_projects`, etc.) are free for the research
  phase to call. Write tools (`github_create_repo`, `vercel_deploy`, `netlify_deploy`, etc.) only work in
  `actPhase`, and only when named in the approved proposal's `required_tools`. Each write tool that
  creates/deploys something returns a plain `url` field on success — `memory-server.ts`'s
  `extractResultUrl` pulls that out generically (by field name, not per-tool switching) to back the
  Actions page's browsable result links.
- `tool-catalog.ts` — the one place that knows which tools exist and which touch the real world
  (`toolRisk` → write/read/memory). Three consumers used to each carry their own copy of that answer:
  `orchestrator.ts` (listing act-phase write tools in the research prompt), `server.ts` (validating
  operator edits to `required_tools` against `ALL_GRANTABLE_TOOLS` — now to warn on an uncatalogued name,
  not to reject it), and the console (badging risk at
  decision time, via `GET /api/tools`). Read-only integration tools stay defined in
  `integrations-server.ts` next to their handlers and are re-exported here.
- `agent-control.ts` — runtime knobs (pause, run-now, abort, domains, interval, directive) plus the
  execution snapshot the console reads. Same in-process bus shape as `review-gateway.ts` and
  `reactive-triggers.ts`.
- `events.ts` / `review-gateway.ts` / `server.ts` — the live layer under the web UI. `events.ts` is an
  in-process bus the orchestrator emits to; `server.ts` persists each event via `store.logEvent()` *then*
  rebroadcasts it over WebSocket with the same `{id, occurredAt}` the DB assigned, and serves the REST API
  (proposal/action/event history), and in production also serves the built `web/dist` static files;
  `review-gateway.ts` resolves a proposal's pending approval promise when a decision comes in via the API.
- `smoke-test.ts` — exercises `MemoryStore` directly against a throwaway DB, no API key needed.

### Frontend (`web/`)

React + TypeScript + Ant Design, linted with oxlint, talking to `src/server.ts` over REST
(`web/src/api.ts`) and WebSocket (`web/src/useAgentSocket.ts`). Pages live in `web/src/pages/`: Dashboard
(pending proposals + stat tiles + recent activity), Live feed (full filterable activity stream),
Proposals (full history, bulk approve/reject, click a row for `ProposalDialog`), Actions (every tool call
on an *approved* proposal — action type, an input-derived description, and a browsable result URL when
the tool returned one; phase-filterable, click a row for full input/output JSON via `ActionDialog`),
Economics (spend over time, spend by phase, spend by provider/model, per-domain scoreboard with
forecast accuracy), Lessons, Research notes, Agent control.

**No vendor names in the UI.** The loop is provider-neutral and the provider is a config switch, so a
label like "Claude API spend" is wrong the moment someone points `AGENT_PROVIDER` elsewhere — and the
`runs` table outlives the switch, so a lifetime total legitimately spans several providers plus rows
written before `provider`/`model` were recorded at all (those are nullable, and are reported as their
own "unrecorded" bucket rather than credited to whatever is configured now). Spend is "model API
spend", and `GET /api/economics` returns `spendByModel` so the total decomposes into who was actually
paid. `unattributedSpend` is there for the same reason: the domain scoreboard can only see spend
charged to a proposal, and research/plan runs never are, so the page states the remainder instead of
leaving a gap between the column and the headline. Any figure the console derives (Net) prints its
inputs next to it — a number the operator can't reconstruct is one they can't trust.

**Theming.** Components import `palette` from `web/src/theme.ts` and get **CSS variables**
(`var(--rl-approved)`, etc.), so a theme switch repaints without re-rendering. Ant Design can't use
those — it derives hover/active shades with color math — so `HEX_PALETTES` holds real hex for
`ConfigProvider`. The `--rl-*` definitions in `index.css` and `HEX_PALETTES` are two representations of
one palette: **change both together**. `main.tsx` owns the mode and sets `data-theme` on `<html>`, but
an inline script in `index.html` stamps the same attribute *before* first paint — an effect runs after
it, which flashed the dark default at light-theme users. That script duplicates `main.tsx`'s storage key
and OS-preference fallback; they have to agree.

Light mode is a real mode, not a fallback, so **nothing may hardcode a hex color** — a literal is a
dark-theme value that survives the switch and lands light-on-light (the sider) or a black slab on a
white page (the activity console). Anything AntD styles for you needs the mode passed in too: the nav
`Menu` takes `theme={themeMode}` because the sider it sits on is `bgSunken`. Where only an alpha varies
(the pulse-ring keyframe, the column-resize handle) `index.css` carries `--rl-*-rgb` channel triples
alongside the hex, since `rgba()` can't take a `var()` holding `#rrggbb`.

**Deep links.** Every detail dialog is driven by the URL — `/proposals/:id`, `/actions/:id`,
`/lessons/:id`, `/research/:id` — so rows are bookmarkable and Back closes the dialog. The nav highlight
keys off the first path segment, so `/proposals/12` still selects Proposals. New detail views should
follow this rather than holding the selected row in local state.

**Bundle splitting.** `App.tsx` loads every route except the landing Dashboard through `React.lazy`
(and the Cmd-K palette, and `SchedulePriorityFields` inside `DecisionControls`, since `DatePicker`
drags dayjs in for a control that renders on a click) — **add new pages the same way**, so app code
for a page you aren't on isn't in the first load. `vite.config.ts` then splits `node_modules` into a
few long-lived chunks: `react`, `router`, `antd` (~1 MB / 320 KB gzip, ~70% of the console's JS), and
`vendor` for the rest.

**Don't try to split the antd chunk by route.** rolldown's `entriesAware` grouping does exactly that,
and it partitions antd into chunks that import each other *circularly* — which antd cannot survive,
because `modal/locale` does `{...enUS.Modal}` at module top level and that runs before the chunk
holding `en_US` is evaluated. The result is `Uncaught TypeError: Cannot read properties of undefined
(reading 'Modal')` before React mounts, i.e. **a blank page in production only** — `npm run web:dev`
does no chunking, so it looks fine there. If you touch the chunking, verify a real build, not just
the dev server. Chunks and the whole `dist/` listing are what `npm run web:build` prints; it warns
about the antd chunk exceeding 500 KB, and that warning is expected.

**Table plumbing.** Pages call `useTableView(storageKey, columns)`, which wraps `useResizableColumns`
and adds column show/hide, density, and page size (all persisted per table), returning `tableProps` to
spread and a `view` object for `TableToolbar`. It assigns column keys from the *unfiltered* list so
hiding one column can't shift another's identity and steal its stored width. `useTableKeyboardNav` adds
j/k navigation scoped to the rows passed in, so the highlight can never land on a filtered-out row.

Table cells that need to show long free text (a proposal description, a lesson, etc.) use the column's
own `ellipsis: true` (plain CSS truncation + native title tooltip) and a click-to-open dialog for the
full text — not AntD's `Typography.Text ellipsis={{tooltip}}`, which double-measures against the
column's own truncation and visibly flickers on hover. Keep new long-text columns consistent with this.

Every table's columns go through `useResizableColumns(storageKey, columns)` (`web/src/hooks/`), which
adds drag-to-resize handles, persists widths to `localStorage` under `storageKey`, and returns a
`scroll` that **must** be spread onto the `<Table>`. That `scroll.x` isn't optional polish: an
`ellipsis` column puts rc-table into `table-layout: fixed`, where the table is pinned to its
container's width, so widening one column steals space from its neighbours until the undeclared
free-text column collapses to nothing. `scroll.x` lets the table grow past the container and scroll
instead (rc-table sizes it `width: x; min-width: 100%`, so it still fills when there's room). Don't
wrap tables in an `overflowX: auto` div — that never engages, because the table itself never
overflows.

`useAgentSocket.ts` tracks a `historyVersion` counter that bumps on state-changing WebSocket events
(`proposal_decided`, etc.); `App.tsx`/page components refetch their REST data (`/api/proposals`,
`/api/outcomes`, `/api/actions`, etc.) whenever it changes, so REST-fetched state stays in sync with what
the WebSocket reports without polling. The activity feed itself is seeded from `GET /api/events` on
mount and merged with live WebSocket events by server-assigned id (de-duped, ordered) so a page reload
doesn't lose history — replaying that same event log is also what reconstructs `pendingProposals` and
`runningPhase` on load, not just the visible feed.

The web console is gated by a **single shared token**: set `AGENT_API_TOKEN` and `server.ts` requires it
on `/api` (Bearer header) and on the WebSocket upgrade (query param — the browser WebSocket API can't set
headers), compared with `timingSafeEqual`. `TokenGate` prompts for it once and stores it. Leave the token
unset and the API is open, which is why `AGENT_BIND_HOST` defaults to `127.0.0.1` and startup logs a
warning. This is one secret for the whole console, not per-user auth — set a token before changing the
bind host, since nothing else stands between the network and the approve endpoint.
