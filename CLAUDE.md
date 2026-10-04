# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An autonomous market-research agent. The operator states goals; the agent researches them, files
business ideas (software or not) with a market assessment and a money path, and, once a human
approves an idea in the web console, investigates it in a **deep dive** that ends in a written
feasibility report. Reflection turns each report (and each rejection) into a lesson. No sub-agents:
the tool registry contains no tool that spawns one, and `agent-loop.ts` only ever dispatches tools
from that registry.

This project used to build and deploy software (GitHub commits, Vercel and Netlify deploys, Stripe
and email connectors). That write path was **removed**, not feature-flagged. Old rows from that era
stay in the database and still render; the notes below call them "legacy" or "build mode".

**It is not tied to any one model vendor.** It talks to model APIs directly over HTTP. There is no
Claude Code, no Agent SDK, no vendor SDK of any kind. `AGENT_PROVIDER` selects OpenRouter, OpenAI,
Anthropic, xAI (Grok) or Moonshot (Kimi); `AGENT_MODEL` names the model. Phases can use different
models (`AGENT_ACT_MODEL` etc.). Nothing outside `src/llm/` should contain provider-specific code.

**The core invariant: no tool with an external side effect exists.** Every tool the agent can call
either reads (the web, public data sources, public GitHub) or writes to its own SQLite database.
This is enforced in three places rather than promised in a prompt:

- `integrations-server.ts` registers only GitHub *read* tools.
- `connectors/manifest.ts` accepts `risk: "read"` only, so an operator manifest declaring a write
  operation fails validation at load and is skipped (logged in `CONNECTOR_ERRORS`).
- `npm run smoke-test` fails if any registered tool classifies (`toolRisk`) as anything but `read`
  or `memory`.

Don't add a write tool, a connector `risk` other than read, or anything that sends, posts, buys,
deploys or contacts. If a future feature genuinely needs one, it is a design change to discuss, not
an integration to add.

