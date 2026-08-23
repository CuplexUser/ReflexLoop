# TODO

## Tier 0 -- bugs & correctness

- [x] Fix table column resize collapsing neighbouring columns
- [x] Re-register pending review decisions on restart -- not a bug, already handled
- [x] Surface run cost in the UI (was dead code)

## Console overhaul

- [x] Tier 1 -- table & navigation usability
- [x] Tier 2 -- approval workflow
- [x] Tier 3 -- economics & observability
- [x] Tier 4 -- agent control & memory curation
- [x] Tier 5 -- hardening & polish

## Backlog

- [ ] Per-goal research fan-out (deferred -- see note below, documented rather than built)
- [ ] Move large blobs/JSON out of SQLite (deferred -- see note below, not worth doing yet)
- [ ] Code-split the frontend bundle (1.3MB / 415KB gzipped, one chunk -- Vite warns on every
      build). Not urgent for a localhost console, but it's the only build warning left.
- [x] Move settings from `.env` into the database, editable in the console -- **slice 1 done**
      (max pending proposals, search mode, provider/model incl. per-phase overrides). Remaining
      slices in the note below; secrets and bootstrap values stay in `.env` by decision.
- [x] Switch to npm workspaces
- [x] Switch to Qdrant Cloud
- [x] Declarative connectors + Stripe/Resend/Plausible/Cloudflare
- [x] Monetization block + step list on every proposal

## Fix table column resize collapsing neighbouring columns

Dragging a column wider makes the next column shrink to nothing. Every page renders
`<Table>` with no `scroll` prop, and the free-text column's `ellipsis: true` puts
rc-table into `table-layout: fixed`, where the `<table>` is pinned to `width: 100%`
of its container. The colgroup can never exceed the viewport, so the fixed-layout
algorithm takes the dragged column's extra width from its neighbours -- the column
with no declared width (Description / Lesson / Finding) collapses first, then the
rest shrink proportionally. The `<div style={{overflowX: 'auto'}}>` wrappers never
engage because the table never overflows them.

Fix in `web/src/hooks/useResizableColumns.ts` (one place, all six tables): sum the
column widths with a floor for the undeclared flex column and return
`scroll: { x: total }`. rc-table then sizes the table `width: total; min-width: 100%`
-- it still stretches to fill when there's room, and scrolls horizontally instead of
crushing columns once drags exceed the container. Drop the now-redundant wrapper divs.

Same pass, since widths are barely usable without them: persist widths to
`localStorage` per table, double-click the handle to reset a column, and rAF-batch
the drag so it stops re-rendering every row on every pointermove.

## Re-register pending review decisions on restart -- not a bug

Investigated on the suspicion that `review-gateway.ts`'s in-memory resolver `Map`
loses pending proposals across a restart, leaving them permanently undecidable
(`409 No pending decision`). It doesn't: `mainLoop` already re-enters
`humanReviewPhase` for every `status = 'pending'` proposal on startup
(`orchestrator.ts`, "Pick up any proposals left pending from a previous run"), and
`waitForDecision` registers its resolver synchronously, before the event loop can
serve the first HTTP request. Nothing to fix.

## Surface run cost in the UI

The `runs` table holds per-phase Claude API cost and duration, but nothing rendered it
-- `/api/runs` was served, typed in `web/src/api.ts` as `api.runs()`, and used nowhere.

Done: added `MemoryStore.listRunsForProposal()`, `GET /api/proposals/:id/runs`, and
`api.proposalRuns()`, and `ProposalDialog` now shows total Claude API spend for the
proposal (with its phase count) right next to the model's own cost estimate -- so the
estimate can be read against what the proposal actually cost to produce.

`/api/runs` (the whole-history list) now backs the Economics page's phase breakdown.

## Tier 1 -- table & navigation usability

- Deep-linkable rows: `/proposals/:id`, `/actions/:id`, `/lessons/:id`, `/research/:id`.
  Dialogs are driven by the URL, so rows are bookmarkable and Back closes them. The nav
  highlight keys off the first path segment so `/proposals/12` still selects Proposals.
- `useTableView` (`web/src/hooks/`) wraps `useResizableColumns` and adds column show/hide,
  density, and page size, all persisted per table. Column keys are assigned from the
  *unfiltered* list so hiding one can't shift another's identity and steal its stored width.
  `TableToolbar` is the shared chrome; `sticky` headers come from the same hook.