**What approval gates now is spend.** The deep dive is the longest, most expensive phase, and only
a human approval starts one. Don't add anything that auto-approves ideas. `report_submit` accepts a
report only for the idea whose deep dive is running (`act_status = 'running'`), so a deep dive
cannot file verdicts on ideas nobody asked about. Each phase is still fenced structurally:
`agent-loop.ts` owns tool dispatch, so a tool outside the phase's grant is never described to the
model and is refused if the model names it anyway. (Under the old Agent SDK this needed three
overlapping mechanisms, `allowedTools`, `canUseTool` and a `PreToolUse` hook, because each had a
documented gap the next one patched. Those are gone; don't reintroduce that shape.)

At approval the operator can edit the idea's description (applied before the status flips, with
the model's text kept in `original_description`) and add **focus questions** in the decision notes,
which the deep dive is told to answer first. Every other lever the console offers (pause, abort,
directives, goals) can only reduce activity or redirect research.

**The same invariant, one level up: no accepted goal, no research.** Goals are what the loop is
pointed at (see Architecture below). The agent can *suggest* one with `goal_suggest` when a lane it
was given keeps coming up empty — but a suggested goal is inert: `status='suggested'` is excluded
from `activeGoals()`, never appears in a prompt, and `resolveGoalId` refuses to file anything under
it. Only a human clicking Accept makes it real. Don't add anything that auto-accepts a suggestion,
for the same reason nothing auto-approves an idea: it would let the agent choose what it works
on. Retired goals are equally unreachable, so dismissing a suggestion also stops the lane coming
back — that refusal is deliberate, not a bug.

## Commands

```bash
npm install
npm run smoke-test    # sanity-checks the DB + tool wiring directly, no API key needed — run this first
npm test              # vitest run — unit tests over src/**/*.test.ts, no API key needed
npm run typecheck     # tsc --noEmit over src/
npm start             # tsx src/orchestrator.ts — runs the agent loop + web console together (one process, one SQLite connection)
npm run start:console # console-only: serves the real DB read-only, runs no loop, calls no model API
npm run mcp           # MCP server over stdio: read-only access to the record for Claude Desktop
```

**`start:console`** (equivalently `AGENT_CONSOLE_ONLY=1`; the CLI flag exists because `VAR=1 npm start`
doesn't work on Windows) is the harness for working on `web/` and `server.ts`: it opens the real
database **read-only**, starts the API and console against it, and stops there. No research cycle,
no scheduler, no review queue, no model client — every one of those exists to write something, and
this mode writes nothing to the record. It needs no provider key and no `AGENT_MODEL`.

Read-only is enforced twice on purpose: SQLite itself rejects writes (`new MemoryStore(path,
{ readOnly: true })`), and `server.ts` refuses non-GET `/api` requests with a 403 so the UI gets
one clear answer instead of a SQLite error surfacing from somewhere deep. So the console's write
features (approve/reject, muting a lesson, re-running a deep dive) can't be exercised in
this mode — that's the trade for touching nothing. The obvious alternative, a scripted model driving
the real loop against a scratch DB, was tried and rejected: an empty DB makes the console useless to
develop against, and a copy of the real one drifts.

**The one exception: goals, cycle interval and pause are writable here.** They're the settings
the *next* real run reads at startup, and `AGENT_DOMAINS` stops being the source of truth the moment
the console first sets goals — so without this, retargeting the loop before starting it meant
hand-editing the DB with a sqlite one-liner. `MemoryStore` stays read-only; these persist through
`ControlSettingsWriter`, a **separate connection that can reach three keys of `control_settings` and
the `goals` table, and nothing else**. Relaxing the store to read/write instead would have put every
proposal, lesson and action one forgotten `if` away from a mode whose whole promise is that it writes
nothing — this way the capability added is the small one, and the guarantee over everything else is
untouched rather than re-defended. Both layers still apply: `CONSOLE_ONLY_WRITABLE_ROUTES` is the
server's allowlist (anchored regexes, since the goal routes carry an id), and the writer
independently ignores any key or column outside its own two allowlists.

**Deleting a goal is excluded from this mode on purpose.** `MemoryStore.deleteGoal` also clears
`goal_id` across proposals, lessons, notes, runs and reports, and this writer must not be able to reach those
tables. Dismissing (status → `retired`) is the reversible equivalent and stays within `goals`.

Settings (`src/settings.ts`) are writable here for the same reason: they're what the next real run
reads at startup, and this is the mode you'd use to set it up before starting it. They go through the
same writer, whose allowlist is the `SETTINGS` registry itself rather than a second hand-written list.
Model validation is **not** skipped here — `resolveLlmClients()` is a pure function of settings plus
the API keys in `.env`, so it needs no running loop, and this is precisely where the next run's model
gets chosen.

`directive`, run-now and abort are **excluded on purpose** even though a directive persists like the
others: all three need a research loop, and this mode has none. Run-now especially would answer 200
and wake nothing — a control that reports success and has no effect is worse than one that refuses.
`GET /api/status` returns `consoleOnly` so the UI disables exactly what the server would reject
(`web/src/consoleOnly.ts` → `useConsoleOnly()` / `READ_ONLY_HINT`) instead of offering every write
button and failing after the click; a header tag says which mode you're in. **New write controls
should read that hook**, and new writable routes have to be added to the allowlist *and* the
writer's key set, or they'll 403 in this mode.

Vitest covers the parts that can be tested without an API key: `src/memory-server.test.ts`
(`MemoryStore` against an in-memory SQLite DB, with `qdrant.ts` mocked so tests are deterministic
regardless of ambient `QDRANT_*` env vars — the mock returns `null` by default, so most tests exercise
the LIKE-fallback path, and a `vectorHits` handle lets individual tests script real scored hits, which
is what finally covers the semantic path: hydration order, the confidence re-ranking, and `[]` vs
`null`. Also covers goal seeding/resolution, the suggest-stays-inert invariant, and dedup-on-write),
`src/tools/registry.test.ts`
(schema conversion and in-band error handling), `src/tools/web.test.ts` (HTML-to-text, and that WebFetch
refuses loopback/private addresses), and `src/llm/pricing.test.ts` (the cost table, the OpenRouter
reported-cost path, and the deliberate $0-for-unknown-model behaviour). The adapters and the loop itself
aren't unit-tested — they're thin over HTTP, and a mock of a provider's wire format mostly tests the mock.
`src/proposal-similarity.test.ts` (the duplicate check, against real proposals from the agent's
own history: the pairs it must catch and the follow-up pair it must not).
`src/deep-dive.test.ts` (whether a deep dive produced a report, and the push-back when it didn't),
`src/landscape.test.ts` (grouping a goal's notes by kind and merging the competitors its ideas named),
`src/llm/types.test.ts` (the truncation-vocabulary list, which a new provider can quietly break),
`src/shutdown.test.ts` (the teardown order, the grace period, and the forced second signal),
`src/aborted.test.ts` (that both shapes of deliberate abort are recognized and a real failure isn't),
`src/connectors/*.test.ts` (manifest validation, including the refusal of write operations, and
request building; the generic request features run against test-only manifests in
`src/connectors/test-fixtures/`, loaded through `AGENT_CONNECTORS_DIR`, because no bundled connector
happens to use all of them) and `src/agent-loop.test.ts` (the nudge, the exception to the
no-loop-tests rule; see that module). `smoke-test.ts` runs end-to-end against a throwaway
`./data/smoke-test.db`, builds the real tool registry and serializes every schema (the cheap way to
catch a zod shape that can't be converted, since otherwise it surfaces as a provider 400 on the
first live cycle), and asserts the no-write-tools invariant above.

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
search keys `TAVILY_API_KEY` / `BRAVE_API_KEY` (see below); optional `GITHUB_TOKEN` (read-only
competitor search), `AGENT_NOTIFY_URL` (see `notify.ts`) and `QDRANT_URL` + `QDRANT_API_KEY` +
`QDRANT_EMBEDDING_MODEL` + `QDRANT_EMBEDDING_DIM` (all four required together for semantic search).
Each feature is simply unavailable, not a startup error, when its keys are missing. Connector keys
(`DATAFORSEO_AUTH`, plus `AGENT_CONNECTORS_DIR` for extra manifests) work the same way, except that
they're read per call rather than at startup, so filling one in takes effect on the next cycle
without a restart.

**`AGENT_MODEL` has no default on purpose.** Providers rename and retire models constantly; a model id
baked into the code fails at the first API call with an opaque 404 instead of at startup with a message
naming the provider and its model list. Don't add one.

**`AGENT_MAX_TOKENS` defaults to 32768, and numeric env vars go through `positiveIntEnv`.** Two things
were wrong here at once. `Number(process.env.X ?? default)` does not do what it looks like it does: a
var that is present but empty — which is how `.env.example` ships this one — is `""`, not `undefined`,
so the default never applies and `Number("")` is 0. Every model call shipped `max_tokens: 0`, and it
went unnoticed only because OpenRouter ignores it. Fixing that alone would have been a *regression*:
8192 was the documented default, and the largest successful build-mode commit in this agent's history
was ~16k output tokens, so that phase only ever worked because the cap wasn't being applied. The same
holds for a deep dive, which submits its whole report in one `report_submit` call: a low value doesn't
produce a shorter report, it produces one cut off mid-section. **Use `positiveIntEnv` for any new
numeric env var** rather than `Number(... ?? d)`.

## Architecture

### The four-phase loop (`src/orchestrator.ts`)

Each cycle: **research → human review → deep dive → reflect**.

- **research** (`researchAndPlanPhase`, persisted phase key `research_plan`): gets its whole tool
  grant up front with no human in the loop, since every tool available to it is read-only or writes
  only to the agent's own memory DB. Can span multiple goals per cycle and file 0-3 ideas; not forced
  to cover them evenly. It saves findings as research notes with a `kind` (`gap`, `demand`,
  `market_size`, `competitor`, `pricing`, `risk`, `saturated`, ...), which is what each goal's market
  landscape is built from.

  **What it's shown, versus what it can ask for.** Four digests are injected into the prompt before it
  starts: the open idea queue (with each deep-dived idea's verdict, so a "drop" isn't re-pitched without
  new evidence), the lessons that apply, the ground already found saturated, and, for any goal that's
  gone quiet, an exploration mandate. `openProposalDigest`'s own rationale is why ("a duplicate has to
  be prevented on every cycle, and a tool only helps on the cycles the model remembers to call it"),
  and it applies unchanged to lessons and dead ends: the prompt had always *told* research to call
  `lesson_search` and `research_note_search` first, roughly a third of the notes on file were "I
  checked, it's saturated", and cycles kept re-checking them anyway. The tools are still granted; the
  digests are a floor, not a replacement. Each goal's **brief is passed verbatim**, which is where
  operator instructions ("research in Swedish, check Fortnox/Bokio first") belong; the title is only
  the key, and the prompt tells the model to echo it back exactly when filing anything.

  Filing **zero** ideas is a legitimate result: the prompt tells it not to force a weak one, and a
  goal whose ideas keep getting rejected will eventually stop producing any. That state used to be
  invisible (stdout only), which is indistinguishable from a broken loop, so a cycle that creates
  nothing emits a `no_proposal` event carrying the model's own stated reason. It also carries the
  phase's tool-call count, because **zero tool calls is a different thing entirely**: the phase never
  researched at all (an empty or failed model response) and the console says so rather than reporting
  it as a considered decision.
- **human review** (`humanReviewPhase`): emits a `proposal_pending` event and blocks on
  `waitForDecision()` (`review-gateway.ts`), resolved when a person clicks Approve/Reject in the web UI
  (`POST /api/proposals/:id/decision`).

  **An idea becomes visible when the row is written and decidable only when a resolver exists**,
  and those were far apart: `enqueueForReview` ran only when the whole research phase *returned*, so an
  idea filed 10 minutes into a 15-minute phase sat in the console answering "No pending decision" to
  every Approve click until the phase ended. `reviewSweep()` closes it on the scheduler interval (~15s
  worst case). It's a reconciliation sweep, not a notification on create, because "pending row, nothing
  waiting on it" has several causes (an aborted research phase, a decision that raced a restart) and
  fixing only the create path would leave the rest. `enqueueForReview` is idempotent via
  `hasPendingDecision`. Multiple ideas can be under review concurrently, each on its own promise. An
  approval can carry an `editedDescription` (applied via `store.applyProposalEdits` *before*
  `decideProposal` flips the status) and `notes`, which become the deep dive's focus questions. A
  **rejection** runs `reflectOnRejectionPhase` (memory-only tools, same grant as reflect) with the
  human's stated reason, so being told no produces a lesson instead of teaching the agent nothing.
- **deep dive** (`deepDivePhase`, persisted phase key `act`): a read-only investigation of one approved
  idea. The grant is `MEMORY_TOOLS` + `WebSearch`/`WebFetch` + the configured read tools +
  `DEEP_DIVE_OUTPUT_TOOLS` (`report_submit`); nothing comes from the legacy `required_tools` column.
  The prompt restates the research phase's market, monetization and launch-outline claims as things
  to verify or refute, puts the operator's approval notes first as questions to answer, includes the
  previous report's summary on a re-run, and fixes the report's section headings.

  **The prompt asking for a report is not the same as one existing**, which is what `verifyDeepDive`
  (`deep-dive.ts`) closes. `runAgent` returns whenever the model stops calling tools, so a model that
  announces "now I'll write the report" and stops would otherwise look finished. `deepDiveNudge` pushes
  back (up to `MAX_NUDGES`) until `report_submit` has been accepted; if it never is, the verdict
  (`act_status = 'incomplete'`) and an `act_incomplete` event record it, and reflect is told what went
  wrong. The event and column names are inherited from build mode and kept because they're persisted.
- **reflect** (`reflectPhase`): calls `lesson_search` first; reinforces an existing lesson via
  `lesson_reinforce` if this report confirmed/contradicted it, otherwise adds one new generalized
  lesson. It is handed the report's verdict, score and summary *and* the research phase's original
  viability score, so it can learn calibration ("research over-rated this kind of idea") rather than
  only retelling the report. Without a report it gets the deep dive's problems instead.

**Concurrency**: research runs one cycle at a time on `AGENT_CYCLE_INTERVAL_MS`. Every new idea
immediately starts waiting for review in parallel with any others already pending. Once approved, an
idea's deep dive + reflect go through a single priority-ordered queue (`runQueue` / `drainQueue`), one
at a time. That serialization now bounds spend and provider rate limits; there are no side effects
left for it to guard.

Every tool call in every phase is logged by `runPhase`'s `onToolCall` callback, and every phase's model
API cost is recorded — spend counts against profit. Cost is no longer handed over the way the SDK's
`total_cost_usd` was: it's computed from token usage against `llm/pricing.ts`, or taken from the provider
when it reports a real per-call charge (OpenRouter does). It accumulates via `onTurnCost` per model call
rather than being read off the result, and the ledger write lives in a `finally`, so an aborted or crashed
phase still lands in `runs` with the spend it actually incurred — a phase missing from the ledger, or
present with a zero, would understate what the loop cost. `runs` also records the `provider`/`model` that
produced each row, since phases can be pointed at different models.

**Runtime control** (`agent-control.ts`) holds state the operator drives from the console: paused,
goals, cycle interval, a one-shot research directive, and a live view of what's executing. `mainLoop`
re-reads it each pass instead of closing over the env constants, so changes take effect without a
restart. The operator-set half **persists** to `control_settings` (key/JSON-value) via a `persist`
callback `initControl` is handed — `agent-control.ts` never imports `MemoryStore`, so it stays
dependency-free and can't read anything back out of the DB.

`ControlState.domains` is now a **projection**, not a field: `setGoals` derives it as the titles of the
active goals, so there's no way for "what the loop is pointed at" and "what the goals table says" to
disagree. `control_settings.domains` is still written with those titles — nothing in the loop reads it
any more, but it stays the record a fresh DB seeds goals from. At startup the orchestrator merges: env
seeds a fresh DB, saved settings win, and `seedGoalsFromDomains` turns that list into goals exactly
once. That makes `AGENT_DOMAINS`/`AGENT_CYCLE_INTERVAL_MS` **seed
values, not the source of truth** — editing `.env` after the console has set them does nothing, which
is the opposite of the old behaviour where a console change looked permanent and silently reverted on
restart. Consuming a directive persists the clear too, or a one-shot steer that survived a restart
would then survive being used and quietly become standing instruction. `paused` persists as well: a
pause is the operator saying "stop spending", and losing that on restart resumes activity they didn't
ask for. Live execution state (`runningProposalId`, `queuedProposalIds`) is not persisted — it
describes this process, not a preference. "Run a cycle now" resolves `sleepUntilNextCycle` early; aborting a deep dive fires
the `AbortController` passed to that run (skipping reflect, since there's no report to reflect on). A directive is consumed — injected into one research prompt, then cleared.

### Backend modules (`src/`)

- `llm/` — everything provider-specific, and the only place it should live. `types.ts` is the neutral
  vocabulary (messages, tool calls, usage) every phase speaks. Two adapters implement it:
  `openai-compatible.ts` covers OpenRouter, OpenAI, xAI and Moonshot (they share the `/chat/completions`
  wire format and differ only in how you cap output tokens, how you turn on server-side search, and
  whether the provider bills the call back to you), and `anthropic.ts` covers Claude's Messages API
  natively — worth its own file rather than going through Anthropic's OpenAI-compat shim, which lags on
  tool use. `providers.ts` is the registry of base URLs / key env vars / model-list links; `http.ts` is
  one retrying JSON POST (429 and 5xx only — a 400 from a bad model id is returned immediately);
  `pricing.ts` turns tokens into dollars; `index.ts` resolves one client per phase from the settings
  and env.
  Adapters must normalize `Usage.inputTokens` to *total* prompt tokens including cached ones — Anthropic
  reports the uncached remainder, so its adapter adds the cache fields back or pricing under-counts.
- `agent-loop.ts` — the replacement for the SDK's `query()`: ask the model, run the tools it asked for,
  feed results back, repeat to `maxTurns`. Provider-agnostic (it only touches an `LlmClient`), and the
  place the tool fence is enforced.

  **The loop ends when a turn has no tool calls — so it has to know *why* there are none.** A turn cut
  off at the output limit has no tool calls either, because the model was still writing. Both adapters
  had always reported the provider's finish reason and nothing read it, so the two were literally the
  same event and a phase that died mid-sentence returned a clean `end_turn`. `AgentStopReason` now
  carries a third value, `truncated`, decided by `isTruncationStop` in `llm/types.ts` — which matches
  across vocabularies (`length`, `max_tokens`, `MAX_TOKENS`) because OpenRouter passes the upstream
  provider's spelling straight through. **A new provider means checking that list.** Truncation *with*
  tool calls is left to self-correct (the last call's JSON is incomplete, `parseArgs` hands the tool
  `{}`, zod rejects it) but is warned about, since a payload that overflows once overflows on retry too.
  `providerStopReason` is carried out of the run verbatim and **logged on every phase, pass or fail** —
  it was computed on every turn and read by nothing, so the only way to learn it after the fact was to
  not be able to.

  **`nudge` is what stops one bad turn losing the phase.** "No tool calls" means "done" only for a
  phase whose output is prose; for one with a checkable definition of finished it's a question the
  caller can answer. In build mode an act phase twice read everything it needed, wrote *"Now I'll write
  the full prototype and commit it in one call"*, and returned nothing (proposals #27 and #29). The
  callback (see `deepDivePhase`, which uses `deepDiveNudge` from `deep-dive.ts`, and `reflectPhase`)
  returns text to push back or null to finish. It goes in as an ordinary user turn **after** the
  model's own, so the whole transcript survives and the model finishes the job rather than a fresh
  phase re-deriving everything. `MAX_NUDGES` is 2: a first nudge is often answered with one more
  search instead of the required output, and a model that ignores being told twice is stuck. It
  can't widen the grant: a nudge is text.
  `agent-loop.test.ts` is the deliberate exception to "don't unit-test the loop": this is loop logic
  driven through our own `LlmClient` interface, not a mock of anyone's wire format.

  **A nudge after a *truncated* turn is a different nudge.** A turn that overflowed the output
  limit without calling a tool is a model writing a long document (in build mode a file, now a
  report) out as prose instead of putting it in the call. Telling it "you didn't finish, do X" is
  advice it already agrees with, and following it the same way overflows again. So that path says
  what to do differently (content goes in the tool call, at a length that fits) and replays only the
  first `TRUNCATED_REPLAY_CHARS` of the cut-off turn: the fragment can't be saved from, and keeping
  32k of it in context makes the *next* turn
  likelier to overflow too. `providerRaw` is dropped there on purpose — the Anthropic adapter
  replays it in preference to `content`, which would put the whole turn back.

  **Tool calls run concurrently only when the whole batch is pure reads** (`canRunConcurrently`, gated
  on `toolRisk`). Research is latency-bound on the network — one run in the ledger took 39 minutes,
  almost all of it WebSearch/WebFetch in series — so this is free wall-clock. The bar is deliberately
  high and `memory` is excluded, even though it only touches the agent's own DB:
  several memory tools now check for a near-duplicate before inserting, and two similar calls dispatched
  together would both pass that check before either wrote, letting through exactly the duplicate the
  guard exists to stop. Results are consumed in the model's original call order regardless of which
  finished first, so the transcript, the `actions` table and the activity feed are unchanged —
  concurrency is a latency change, not an ordering one.
- `tools/registry.ts` — what replaced the MCP servers. A tool is a name, description, zod schema and
  handler; the registry converts schemas to JSON Schema (`z.toJSONSchema`, `io: "input"`) and dispatches.
  Every failure — unknown tool, invalid args, throwing handler — comes back as `isError` tool text rather
  than an exception, so one bad call costs a turn instead of the phase. **Tool names keep their
  `mcp__memory__` / `mcp__integrations__` prefixes** even though no MCP server exists any more: those
  strings are persisted in `actions.tool_name` (and in legacy proposals' `required_tools`), and the
  console strips them for display. Treat them as opaque namespaces; renaming would split the action
  history for no behavioural gain.
- `tools/web.ts` — `WebSearch` and `WebFetch`, which were Claude Code built-ins and had to be rebuilt.
  `WebFetch` is always registered (fetch + a regex HTML-to-text pass, with private/loopback addresses
  refused). `WebSearch` is registered only in `tavily`/`brave` search mode.
- `search/` — the seam behind `WebSearch`: `tavily.ts` and `brave.ts` implement one small interface, and
  `index.ts` resolves the mode from `AGENT_SEARCH_PROVIDER` (`auto` | `tavily` | `brave` | `native` |
  `none`). In `native` mode no local tool is registered at all and `agent-loop.ts` instead sets
  `ChatRequest.nativeSearch`, which each adapter translates to its provider's own knob (OpenRouter
  `plugins`, xAI `search_parameters`, OpenAI `web_search_options`, Moonshot's `$web_search` builtin,
  Anthropic's `web_search_*` server tool). **The point of the seam: "WebSearch" means the same thing to
  the operator in all modes**: one tool name in every phase's grant, one badge in the console. Keep it
  that way.
- **Goals** (`goals` table, in `memory-server.ts`) — what the loop is pointed at, and what replaced the
  free-text `domain` string as the thing the operator curates. That string was doing two incompatible
  jobs at once: a stable grouping key *and* a research brief. It could not do both. The model invents
  the domain on every `proposal_create` and nothing validated it, so 20 proposals arrived under **13
  distinct spellings** — "comparison site / affiliate", "affiliate comparison site" and "comparison
  directory affiliate site" are one idea under three keys — which silently broke every exact-match
  lookup built on it: the (since removed) `action_history_search` returned nothing for any configured
  domain, the scoreboard fragmented, and the `searchLessons` LIKE fallback reached zero rows. Meanwhile one configured domain
  was a 400-character paragraph of research instructions, because a newline-delimited textarea was the
  only place to put a brief.

  A goal has `title` (short, stable, the key) and `brief` (the long instructions, kept out of the key),
  plus `status` / `weight` / `origin` / `parent_id` for branches. **Two mechanisms, deliberately
  separate**: `goal_id` is for *attribution* (scoreboard, per-goal health, filters) and is exact;
  *recall* (`lesson_search`, `research_note_search`) matches semantically on
  `title + brief`, so it reaches history written under any of the old spellings. That split is why
  nothing had to be backfilled — pre-goals rows keep `goal_id = NULL` and their `domain` text, and are
  still findable. `resolveGoalId` maps the model's free-text `domain` onto a goal at write time, which
  is what makes the wording stop mattering; it is deliberately **strict and title-only** (measured:
  including the long brief made the Swedish goal a magnet that swallowed unrelated labels at 0.75),
  because a misfiled row puts a number on the scoreboard that isn't true, while an unassigned one is
  merely where every legacy row already sits. The market landscape (`landscape.ts`) uses `goal_id`
  only, and says so in the console: guessing legacy rows into a goal would be the misfiling this
  avoids.

- `memory-server.ts`: SQLite-backed memory (`data/agent.db`) plus the tools the model can call:
  `research_note_add`, `research_note_search`, `lesson_search`, `lesson_add`, `lesson_reinforce`,
  `proposal_status` (all in `MEMORY_TOOLS`, every phase), `proposal_create` and `goal_suggest`
  (`RESEARCH_OUTPUT_TOOLS`, research only, because both write a row a *human* then acts on), and
  `report_submit` (`DEEP_DIVE_OUTPUT_TOOLS`, deep dive only). `outcome_record` and
  `action_history_search` were build-mode tools and are gone; the `outcomes` table stays for legacy
  rows. Approving ideas, logging actions, and **curating memory** (editing, muting, or deleting a
  lesson; deleting or merging research notes) are deliberately *not* model-callable tools: those
  stay with the orchestrator and the human. `buildMemoryTools(store)` returns the tools; `MemoryStore`
  itself is a plain class the orchestrator and `server.ts` call directly for everything the model
  must not control.

  **Every idea has to state its market and its money.** `proposal_create` (name kept, it is
  persisted) requires a `market` block (market size and how it was derived, `demandEvidence` with
  an http(s) `sourceUrl` per claim, named `competitors`, `keyRisks`, a 1-5 `viabilityScore` and a
  `confidence`), a `revenueModel`, a `monetization` block (who pays, price point, path to first
  dollar, days, key assumption, validation signal) and an ordered `steps` list (the launch outline a
  human would follow, validation first). They're stored as `market_json` / `revenue_model` /
  `monetization_json` / `steps_json`. A demand-evidence URL that isn't http(s) refuses the create in
  band, so every claim the deep dive is asked to verify points somewhere checkable. The revenue
  models include `sponsorship_donations`, `open_core` and `deferred` (audience first, charge later),
  so free and open-source ideas state their money path honestly instead of filing as "other".
  `requiredTools` and the agent-step/fence cross-check are gone with build mode; legacy steps still
  carry `owner`/`tool` and still render.

  All these columns are nullable and **not backfilled**: a pre-existing proposal renders no section
  rather than a row of dashes, same stance as `goal_id`. `market_json IS NULL` is also how the
  console recognizes a legacy build-mode proposal.

  **`report_submit` is the deep dive's one output.** It refuses in band unless the idea is approved
  *and* `act_status = 'running'`, the body is at least ~600 characters, and every source is an
  http(s) URL. Reports live in their own `reports` table (verdict `pursue`/`maybe`/`drop`, score,
  confidence, summary, Markdown body, `sources_json`); an idea can have several and the newest counts
  (`latestReportsByProposal`). `GET /api/proposals` attaches each idea's latest report summary.

  Muting matters most: `searchLessons` is the single chokepoint
  every `lesson_search` goes through, so muting there removes a wrong lesson from the agent's reasoning
  everywhere at once while keeping the record of what was believed and when. `searchLessonsByText` is a
  deliberate sibling of `searchLessons` for the console's operator — the agent looks lessons up *by
  domain* (its LIKE fallback matches domain equality), which finds nothing for a human typing a phrase
  from a lesson body. Same semantic path, same muted filter, different fallback. Notes/lessons are ranked by Qdrant hybrid search when Qdrant
  is configured, falling back to `LIKE` text matching otherwise; `syncToQdrant()` (called once at
  startup in `orchestrator.ts`) brings the cluster in step with SQLite.

  **Lessons are re-ranked by confidence** (`rankLessons`), because the LIKE fallback had always ordered
  by `confidence DESC` and the moment Qdrant was configured that stopped applying at all — results came
  back in pure similarity order, so a lesson the agent had been contradicted on could outrank one
  reinforced to 0.9. Reinforcement was being recorded and then ignored. Relevance still dominates
  (confidence scales it 0.5x–1.0x rather than replacing it).

  **Notes and lessons are deduplicated on write**, the same in-band-refusal pattern `proposal_create`
  uses: the model gets a tool result naming the existing row and telling it to `lesson_reinforce` or add
  only what's new. The thresholds are measured against the real store and the measurements are in the
  code — `LESSON_DUPLICATE_THRESHOLD` 0.70 sits in a wide gap (the two ~95%-identical credential
  lessons written 50 seconds apart score 0.783; the next-closest genuine pair 0.577), while
  `NOTE_DUPLICATE_THRESHOLD` 0.85 sits in a **narrow** one (0.863 for a real duplicate, 0.842 for a pair
  that only looks like one) and errs high on purpose. **Re-measure against the real DB rather than
  nudging either constant.** Both fall back to the lexical measure in `proposal-similarity.ts` when
  Qdrant is unavailable, on its own scale.

  **Research notes carry a `kind`** (`gap` / `saturated` / `competitor` / …). Roughly a third of the
  existing notes are saturation findings, which are useful as a *negative* filter ("don't re-check
  these"), not as positive context — a distinction the store previously could not express.
  `listSaturatedNotes` bridges legacy rows with a `kind IS NULL AND topic LIKE '%saturat%'` clause,
  reading a label the model already wrote in its own topic; without it the saturation digest and the
  exploration query return nothing until months of new notes accumulate. The research and deep-dive
  prompts now ask for `demand`, `market_size`, `competitor`, `pricing` and `risk` notes too, which is
  what the market landscape groups by. Also owns the `events` table (persisted activity feed, capped
  at `EVENTS_KEEP`).
- `qdrant.ts` — REST client for Qdrant Cloud, both vector storage/search and (via Cloud Inference)
  server-side embedding generation in the same request — no separate embeddings provider needed. Fails
  soft: without all of `QDRANT_URL` / `QDRANT_API_KEY` / `QDRANT_EMBEDDING_MODEL` / `QDRANT_EMBEDDING_DIM`
  set, or on any request error, calls resolve to `null`/`false` so callers fall back to `LIKE`-based
  search instead of throwing. Model + dimension aren't hardcoded (Qdrant Cloud's free model lineup and
  each model's vector size are only listed per-cluster, in the Cloud Console's Inference tab), so both
  are required env config.

  **Collections are versioned** (`COLLECTION_VERSION`, currently 2 → `research_notes_v2` / `lessons_v2`;
  v1 is the unsuffixed original). v1 stored one unnamed dense vector and an empty payload, which made
  this a rank-only sidecar — nothing to filter on, and dense embeddings alone miss the rare exact terms
  this corpus is full of. v2 stores a named dense vector, a **sparse BM25 vector** queried alongside it
  and fused with RRF, a real payload (`goal_id`, `kind`, `confidence`, `muted`, `created_at`), and the
  payload indexes Qdrant *requires* before it will filter — filtering an unindexed field is a 400, not
  a slow query. Rolling back is one constant; SQLite is the source of truth for every point and
  `syncToQdrant` rebuilds from it (incrementally, off a `qdrantSync` watermark, with a full pass when
  the version changes).

  **Three things about scores are easy to get wrong.** (1) Fused RRF scores are *rank*-derived — the top
  hit is 1.0 whether it's a near-identical duplicate or the least-irrelevant row in the collection — so
  anything asking "how similar is this really?" (the dedup guards) must pass `denseOnly` and get raw
  cosine. (2) `score_threshold` therefore goes on the dense prefetch leg, never the fused output.
  (3) `searchByText` returning `null` means "the search did not happen" and is the LIKE-fallback signal;
  `[]` means "it ran and matched nothing". Conflating them made a genuinely empty semantic result
  silently re-run as a substring match.

  **Payload writes are load-bearing, not metadata.** Muting a lesson filters server-side now, so
  `setLessonMuted` also has to `setPayload` — a mute written only to SQLite would leave the lesson being
  handed to the model forever, which is the exact failure muting exists to prevent. Same for anything
  else that changes a filtered field.
- `tool-output.ts` — reading a field back out of `actions.tool_output`, which has carried **two**
  storage shapes: MCP content blocks (`[{type,text}]`) under the old Agent SDK, and a plain
  double-encoded string since `agent-loop.ts` replaced it. Both are still in the DB, so anything
  extracting a URL has to handle both — the Actions page's result links were empty for every
  post-SDK action because the extractor only knew the first shape. New readers of tool output go
  through `parseToolResult` rather than parsing the column themselves.
- `proposal-similarity.ts` — the duplicate check behind `proposal_create`. The agent kept
  re-proposing ideas it already had pending, in three flavours: same idea under a new product
  name (`PropertyManagerCompare` / `PropertyManagementSoftware.review` / "Property management
  software comparison site" — two of them pending *simultaneously*), and same idea under a
  different `domain` string, which is why the check is **not** scoped per-domain. Two layers now
  stop it: `openProposalDigest()` in `orchestrator.ts` puts the open queue in the research
  prompt (research previously had no way to see it at all: `proposal_status` needs an id the model
  can't know), and
  this module refuses the create outright when the new text is too close to an open one.
  Lexical, not semantic, on purpose: it's a pure function over two strings, so it needs no
  API key or Qdrant call on the create path, is unit-tested against the real history, and can
  tell the model *which terms* collided. The tokenizer splits CamelCase and stems, so
  `PropertyManagerCompare` and "property management … comparison" reduce to the same terms.
  `DUPLICATE_THRESHOLD` (0.32) sits in a measured gap — every duplicate pair in the history
  scores ≥0.36, the closest legitimately-distinct pair (two real follow-ups on one shipped
  repo) scores 0.25; the comment there carries the full table. **If you retune it, re-measure
  against the real DB rather than nudging the constant**, and keep the mcp-lint follow-up pair
  under it — encouraging next-step proposals is the point, and blocking those would be worse
  than the duplicates. Only **pending/approved** proposals are checked against, never rejected
  ones: a rejection usually asks for a fix, and the improved retry necessarily resembles what
  it improves on.

  **The same carve-out covers an approved idea whose deep dive didn't finish**
  (`store.listDuplicateCandidates`, filtering on `act_status`). It dates from build mode, where a
  proposal to complete unbuilt work was by construction near-identical to the work: #27's
  refinement was refused twice (43%, then 32% overlap) and got through only by sounding different
  rather than being different, the opposite of what this check should select for. A sharper
  re-pitch of an idea whose investigation stalled is in the same position. `interrupted` and
  `incomplete` are excluded; `running` is **not**, because research runs concurrently with deep
  dives and an idea being investigated right now is exactly one a new idea must not duplicate.
- `deep-dive.ts`: `verifyDeepDive` and `deepDiveNudge`. Pure functions over the phase's tool calls,
  so no store and no API key. Complete means one `report_submit` the tool *accepted*; a refused call
  (`isError`) doesn't count. Zero tool calls, truncation and exhausted turns are reported
  separately, because they call for different responses. It replaced `act-verification.ts`, which
  checked each approved step's declared tool against the calls that ran; a deep dive has no step
  list to check.

  The verdict persists to `proposals.act_status` / `act_problems` (`ActStatus`: `running` →
  `interrupted` | `complete` | `incomplete`; the column names are inherited from build mode). **Stored
  rather than derived from `actions`**, for two reasons: the verdict depends on the model's finish
  reason, which no table records, and the state that matters most (a deep dive the process died
  inside) is exactly the one with no completion row to derive from. `markActStarted` writes
  `running` *before* the model is called, and `report_submit` reads it to accept a report only for
  that idea. `reapInterruptedDeepDives()` turns leftover `running` rows into `interrupted` at
  startup, which is sound because deep dives only ever run in the orchestrator process.

  **It no longer deschedules.** In build mode an interrupted act phase kept its `next_run_at` and
  re-ran from the top on restart, repeating real commits and deploys, so startup descheduled it and
  waited for the operator. A deep dive has no side effects, so a hard-killed one simply resumes on the
  first scheduler tick. A graceful shutdown still reaches `drainQueue`'s `finally` and clears
  `next_run_at`, leaving it under "Unfinished deep dives". The one-time migration that added
  `market_json` also nulled `next_run_at` on every approved legacy proposal, so nothing from build
  mode wakes up as a deep dive; `POST /api/proposals/:id/rerun` brings any of them back deliberately.
- `landscape.ts`: `buildLandscape`, a goal's market landscape derived on read from its notes
  (`listResearchNotesForGoal`), ideas (`listProposalsForGoal`) and latest reports. Notes are grouped by
  `effectiveKind` (the same `%saturat%` legacy bridge `listSaturatedNotes` uses) in a fixed order:
  open ground first, dead ends last. Competitors named across the ideas' market blocks are merged by
  name, later mentions filling gaps rather than overwriting. Served by `GET /api/goals/:id/landscape`;
  unit-tested in `landscape.test.ts`. Deliberately not an agent-written summary: derived, it can't
  drift from the record it shows.
- `integrations/github.ts` + `integrations-server.ts`: three read-only GitHub tools
  (`github_search_repos`, `github_read_repo`, `github_read_file`), for checking software competitors
  and their traction. Every write function, the Vercel and Netlify clients, their live tests
  (`test:github`, `test:vercel`) and `deliverables.ts` were removed with build mode. Don't add a write
  tool back here; see the invariant at the top of this file.
- `connectors/`: the way to add a research data source. A connector is a JSON manifest
  (`connectors/defs/*.json`) describing a REST API: base URL, auth, and a list of operations with
  typed params. `manifest.ts` is the zod meta-schema, `load.ts` reads and validates the bundled dir
  plus `AGENT_CONNECTORS_DIR` at module load, `tools.ts` turns each operation into an ordinary
  `ToolDefinition`. Shipped: DataForSEO (real Google search volume and CPC), Hacker News (demand
  signals), TED (EU public procurement notices). Stripe, Resend, Plausible, Cloudflare, Bing Webmaster
  and IndexNow were removed with build mode: they either wrote or measured sites the agent had shipped.

  **`risk` must be `"read"`.** The meta-schema accepts nothing else, so a write operation in an
  operator's manifest is a load error (skipped and logged in `CONNECTOR_ERRORS`, like any malformed
  manifest) rather than a registered tool. The method is not what makes an operation a write: TED's
  search only takes its query as a POST body, so `POST` stays legal.

  **Three things it can express that aren't obvious**, each added for exactly one API and then
  reusable. A dotted `as` (`"variables.siteTag"`) nests a JSON body, which lets a flat, model-friendly
  signature drive a GraphQL request. `bodyStyle: "array"` sends `[{...}]`, which DataForSEO's live
  endpoints require. And `resultList` projects a list response down to declared fields: **not
  cosmetic**, because results are rendered into the transcript against a hard character cap, so an
  unprojected listing spends that cap on metadata and truncates away the part worth asking for. It
  returns `count` (before the cap) alongside `items`. A 200 carrying a non-empty `errors` array is an
  in-band error, because that is how GraphQL reports failure. The generic features no bundled
  manifest uses are tested against `src/connectors/test-fixtures/`.

  **What it can't express**: OAuth token round trips. **Reddit's keyless `.json` endpoints answer
  403 to every request**, so a Reddit connector needs app credentials and a token exchange and was
  dropped rather than shipped broken. Check an API actually answers before writing a manifest for it.
  Manifests are operator-authored files at the same trust level as `.env`; the agent never writes one.

  **Credentials are read at call time, never captured at module load.** That's what lets a key filled
  in while the loop runs work on the next call rather than the next restart. Connector tools are
  **registered whether or not their key is set** (an unconfigured one answers `Error: DATAFORSEO_AUTH
  is not set` in band); what a missing key changes is which tools each phase's *grant* includes,
  recomputed per cycle by `configuredConnectorTools()`. `load.test.ts` / `tools.test.ts` cover
  manifest validation and request building; a broken *bundled* manifest fails `npm run smoke-test` via
  `CONNECTOR_ERRORS`.
- `tool-catalog.ts`: the one place that knows which tools exist and what each can touch
  (`toolRisk` → `read` / `memory` / `unknown`). `READONLY_INTEGRATION_TOOLS` merges the GitHub reads
  with every connector read, configured or not; `MEMORY_TOOLS`, `RESEARCH_OUTPUT_TOOLS` and
  `DEEP_DIVE_OUTPUT_TOOLS` are the agent's own-database writes. `ALL_CATALOG_TOOLS` is what the smoke
  test checks the registry against. There is no write list any more: `unknown` is what the names of
  retired build-mode tools classify as when they turn up in old `actions` rows.
- `agent-control.ts` — runtime knobs (pause, run-now, abort, domains, interval, directive) plus the
  execution snapshot the console reads. Same in-process bus shape as `review-gateway.ts`. (The
  build-mode `reactive-triggers.ts`, a research pass fired by marking a deliverable "needs
  refinement", went with the deliverables; re-running a deep dive covers the research-mode case.)
- `settings.ts` — operator settings that used to need a `.env` edit and a restart: the pending-idea
  cap, the search mode, and the provider/model for each phase (the deep dive's is `actModel`, labeled
  "Deep-dive model"). Same shape as `agent-control.ts` on
  purpose — in-memory state plus an injected `persist`, importing nothing from `MemoryStore` — and
  stored in `control_settings` under a `setting:` prefix, so console-only mode can write them through
  the same narrow `ControlSettingsWriter` rather than being handed the store.

  **The rule the whole thing rests on: read at use, not at module load.** A setting captured into a
  module-level const freezes at import time, so it would appear to save and change nothing until a
  restart — worse than not moving it. `llm/index.ts` and `search/index.ts` now call `getSetting()` at
  the point of use and `getSearchConfig()` / `getLlmClients()` cache against a signature of their own
  inputs so they invalidate themselves.

  **Self-invalidation, not a change notification.** `runPhase` used to run on a module-level
  `llmByPhase` that an `onSettingsChanged` listener rebuilt, which meant a model change reached the
  loop only if that one notification arrived — and a missed one has no symptom except the loop
  quietly running a model the console says it isn't. `getLlmClients()` re-derives from the current
  settings instead, so the next phase to start picks the change up whatever happened to the event;
  the listener that remains only logs. **A phase already running keeps its client** — it's read once
  at the top of `runPhase` and reused for the ledger row, so a mid-phase change can't split one
  transcript across two models or misattribute the spend.

  **Three guards on a write, and the third is the one that matters.** Per-field validation against the
  registry; all-or-nothing (a half-applied model change is a configuration nobody asked for); and a
  `verify` callback run against the already-applied state and rolled back if it fails. Only the third
  can catch a provider that is spelled correctly but has no API key — `server.ts` supplies it by
  re-resolving the LLM clients and the search config, scoped to what the patch actually touched, so an
  unrelated misconfiguration can't block an unrelated valid edit. Moving model selection out of startup
  was the risky half of this: startup validation gave an error naming the provider's model list, and
  without `verify` the same mistake made from the console would surface an hour later as a 404.

  **Precedence is stored > env > default, and `source` reports which won.** Once a stored value beats
  `.env`, "I edited .env and nothing happened" is the confusing failure — the same one `AGENT_DOMAINS`
  already had. Every field on the Settings page says where its value came from.

  **Secrets and bootstrap values deliberately did not move.** Provider keys, `GITHUB_TOKEN` and the
  connector keys stay in `.env`: a leaked `agent.db` (or one of the `.bak-*` files beside it) costs you
  the agent's memory and would cost you a live credential otherwise. `AGENT_DB_PATH`, the port,
  the bind host and `AGENT_API_TOKEN` can't move at all — you need the database before you can read
  settings out of it, and the token gates the console that would edit it. Adding a setting is one entry
  in `SETTINGS`; the API, the source reporting and the page are all driven off it.
- `notify.ts` — pushes a message to the operator when an idea starts waiting for review, and
  nothing else. `humanReviewPhase` blocks on a promise until somebody clicks Approve or Reject, so
  this is the only place the loop stops indefinitely: a cycle finishing at 03:00 sat there until the
  next time a browser was opened. Subscribed on the event bus in `orchestrator.ts`, one level above
  anything the model can reach — it is deliberately **not a tool**, since a "message the operator"
  tool would open a channel out of the process that isn't the review flow, and the design rests on
  the review flow being the only one.

  The webhook flavour is **detected from the URL host** (Slack / Discord / ntfy / generic JSON)
  rather than configured, because the URL already says which it is and a second env var that can
  disagree with the first is a support question waiting to happen. `AGENT_NOTIFY_URL` lives in
  `.env` with the provider keys — a Slack or Discord webhook URL is bearer-equivalent — and is read
  per event, so filling it in mid-run works on the next proposal.

  **Only `proposal_pending` is wired, on purpose.** Everything else either needs nothing from the
  operator or is on screen by the time they arrive, and a channel that fires on everything is one
  people mute — which would cost the loop the single signal that actually blocks it. Nothing here
  throws: a webhook that is down costs a log line, never a phase, and `notify.test.ts` covers that
  along with the per-service payload shapes (it needs no network — `buildRequest` is pure and
  `sendNotification` takes an injected `fetch`).
- `shutdown.ts` — `createShutdown`, the Ctrl-C path. Without it Ctrl-C was indistinguishable from
  `kill -9`, and **every `finally` in this process is load-bearing**: `runPhase` writes the run's
  cost to the ledger in one (so a killed research cycle's spend simply vanished), `drainQueue`
  clears `next_run_at` in one, and `deepDivePhase` records its verdict only after the run
  returns. The goal is not to let the work finish (a deep dive can run half an hour) but to
  interrupt it so the unwinding code executes. Research and reflect run under a shared
  `AbortController` for that reason. Order matters and is asserted in the tests: stop the
  scheduler and the server *before* aborting, or the scheduler can start a deep dive into the gap. A second signal exits 130 immediately.

  **Built against injected dependencies** rather than reaching into the orchestrator's module
  state, because the signal itself is untestable here: Node on Windows emulates `SIGINT` as
  unconditional termination, so only a real console Ctrl-C is catchable and no test can fire one.
  `shutdown.test.ts` covers the sequence; the wiring in `orchestrator.ts` is the one line left over.

  **An abort is not a failure, and `aborted.ts` is what lets the unwinding code say so.**
  Interrupting a phase means throwing out of it, which reaches the same `catch` a provider 500
  would — so a clean Ctrl-C printed `[act] proposal #30 failed:` and a stack trace pointing at our
  own `abort()`, one line above `Bye.`. Two shapes have to be recognized, which is why this isn't
  message-sniffing: fetch throws a `DOMException` named `AbortError` when the request is in flight,
  and the loop throws `AbortedError` when it notices `signal.aborted` between calls. The
  **`mainLoop().catch` at the bottom of `orchestrator.ts` is the one that mattered**: an abort
  during research rejected all the way out to it, and it called `process.exit(1)` — racing the
  shutdown sequence to the exit and winning, so the "clean" path exited 1 with the database closed
  by process teardown. A floating rejection anywhere else takes the process down mid-shutdown the
  same way, so anything that runs a phase off the main path has to be `.catch`ed, not `void`ed.
- `events.ts` / `review-gateway.ts` / `server.ts` — the live layer under the web UI. `events.ts` is an
  in-process bus the orchestrator emits to; `server.ts` persists each event via `store.logEvent()` *then*
  rebroadcasts it over WebSocket with the same `{id, occurredAt}` the DB assigned, and serves the REST API
  (ideas, reports, actions, event history, and `GET /api/goals/:id/landscape`), and in production also
  serves the built `web/dist` static files; `review-gateway.ts` resolves an idea's pending approval
  promise when a decision comes in via the API. The build-mode routes (`/api/tools`,
  `/api/proposals/:id/scope`, `/api/proposals/:id/review`, `/api/deliverables`) are gone; every new
  report route is a GET, so console-only mode needed no allowlist change.
- `mcp-server.ts` + `mcp/` — an MCP server (stdio) giving Claude Desktop nine read-only tools
  over the agent's record. `mcp-server.ts` is wiring only; the tools live one subject per module
  in `mcp/`: `goals_list` (goals.ts, goal + health merged as `GET /api/goals` does),
  `research_notes_search`/`_list` (notes.ts), `lessons_search`/`_list` (lessons.ts),
  `proposals_list`/`proposal_get` (proposals.ts, names kept for clients already configured),
  `reports_list`/`report_get` (reports.ts; `deliverables_list` was removed with build mode). It opens
  `data/agent.db` with `new MemoryStore(path, { readOnly: true })` rather than going through
  `server.ts`'s REST API, so it needs no port, no `AGENT_API_TOKEN` and no running loop.

  **There is deliberately no write tool** — not adding, not editing, not muting, not approving an
  idea, not accepting a suggested goal: curating this record is a human act performed in the
  console, and a second, unaudited path into what the loop reasons from is exactly what muting
  exists to prevent. For the same reason `lessons_list` filters muted rows itself, since the
  `listAllLessons` it calls is the console's *curation* listing and deliberately includes them.

  **There is also no live status or queue tool**, and that's the same call as excluding run-now
  from console-only mode: `/api/queue`'s `running`/`queued` come from `getControlState()`, which
  is process-local memory in `agent-control.ts` and would read as uninitialised defaults here. A
  tool answering "nothing running" mid-deep-dive is worse than no tool. The DB-derivable half is
  `proposals_list` with `status: "stalled"`, which calls `store.listStalledBuilds()` rather than
  re-deriving it: its `act_status IS NULL` rule is load-bearing (see the Deep-dive queue note).

  Reuse over reimplementation is the rule throughout: `reports_list` is `store.listReports`, and
  `proposal_get` renders `parseMarket`/`parseMonetization`/`parseSteps` and the latest report
  rather than parsing those columns itself.
  `mcp/render.ts` is the pure half — rows in, Markdown out, **no store import**, which is what
  lets `mcp/render.test.ts` cover it with no DB file and no API key. Two rules run through the
  renderers: a column that is null on legacy rows renders *nothing* rather than a dash (most of
  them were added to a live DB and never backfilled, so absent is the common case), and the
  verdict is printed before the reasoning behind it (a report opens with pursue/maybe/drop, an
  idea's detail with its latest report and whether its deep dive finished).

  **Three things here are ordering or environment traps, not style.** (1) `mcp-env.ts` is a
  separate module *because* `qdrant.ts` reads `QDRANT_*` into module-level consts at load time
  and ESM evaluates imports before the importing file's first statement — a `loadEnv()` call in
  a server file's body runs too late, and the symptom is not an error but every search silently
  degrading to `LIKE`. `mcp/store.ts` is what makes that structural rather than a property of one
  file's import order: it imports `../mcp-env.js` above `../memory-server.js` and owns the single
  store handle, so whichever tool module gets evaluated first reaches the store through it.
  (2) On a stdio transport **stdout is the protocol channel**, so `mcp-env.ts` repoints
  `console.log`/`info`/`debug`/`warn` at stderr. It lives *there* rather than at the top of
  `mcp-server.ts` because a statement in a file's body runs after every import has already been
  evaluated — it cannot cover what a module says on the way in, and the graph now reaches
  `connectors/load.ts`, which logs while loading. (3) A desktop client launches the server with
  an arbitrary cwd, so both `.env` and the `AGENT_DB_PATH` default resolve against the repo root
  via `import.meta.url`, never against cwd.
- `smoke-test.ts` — exercises `MemoryStore` directly against a throwaway DB, no API key needed.

### Frontend (`web/`)

React + TypeScript + Ant Design, linted with oxlint, talking to `src/server.ts` over REST
(`web/src/api.ts`) and WebSocket (`web/src/useAgentSocket.ts`). Pages live in `web/src/pages/`: Dashboard
(pending ideas, verdict and spend tiles, recent activity), Live feed (full filterable activity
stream), **Deep-dive queue** (`/queue`, `GET /api/queue`), **Ideas** (path `/proposals`: full
history with research score and report verdict, bulk approve/reject, click a row for
`ProposalDialog`), **Reports** (`/reports`), Actions (every tool call on an *approved* idea, with what
it came to; click a row for full input/output JSON via `ActionDialog`), Economics (spend over time,
by phase, by provider/model, per-domain scoreboard; the revenue figures there are legacy build-mode
outcomes), Lessons, Research notes, **Goals** (with each goal's market landscape), Agent control
(which also lists the connectors and which are still missing a key), **Settings**. `/builds` and
`/deliverables` redirect to `/queue` and `/reports` so old bookmarks land.

User-facing text says **"idea"**; code, routes, API paths and table names keep "proposal". Renaming
those would break bookmarks, MCP clients and persisted names for no behavioural gain.

**Settings is driven entirely off the registry** in `src/settings.ts` — label, help, type, range,
options and the source of each value all come from the server, so adding a setting there needs no
change in `SettingsPage.tsx`. It shows which providers actually have a key in `.env` (they never moved
to the database), tags every field with where its value came from, and saves the *diff* rather than
every field, because the server applies a patch atomically and sending everything would let one
unrelated invalid value block an unrelated valid edit.

**Goals is where the agent gets pointed**, and it replaced the newline-delimited textarea that used to
live on Agent control (that card is now a link). Title and brief are separate fields, since the old one
was both a lane's name and its research brief. The page carries three things the textarea couldn't: a
**Suggested** section for `goal_suggest` rows with Accept / Edit-and-accept / Dismiss; **goal health**
per lane (ideas, approved, deep dives, spend, and empty cycles), which was previously invisible — a
goal that had gone quiet looked exactly like one nobody had gotten to yet; and a **Retired** section,
kept rather than deleted so the work stays attributed and the agent is refused if it re-suggests the
lane. `/goals/:id` opens a dialog with two tabs: **Market landscape** (`GoalLandscape.tsx`, the
default for active and paused goals: ideas with research score and verdict, competitors merged
across ideas, notes grouped by kind) and **Edit** (`?tab=edit`, the default for suggested and retired
goals, which have nothing researched to show). A new goal is editor-only.

**Deep-dive queue** (`DeepDiveQueuePage.tsx`; it was the Build queue, and its types are still named
`BuildQueue` / `QueuedBuild`) answers what the agent is investigating, in what order, and how long it
takes. Four sections: the **running** deep dive (elapsed clock, model, abort, and a log that is the
existing activity feed narrowed to that `proposalId`, not a second stream), **up next**, **scheduled
later**, and **unfinished deep dives** with a Retry button.

Three things it must keep getting right. Ordering comes from `compareByPriorityThenDue`, the
same function `pickNext` pops with — a queue that lists a different order than the worker takes
invites planning around a sequence that won't happen. The duration figure is always **median +
range + sample size**, never a bare number: real `act`-phase runs in the ledger span 8 to 32
minutes, so one confident estimate would be wrong nearly always and believed anyway; it's scoped to
the pinned deep-dive model, falling back to all models when that one has no history (exactly the
situation right after a model switch). And it **polls on a 5s timer as well as on
`historyVersion`**, because the worker picking work up emits no event and a stale queue view is the
one thing this page must not be.

**`listStalledBuilds` is where the subtlety lives.** `act_status IS NULL` does *not* mean
unfinished — it means no verdict on record, which is true of every act phase that ran before the
column existed (eight rows in the live DB, several of which shipped a repo and a live site).
Those are history, not unfinished deep dives, so the null case counts as stalled only when the
proposal has no act-phase actions at all.

**Reports are where the work ends.** `ReportsPage` lists them (verdict filter, list rows without
bodies) and `ReportDialog` fetches the full report by id at `/reports/:id`; `ReportView` renders one
report the same way there and inside `ProposalDialog`, which shows the newest report first and links
the earlier ones. `report_submitted` is in `HISTORY_CHANGING_EVENTS` and fires a browser notification.

**Where the market and money questions get answered.** `MarketBlock.tsx` renders an idea's market
assessment (demand evidence as links, competitors, size, risks, score) and `MonetizationBlock.tsx` its
revenue model, monetization block and launch outline; `web/src/monetization.ts` holds the parsers
and labels, `web/src/report.ts` the verdict and score tags (split out so the component files export
only components, oxlint's fast-refresh rule). The dialog gets the full blocks, and
`ProposalReviewCard` gets compact one-line summaries of each, because the Dashboard card is where the
decision actually happens. A legacy proposal with null columns renders nothing for those blocks;
its old tool fence and recorded outcome show as plain history text.

**`MarkdownLite` is a deliberate subset**: `**bold**`, `` `code` ``, http(s) links (`[text](url)` and
bare URLs, via `Typography.Link`), `#`/`##`/`###` headings, and bullet or numbered lists. That is what
the agent's prompts ask for; reports were the reason headings and links were added. The parser lives
in `web/src/markdown.ts`, and everything renders as React elements, never HTML, so model-written text
can't inject markup and a `javascript:` link stays literal text. Tables stay literal too, which is
why `report_submit` asks for none.

**No vendor names in the UI.** The loop is provider-neutral and the provider is a config switch, so a
label like "Claude API spend" is wrong the moment someone points `AGENT_PROVIDER` elsewhere — and the
`runs` table outlives the switch, so a lifetime total legitimately spans several providers plus rows
written before `provider`/`model` were recorded at all (those are nullable, and are reported as their
own "unrecorded" bucket rather than credited to whatever is configured now). Spend is "model API
spend", and `GET /api/economics` returns `spendByModel` so the total decomposes into who was actually
paid. `unattributedSpend` is there for the same reason: the domain scoreboard can only see spend
charged to a proposal, and research runs never are, so the page states the remainder instead of
leaving a gap between the column and the headline. Any figure the console derives prints its
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

**Deep links.** Every detail dialog is driven by the URL — `/proposals/:id`, `/reports/:id`,
`/actions/:id`, `/lessons/:id`, `/research/:id`, `/goals/:id` — so rows are bookmarkable and Back
closes the dialog. The nav highlight keys off the first path segment, so `/proposals/12` still selects
Ideas. New detail views should
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
the dev server. Chunks and the whole `dist/` listing are what `npm run web:build` prints.
`build.chunkSizeWarningLimit` is raised to 1200 kB because the antd chunk is ~1 MB and can't be split
further — it's raised just above that, not disabled, so a chunk that grows for a new reason still warns.

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