- Global search: `Cmd-K` opens `CommandPalette`, which queries `GET /api/search` --
  server-side, so it reaches the whole history rather than the loaded page.
- Semantic search reaches the UI through that endpoint. Note `searchLessonsByText` exists
  separately from `searchLessons`: the agent looks lessons up *by domain* (its LIKE fallback
  matches domain equality), which is useless for a human typing a phrase from a lesson body.
  Same semantic path and same muted filter, different fallback.
- Keyboard nav via `useTableKeyboardNav`: `j`/`k` or arrows move, `Enter` opens, `Esc`
  clears. Scoped to the rows passed in, so the highlight can't land on a filtered-out row.
- CSV/JSON export per table (`web/src/export.ts`), exporting the rows currently on screen.

## Tier 2 -- approval workflow

- **Approve with edits**: `DecisionControls` (shared by the dashboard card and the proposal
  dialog) lets the operator rewrite the description and narrow or widen `required_tools`
  before approving. Edits ride along with the decision and are applied by
  `applyProposalEdits` *before* the status flips, so there's never a window where a proposal
  is approved while still carrying its pre-edit fence. The original is preserved in
  `original_required_tools` / `original_description` and shown in the dialog afterwards.
  The server validates edited tools against `ALL_GRANTABLE_TOOLS` -- an operator can reshape
  the fence, but only to tools that actually exist, never an arbitrary string.
- Risk surfacing: `src/tool-catalog.ts` is now the one place that knows which tools exist
  and which touch the world; `GET /api/tools` serves it, and `ToolFence` badges each
  requested tool write/read/memory at decision time.
- Bulk approve/reject on the Proposals page (`POST /api/proposals/bulk-decision`), plus a
  pending-age indicator on the review card and in the status column. Scope edits are
  deliberately not accepted in bulk -- they're per-proposal by nature.
- Rejections now teach: `reflectOnRejectionPhase` runs a memory-only reflect pass with the
  human's stated reason, so the next cycle has a lesson about why that kind of proposal
  isn't worth approving instead of being free to re-propose it.

## Tier 3 -- economics & observability

- Economics page: daily spend, spend by phase, and a per-domain scoreboard, off a new
  `GET /api/economics` (`spendByPhase` / `spendOverTime` / `domainScoreboard`).
- Real P&L: the dashboard's headline tile is now `revenue - reported cost - API spend`
  as one number, rather than showing the parts and leaving the subtraction to the reader.
- Forecast accuracy compares `expected_upside` against `actual_revenue` per domain --
  both were already stored and never compared.
- Aborted and failed phases are still logged to `runs` (the logging moved into a `finally`),
  because spend already incurred is real whether or not the phase finished.

## Tier 4 -- agent control & memory curation

- `src/agent-control.ts` holds runtime state the Agent control page drives: pause/resume,
  "run a cycle now" (`sleepUntilNextCycle` resolves early), abort an in-flight act phase
  (via the SDK's `abortController`), and edit domains/interval without a restart. The loop
  re-reads control state each pass rather than closing over the env constants.
- Directives: free text injected into the next research prompt and then cleared, so a steer
  nudges one cycle instead of quietly reshaping every future one.
- Nothing in the control surface can widen what the agent may do -- it only reduces activity
  or redirects research, and research output is still a proposal needing approval.
- **Lesson curation**: edit, mute, and delete, all human-only (no MCP tool exposes any of
  it). Muting is the important one -- `searchLessons` is the single chokepoint every
  `lesson_search` goes through, so muting there removes a wrong lesson from the agent's
  reasoning everywhere at once while keeping the record of what was believed and when.
  Editing re-upserts the Qdrant vector so semantic search stops matching the old wording.
- Research-note dedupe: `findDuplicateResearchNotes` scores pairs by word-overlap (Jaccard)
  locally rather than one Qdrant round trip per note, so it answers the same way whether or
  not Qdrant is configured. Merging keeps the chosen note, appends any source the other had,
  and takes the higher confidence.

## Tier 5 -- hardening & polish

- Auth: `AGENT_API_TOKEN` gates `/api` and the WebSocket upgrade, compared with
  `timingSafeEqual`. The browser WebSocket API can't set headers, so the socket passes the
  same secret as a query param and the server checks it at the upgrade rather than letting
  an unauthenticated socket see the event stream. `AGENT_BIND_HOST` now defaults to
  `127.0.0.1`; with no token set the server logs a warning at startup. `TokenGate` prompts
  once and stores the token. One shared secret for the console, not per-user auth.
- Theme toggle: the palette moved to `--rl-*` CSS custom properties, so `palette.approved`
  is now `var(--rl-approved)` and every component follows the theme with no code change.
  Ant Design still needs real hex (it derives hover/active shades with color math), so
  `HEX_PALETTES` in `theme.ts` and the variables in `index.css` are two representations of
  one palette and have to stay in step.
- `ErrorBoundary` around the routes, so a render error in one page doesn't blank the console
  and take the pending-review queue with it.
- WS reconnect backoff with a visible state already existed in `useAgentSocket` -- 1s
  growing 1.5x to a 15s cap, with `StatusBar` showing connecting/open/closed. Nothing to do.
- Mobile: the sider already collapses under `lg`, and the Tier 0 `scroll.x` fix means tables
  scroll horizontally instead of crushing columns. That's the practical fallback; a genuine
  card-per-row mobile layout is still not there and is the one Tier 5 item left undone.

## Move large blobs/JSON out of SQLite

`actions.tool_input` / `actions.tool_output` store full JSON blobs inline as TEXT --
including entire file contents for every `github_commit_file` call. Over time this
will bloat `agent.db` and slow queries against the `actions` table.

Idea: store these as content-addressed files on disk (hash-named, like git objects),
keeping only the hash in the SQLite row. Reduces DB size and dedupes identical
content (e.g. the same file committed to multiple repos).

Not worth building yet -- at current scale (human-gated, a handful of proposals a
day) SQLite isn't actually hurting. Revisit if `agent.db` starts visibly bloating.
Tradeoff to weigh then: backups/restores would span two locations instead of one
`.db` file.

Note: this is *not* about the artifacts the agent ships (repo code, deployed sites)
-- those already live in a proper system of record (GitHub) and don't need a local
git-like store of their own.

## Switch to npm workspaces

Root (`package.json`) and `web/package.json` are two separate, unlinked npm projects
today -- `npm install` at the root doesn't touch `web/`, and there's no shared
lockfile. Convert to an npm workspaces layout (root `package.json` gets
`"workspaces": ["web"]`), so a single `npm install` at the root sets up both, and
root-level scripts can delegate to the web workspace (`npm run -w web build`, etc.)
instead of the current `web:*` proxy scripts shelling into a separate `web/`
install.

## Switch to Qdrant Cloud

Voyage AI's free tier (3 RPM / 10K TPM without a payment method on file) was producing
frequent 429s during research/reflect. Replaced `src/embeddings.ts` (Voyage) with
`src/qdrant.ts`: Qdrant Cloud does vector storage/search *and* server-side embedding
inference (free-tier models, no token limit) in the same request, so there's no
separate rate-limited embeddings API in the loop anymore. Same fail-soft contract as
before -- falls back to `LIKE` search if `QDRANT_URL` / `QDRANT_API_KEY` /
`QDRANT_EMBEDDING_MODEL` / `QDRANT_EMBEDDING_DIM` aren't all set. See `.env.example`
and `docs/semantic-search.md`.
## Per-goal research fan-out

One `researchAndPlanPhase` run per active goal, executing concurrently instead of a
single run handed the whole goal list, capped by an `AGENT_RESEARCH_CONCURRENCY`
setting defaulting to 1 so it stays opt-in and the cost stays the operator's call.

**Why it's attractive.** The prompt tells research to "pick whichever look most
promising -- you don't need to cover all of them evenly", and the model duly collapses
onto one lane: four goals configured, but recent cycles produced only Swedish-market
and property-comparison work. A goal with its own run cannot be crowded out by a
louder one. It would also make research spend attributable per goal -- `runs.goal_id`
already exists for exactly this and is currently never set, because one research run
covers every goal, which is also why `goalHealth.empty_cycles` has to count all
research runs rather than the goal's own. And wall-clock would scale with the number
of goals instead of summing them.

**Why it's deferred.**

- N× cost per cycle. Cheap at the current flash-model pricing (~$0.03 -> ~$0.12), not
  cheap on a pro model -- earlier `research_plan` rows in `runs` cost $0.50-$1.34 each.
- N× search-provider quota against one Tavily key.
- Duplicate-proposal race. The dedup check in `proposal-similarity.ts` reads open
  proposals from the DB, so two in-flight `proposal_create` calls can both pass it
  before either commits. The history already contains this failure twice
  (NoticeCraft/NoticeReady, and three spellings of the property-comparison site) --
  and that was with a *sequential* loop.
- `openProposalDigest()` goes stale mid-cycle: each run gets a snapshot taken before
  its siblings created anything, so the prompt-level duplicate guard weakens at
  exactly the moment the DB-level one is also under pressure.

**Revisit when** goal health shows a specific goal being starved rather than genuinely
empty -- that's the signal fan-out addresses and the prompt digests don't. Do the
`proposal_create` mutex first; it's worth having on its own merits.

Related and deliberately *not* on this list: parallel act phases. Side effects land on
shared GitHub/Vercel accounts, `actAbortController` is a single module-level handle
that would abort the wrong run, and it contradicts the serialization guarantee the
rest of the design assumes. Concurrent dispatch of read-only tool calls within a turn
is already implemented (`canRunConcurrently` in `agent-loop.ts`) and is where the
free latency win actually was.

## Move settings from `.env` into the database

Investigated 2026-08-16; **slice 1 shipped the same day** (`src/settings.ts`, `/api/settings`,
`web/src/pages/SettingsPage.tsx`). What shipped, and what is still open, is at the bottom of this
note. The goal: fewer things that need a file edit and a
restart, and a console that can change them. The finding: this is worth doing, but **not as
one migration** — the ~32 env vars fall into four classes with genuinely different answers,
and one of them (secrets) is a security decision rather than a refactor.

### The rule that makes it work

**Read at use, not at module load.** That is the whole "no restart" property, and most of the
codebase currently violates it: `integrations/{github,vercel,netlify}.ts`, `qdrant.ts`,
`server.ts` and `tools/web.ts` all capture `process.env.X` into a module-level `const`, which
freezes the answer at import time. (It's also why those integration tests need a dynamic
`await import()` to work at all.)

`src/connectors/` was deliberately built the other way — `isConfigured()` and `authHeaders()`
read the env on every call, and `configuredConnectorTools()` is a function the research phase
re-invokes each cycle — specifically so a key filled in mid-run takes effect on the next call.
**That is the shape to copy.** Anything converted to a DB setting has to be read through an
accessor at the point of use, or the setting will appear to save and change nothing until a
restart, which is worse than not moving it.

### The four classes

**1. Bootstrap — cannot move, don't try.**
`AGENT_DB_PATH` (you need the database to read settings out of it), `AGENT_SERVER_PORT`,
`AGENT_BIND_HOST`, `AGENT_CONSOLE_ONLY`, and `AGENT_API_TOKEN` — the last is a genuine
chicken-and-egg, since the token gates the console that would edit it. These stay in `.env`
and that's correct, not a gap.

**2. Already done — the precedent to follow.**
`AGENT_DOMAINS`, `AGENT_CYCLE_INTERVAL_MS` and pause already live in `control_settings`
(key/JSON value) via `agent-control.ts`'s `persist` callback, with env as a *seed* for a fresh
DB and the saved value winning after that. `mainLoop` re-reads control state each pass rather
than closing over constants, which is exactly the "read at use" rule above. Everything below
should extend this table and this pattern rather than inventing a second mechanism.

**3. The easy wins — plain behavioural knobs, no secrets, real payoff.**
In rough order of value:

- `AGENT_MAX_PENDING_PROPOSALS` — a throttle you'd actually want to change while watching a
  queue build up.
- `AGENT_SEARCH_PROVIDER` — already has the seam: `getSearchConfig()` caches, and
  `resetSearchConfig()` exists as a test hook. Note the one wrinkle: `native` mode changes
  *whether the `WebSearch` tool is registered*, and the registry is built once at startup.
  Same answer as connectors — register it always and let the mode decide at call time, or
  accept that this one setting needs a restart and say so in the UI.
- `AGENT_MODEL` / `AGENT_PROVIDER` and the per-phase overrides — high value (switching the act
  model without a restart is a real workflow) but the most invasive: `llm/index.ts` resolves
  clients once into `llmByPhase`. Needs a `resolveLlmClients()` re-run on change, and the
  startup validation that produces the good "here is your provider's model list" error has to
  move into the save path so a bad model id is rejected at the console, not at the next cycle.
- `AGENT_TEMPERATURE`, `AGENT_MAX_TOKENS`, `AGENT_LLM_MAX_ATTEMPTS`, `AGENT_SCHEDULER_TICK_MS`,
  `AGENT_WEBFETCH_*` — trivial once the accessor exists, low individual value.

**4. Secrets — a decision, not a refactor.**
Provider keys, `GITHUB_TOKEN`, and the connector keys are the ones most annoying to change
today and the ones with a real cost to moving. Putting them in `data/agent.db` means plaintext
credentials in a file that is *also* opened by console-only mode, copied into
`agent.db.bak-*` files sitting next to it, and handed around as "the database". Today a leaked
DB costs you the agent's memory; afterwards it costs you a Stripe key.

If it's done: keep them in a separate table with an explicit `secret` flag, never return the
value over `/api`(only `{set: true, hint: "sk_…3f9a"}`), never log it, and treat the backup
files as secret-bearing. **Or** don't move them and instead close the actual gap, which is
narrower than it looks: connector keys already take effect without a restart, so the only real
friction left is having to open a file. A "which keys are missing" display — which the Agent
control page now has — solves most of the pain at none of the risk.

### Sketch of the mechanism

A `settings` table alongside `control_settings` (or an extension of it), plus a declarative
registry in code: key, type, default, `envVar` fallback, `secret?`, `restartRequired?`, and a
validator. Resolution order **DB value → env → default**, through one `getSetting(key)`
accessor that replaces the direct `process.env` reads. The registry then drives the console
page for free — field types, help text, and an honest "needs a restart" badge on the few that
do.

Two constraints that are easy to miss:

- **Console-only mode.** `ControlSettingsWriter` deliberately reaches exactly three keys of one
  table and nothing else, and `CONSOLE_ONLY_WRITABLE_ROUTES` is the matching server allowlist.
  A settings page means widening that writer — do it by extending its key allowlist, never by
  relaxing the store to read/write. The whole design of that module is that the capability
  added is the small one.
- **Precedence has to be visible.** Once a DB value wins over `.env`, an operator editing
  `.env` and seeing nothing happen is the confusing failure. The console should show, per
  setting, whether the value came from the database, the environment, or the default — the same
  problem `AGENT_DOMAINS` already has, where editing it after the console has set goals does
  nothing.

### What slice 1 actually shipped

The registry + accessor, stored in `control_settings` under a `setting:` prefix (no new table --
same key/JSON shape, and `loadControlSettings` already ignores keys it doesn't know). Settings
moved: `AGENT_MAX_PENDING_PROPOSALS`, `AGENT_SEARCH_PROVIDER`, and `AGENT_PROVIDER`/`AGENT_MODEL`
plus all six per-phase overrides.

The overrides came along rather than being left for later on purpose: leaving them in `.env` while
the base pair moved would have created exactly the silent-precedence trap this note warns about --
set the model in the console, and an `AGENT_ACT_MODEL` line in `.env` would quietly win for the act
phase with nothing saying so.

Two things turned out to matter more than expected:

- **`getSearchConfig()` had to become self-invalidating**, caching against a signature of its own
  inputs rather than a boolean, and `buildWebTools()` had to stop registering `WebSearch`
  conditionally. Conditional registration silently made the search mode restart-only: switching
  from `native` to `tavily` left no tool to call. Whether the model is *offered* WebSearch is now
  decided per run in `agent-loop.ts`, which is where native mode was already turned on.
- **`verify` on the write path.** Field validation cannot catch a provider that is spelled
  correctly and has no API key, which is the single most likely mistake on that page.
  `updateSettings` takes a callback, runs it against the applied state, and rolls back -- and
  `server.ts` scopes it to what the patch touched, so a missing `AGENT_MODEL` on a fresh install
  doesn't block someone changing the proposal cap.

### Still open

- **Class 3 leftovers**: `AGENT_TEMPERATURE`, `AGENT_MAX_TOKENS`, `AGENT_LLM_MAX_ATTEMPTS`,
  `AGENT_SCHEDULER_TICK_MS`, `AGENT_WEBFETCH_*`. Trivial now -- one registry entry each plus
  switching the read site off `process.env`. `MAX_OUTPUT_TOKENS` in `llm/index.ts` is the one to
  watch: it's a module-level const, so it needs the read-at-use treatment.
- **`AGENT_CYCLE_INTERVAL_MS` and pause** are still on the Agent control page via
  `agent-control.ts`, which predates this and works. Worth folding into the settings registry only
  if a third mechanism starts to look likely -- not for tidiness.
- **Secrets**: still `.env`, still the right call. Revisit only with a real answer for the backup
  files and a `secret` flag that never returns the value over the API.
