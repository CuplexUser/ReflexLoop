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

Every other lever the console offers (pause, abort, directives, goals) can only reduce activity or
redirect research; none of them grants the agent anything.

**The same invariant, one level up: no accepted goal, no research.** Goals are what the loop is
pointed at (see Architecture below). The agent can *suggest* one with `goal_suggest` when a lane it
was given keeps coming up empty — but a suggested goal is inert: `status='suggested'` is excluded
from `activeGoals()`, never appears in a prompt, and `resolveGoalId` refuses to file anything under
it. Only a human clicking Accept makes it real. Don't add anything that auto-accepts a suggestion,
for the same reason nothing auto-approves a proposal: it would let the agent choose what it works
on. Retired goals are equally unreachable, so dismissing a suggestion also stops the lane coming
back — that refusal is deliberate, not a bug.

## Commands

```bash
npm install
npm run smoke-test    # sanity-checks the DB + tool wiring directly, no API key needed — run this first
npm run test:github   # opt-in live check of the GitHub write path; needs a real GITHUB_TOKEN, creates throwaway repos
npm test              # vitest run — unit tests over src/**/*.test.ts, no API key needed
npm run typecheck     # tsc --noEmit over src/
npm start             # tsx src/orchestrator.ts — runs the agent loop + web console together (one process, one SQLite connection)
npm run start:console # console-only: serves the real DB read-only, runs no loop, calls no model API
```

**`start:console`** (equivalently `AGENT_CONSOLE_ONLY=1`; the CLI flag exists because `VAR=1 npm start`
doesn't work on Windows) is the harness for working on `web/` and `server.ts`: it opens the real
database **read-only**, starts the API and console against it, and stops there. No research cycle,
no scheduler, no review queue, no model client — every one of those exists to write something, and
this mode writes nothing to the record. It needs no provider key and no `AGENT_MODEL`.

Read-only is enforced twice on purpose: SQLite itself rejects writes (`new MemoryStore(path,
{ readOnly: true })`), and `server.ts` refuses non-GET `/api` requests with a 403 so the UI gets
one clear answer instead of a SQLite error surfacing from somewhere deep. So the console's write
features (approve/reject, muting a lesson, editing scope, review verdicts) can't be exercised in
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
`goal_id` across proposals, lessons, notes and runs, and this writer must not be able to reach those
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
own history — the pairs it must catch and the follow-up pair it must not).
`src/act-verification.test.ts` (whether an act phase finished the approved plan, run against
proposal #27's real step list and real tool calls — the case that motivated the module) and
`src/llm/types.test.ts` (the truncation-vocabulary list, which a new provider can quietly break),
`src/shutdown.test.ts` (the teardown order, the grace period, and the forced second signal), and
`src/agent-loop.test.ts` (the nudge — the exception to the no-loop-tests rule, see that module).
`smoke-test.ts` runs end-to-end against a throwaway `./data/smoke-test.db`, and also builds the real tool
registry and serializes every schema — which is the cheap way to catch a zod shape that can't be converted,
since otherwise it surfaces as a provider 400 on the first live cycle.

`src/integrations/github.test.ts` is the one place the "a mock of a wire format mostly tests the mock"
rule is deliberately set aside, and **it is not sufficient on its own** — `npm run test:github`
(`src/github-live-test.ts`) is the other half. What the unit tests cover is our *branching* across three
states GitHub reports with three different statuses, which is where a real bug lived: a repo with zero
commits rejects the **entire** Git Data API (blobs and trees included, not just the ref lookup) with
`409 Git Repository is empty.`, so `github_create_repo` followed by `github_commit_files` — the normal
shape of a build — could not work at all. `commitFiles` now bootstraps such a repo through the Contents
API (the one write that functions there), then collapses that bootstrap into a single parentless commit
so the history isn't left carrying an artifact of the API. A **404** on the ref is deliberately still an
error rather than a second initial-commit path: treating it as one would report success while leaving an
orphan branch, which is the same "reported fine, nothing there" failure one level subtler.
The live script is what made this correct — the first version of the fix handled the 409 on the ref
lookup and died on the very next call, and the mock agreed with it right up until the real API didn't.
**Re-run `npm run test:github` after touching the write path**; it needs `GITHUB_TOKEN`, and cleanup
needs the `delete_repo` scope (without it the throwaway repos survive and their URLs are printed).

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
is simply unavailable, not a startup error, when its keys are missing. Connector keys
(`STRIPE_API_KEY` / `RESEND_API_KEY` / `PLAUSIBLE_API_KEY` / `CLOUDFLARE_API_TOKEN`, plus
`AGENT_CONNECTORS_DIR`) work the same way, except that they're read per call rather than at startup,
so filling one in takes effect on the next cycle without a restart.

**`AGENT_MODEL` has no default on purpose.** Providers rename and retire models constantly; a model id
baked into the code fails at the first API call with an opaque 404 instead of at startup with a message
naming the provider and its model list. Don't add one.

**`AGENT_MAX_TOKENS` defaults to 32768, and numeric env vars go through `positiveIntEnv`.** Two things
were wrong here at once. `Number(process.env.X ?? default)` does not do what it looks like it does: a
var that is present but empty — which is how `.env.example` ships this one — is `""`, not `undefined`,
so the default never applies and `Number("")` is 0. Every model call shipped `max_tokens: 0`, and it
went unnoticed only because OpenRouter ignores it. Fixing that alone would have been a *regression*:
8192 was the documented default, and the largest successful act-phase commit in this agent's history is
~16k output tokens, so the act phase only ever worked because the cap wasn't being applied. A low value
here doesn't produce a smaller build, it produces one that stops mid-file. **Use `positiveIntEnv` for
any new numeric env var** rather than `Number(... ?? d)`.

## Architecture

### The four-phase loop (`src/orchestrator.ts`)

Each cycle: **research + plan → human review → act → outcome + reflect**.

- **research + plan** (`researchAndPlanPhase`) — gets its whole tool grant up front with no human in the
  loop, since every tool available to it is read-only or writes only to the agent's own memory DB. Can span multiple
  goals per cycle and create 0-3 proposals; not forced to cover them evenly.

  **What it's shown, versus what it can ask for.** Four digests are injected into the prompt before it
  starts: the open proposal queue, the lessons that apply, the ground already found saturated, and — for
  any goal that's gone quiet — an exploration mandate. `openProposalDigest`'s own rationale is why
  ("a duplicate has to be prevented on every cycle, and a tool only helps on the cycles the model
  remembers to call it"), and it applies unchanged to lessons and dead ends: the prompt had always
  *told* research to call `lesson_search` and `research_note_search` first, roughly a third of the notes
  on file were "I checked, it's saturated", and cycles kept re-checking them anyway. The tools are still
  granted — the digests are a floor, not a replacement. Each goal's **brief is passed verbatim**, which
  is where operator instructions ("research in Swedish, check Fortnox/Bokio first") belong; the title is
  only the key, and the prompt tells the model to echo it back exactly when filing anything.

  Proposing **zero** is a legitimate result — the prompt tells it not to force a weak proposal, and a
  goal whose ideas keep getting rejected will eventually stop producing any. That state used to be
  invisible (stdout only), which is indistinguishable from a broken loop, so a cycle that creates
  nothing now emits a `no_proposal` event carrying the model's own stated reason. It also carries the
  phase's tool-call count, because **zero tool calls is a different thing entirely** — the phase never
  researched at all (an empty or failed model response) and the console says so rather than reporting
  it as a considered decision.
- **human review** (`humanReviewPhase`) — emits a `proposal_pending` event and blocks on
  `waitForDecision()` (`review-gateway.ts`), resolved when a person clicks Approve/Reject in the web UI
  (`POST /api/proposals/:id/decision`).

  **A proposal becomes visible when the row is written and decidable only when a resolver exists**,
  and those were far apart: `enqueueForReview` ran only when the whole research phase *returned*, so a
  proposal filed 10 minutes into a 15-minute phase sat in the console answering "No pending decision
  for this proposal" to every Approve click until the phase ended. `reviewSweep()` closes it on the
  scheduler interval (~15s worst case). It's a reconciliation sweep, not a notification on create,
  because "pending row, nothing waiting on it" has several causes — an aborted research phase, a
  reactive pass that threw — and fixing only the create path would leave the rest. `enqueueForReview`
  is idempotent via `hasPendingDecision`, since a proposal now arrives from both directions. Multiple proposals can be under review concurrently, each on its
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

  **The prompt asking for something is not the same as it having happened**, which is what
  `verifyAct` (`act-verification.ts`) exists to close. Act used to be "done" the moment `runAgent`
  returned, and `runAgent` returns whenever the model stops calling tools — so proposal #27 created a
  repo, said "now I'll write the full prototype", returned no tool call, and the loop emitted
  `phase_done`, reflected on a nonexistent outcome, and left an empty repo on the Deliverables page.
  Now the run is checked against the approved plan and an incomplete one emits `act_incomplete`
  (the act-phase counterpart of `no_proposal`), writes an orchestrator-authored failure outcome if the
  agent recorded none, and tells reflect what actually went wrong. It is **not** a retry: re-running
  act would repeat whatever side effects already landed, and side effects happening exactly once
  inside an approved fence is the property the whole design rests on.
- **reflect** (`reflectPhase`) — calls `lesson_search` first; reinforces an existing lesson via
  `lesson_reinforce` if this outcome confirmed/contradicted it, otherwise adds one new generalized lesson.
  Takes act's verdict, so a phase that half-executed is described as the failure it was instead of
  being announced as "has an outcome recorded now" when nothing recorded one.

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
describes this process, not a preference. "Run a cycle now" resolves `sleepUntilNextCycle` early; aborting an act phase fires the
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
  `pricing.ts` turns tokens into dollars; `index.ts` resolves one client per phase from the env, or
  short-circuits to `mock.ts` (the scripted offline dev client — see Commands above).
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
  caller can answer. Twice an act phase read everything it needed, wrote *"Now I'll write the full
  prototype and commit it in one call"*, and returned nothing — proposals #27 and #29, both leaving
  `CuplexUser/machwatch` empty. The callback (see `actPhase`, which builds it from `verifyAct`) returns
  text to push back or null to finish. It goes in as an ordinary user turn **after** the model's own,
  so the whole transcript survives and the model finishes the job rather than a fresh phase
  re-deriving everything. `MAX_NUDGES` is 2: the realistic recovery is two-step (commit, then
  `outcome_record`), and a model that ignores being told twice is stuck. It can't widen the fence — a
  nudge is text — and it names only tools that haven't already run, so it can't cause a repeat.
  `agent-loop.test.ts` is the deliberate exception to "don't unit-test the loop": this is loop logic
  driven through our own `LlmClient` interface, not a mock of anyone's wire format.

  **Tool calls run concurrently only when the whole batch is pure reads** (`canRunConcurrently`, gated
  on `toolRisk`). Research is latency-bound on the network — one run in the ledger took 39 minutes,
  almost all of it WebSearch/WebFetch in series — so this is free wall-clock. The bar is deliberately
  high and `memory` is excluded along with `write`, even though it only touches the agent's own DB:
  several memory tools now check for a near-duplicate before inserting, and two similar calls dispatched
  together would both pass that check before either wrote, letting through exactly the duplicate the
  guard exists to stop. Results are consumed in the model's original call order regardless of which
  finished first, so the transcript, the `actions` table and the activity feed are unchanged —
  concurrency is a latency change, not an ordering one. Act-phase behaviour is untouched.
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
- **Goals** (`goals` table, in `memory-server.ts`) — what the loop is pointed at, and what replaced the
  free-text `domain` string as the thing the operator curates. That string was doing two incompatible
  jobs at once: a stable grouping key *and* a research brief. It could not do both. The model invents
  the domain on every `proposal_create` and nothing validated it, so 20 proposals arrived under **13
  distinct spellings** — "comparison site / affiliate", "affiliate comparison site" and "comparison
  directory affiliate site" are one idea under three keys — which silently broke every exact-match
  lookup built on it: `action_history_search` returned nothing for any configured domain, the scoreboard
  fragmented, and the `searchLessons` LIKE fallback reached zero rows. Meanwhile one configured domain
  was a 400-character paragraph of research instructions, because a newline-delimited textarea was the
  only place to put a brief.

  A goal has `title` (short, stable, the key) and `brief` (the long instructions, kept out of the key),
  plus `status` / `weight` / `origin` / `parent_id` for branches. **Two mechanisms, deliberately
  separate**: `goal_id` is for *attribution* (scoreboard, per-goal health, filters) and is exact;
  *recall* (`lesson_search`, `research_note_search`, `action_history_search`) matches semantically on
  `title + brief`, so it reaches history written under any of the old spellings. That split is why
  nothing had to be backfilled — pre-goals rows keep `goal_id = NULL` and their `domain` text, and are
  still findable. `resolveGoalId` maps the model's free-text `domain` onto a goal at write time, which
  is what makes the wording stop mattering; it is deliberately **strict and title-only** (measured:
  including the long brief made the Swedish goal a magnet that swallowed unrelated labels at 0.75),
  because a misfiled row puts a number on the scoreboard that isn't true, while an unassigned one is
  merely where every legacy row already sits. `action_history_search` matches on `goal_id` **OR** text
  and falls back to unfiltered recent history when a filter comes up empty — answering "[]" while 140
  act-phase actions sit in the table is the most expensive thing that tool can say wrongly.

- `memory-server.ts` — SQLite-backed memory (`data/agent.db`) plus the tools the model can call:
  `research_note_add`, `research_note_search`, `lesson_search`, `lesson_add`, `lesson_reinforce`,
  `proposal_create`, `proposal_status`, `outcome_record`, `action_history_search`, `goal_suggest`.
  `proposal_create` and `goal_suggest` are **not** in `MEMORY_TOOLS` — they're `RESEARCH_OUTPUT_TOOLS`,
  granted only to research, because both write a row a *human* then acts on and neither is something
  act or reflect has business doing. Approving proposals,
  logging actions, marking a run successful, and **curating memory** (editing, muting, or deleting a
  lesson; deleting or merging research notes) are deliberately *not* model-callable tools — those stay
  with the orchestrator and the human. `buildMemoryTools(store)` returns them; `MemoryStore` itself is a
  plain class the orchestrator and `server.ts` call directly for everything the model must not control.

  **Every proposal has to say how it makes money.** `proposal_create` requires a `revenueModel`, a
  `monetization` block (who pays, price point, path to first dollar, days, key assumption, validation
  signal) and an ordered `steps` list, stored as `revenue_model` / `monetization_json` / `steps_json`.
  Before this the only structured money field was `expected_upside` — a bare number — so the
  mechanism, the buyer and the steps lived in prose inside `description`, whose format spec didn't
  even list the money path among its suggested bullets. The review decision is the one irreversible
  human act in the loop and it was being made without the thing it most needs.

  The load-bearing part is **one in-band cross-check**: an `owner: "agent"` step naming a `tool` that
  isn't in `requiredTools` refuses the create, naming the step and the tool. The act phase is fenced
  to exactly `requiredTools`, so such a step cannot run — and which of the two is wrong isn't
  guessable from inside the tool, so it goes back to the model rather than being silently reconciled.
  That check is what keeps "the steps needed" and "what the fence permits" one statement instead of
  two unrelated pieces of prose. `actPhase` then passes the approved steps through verbatim
  (`approvedPlanBrief`), human-owned ones included and marked as not the agent's to do; until that
  existed, execution re-derived an approach from the description and could diverge from the plan that
  got a yes. All three columns are nullable and **not backfilled** — a pre-existing proposal renders
  no monetization section rather than a row of dashes, same stance as `goal_id`.

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
  exploration query return nothing until months of new notes accumulate. Also owns the
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
  prompt (research+plan previously had no way to see it at all — `action_history_search` only
  covers work that already *ran*, and `proposal_status` needs an id the model can't know), and
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

  **The same carve-out covers an approved proposal whose act phase didn't finish**
  (`store.listDuplicateCandidates`, filtering on `act_status`). A proposal to complete unbuilt
  work is by construction near-identical to the work — there is no wording that describes
  finishing #27 without resembling #27. The refinement pass on #27 hit this for real:
  `proposal_create` was refused twice (43%, then 32% overlap) and landed only on the third
  attempt, once the model had reworded it under the threshold. It got through by sounding
  different rather than being different, which is the opposite of what this check should
  select for. `interrupted` and `incomplete` are excluded; `running` is **not**, because
  research runs concurrently with act and a proposal being built right now is exactly one a
  new proposal must not duplicate.
- `deliverables.ts` — derives "what has this agent actually built" from act-phase actions on approved
  proposals: one record per proposal, carrying its repo / live deployment / PR as typed artifacts.
  Purely derived on read (`GET /api/deliverables`), so it can't disagree with the action log and adds
  no state to maintain. Deterministic on purpose: every artifact comes from a write tool's own
  result (or, for commits, its `owner`/`repo` input), never from scanning outcome notes or model prose
  for things that look like links. `DELIVERABLE_TOOLS` is both the SQL filter in
  `store.listDeliverableActions()` and the switch in `buildDeliverables`, so the two can't drift.
  Connectors don't get a switch case: an operation declaring `deliverable` in its manifest is handled
  by one generic branch, since `result` has already shaped its response into a top-level `url`.
  Unit-tested (`deliverables.test.ts`) — it's pure functions over rows, no API key needed.

  **A card is built from whatever write tool succeeded, which is not the same as a finished
  build** — `github_create_repo` alone makes one, which is how #27 sat here looking shipped with
  an empty repo. Each record now carries `actStatus`, and the page badges `running` /
  `interrupted` / `incomplete` in the error colour ahead of the outcome tag. Carried rather than
  filtered: an abandoned build's repo is still a real thing the operator needs to open, usually
  to clean it up, and hiding the card recreates the original problem from the other side.

  **Dispatching a build by hand** is `POST /api/proposals/:id/rerun`, offered from two places:
  the Deliverables card (which *is* the empty repo — finding out a build stopped and restarting
  it shouldn't be two screens) and `ProposalDialog`, which covers a proposal that produced no
  artifact and so has no card. Both read `web/src/actStatus.ts` so they agree on what
  "unfinished" means. It only re-triggers already-approved work, refuses while `act_status` is
  `running`, and emits `proposal_scheduled` so the console reflects it — a button that works
  while the page looks unchanged reads as a button that doesn't work.

  **Offer the button on `act_status !== 'running'`, never on "the badge says it failed."**
  `act_status` is null for every act phase that ran before the column existed (#15, #16, #17, #27
  in the live DB), and gating on the badge made re-running exactly the oldest stuck builds
  impossible — #27, the empty machwatch repo this whole thread started from, had no button. The
  null resolves itself the first time a proposal runs again; the button must not depend on it.
- `act-verification.ts` — `verifyAct`: did the act phase do what the human approved? Pure functions
  over the phase's tool calls plus the proposal's `steps_json`, in the same style as
  `deliverables.ts`, so no store and no API key.

  **It checks each agent-owned step's declared `tool`, not its `doneWhen` prose**, and that choice is
  the module. `doneWhen` is free text a model wrote — proposal #27's happened to be machine-checkable
  ("index.html + README.md + app.js are readable on the default branch") and the next one won't be, and
  a verifier that parses natural language is wrong in both directions. The tool name is exact, it's
  already what `proposal_create` cross-checks against `required_tools` at create time, and it's in
  `actions.tool_name` verbatim — so this is the same invariant one phase later: a step said it needed
  this tool and the fence was widened to allow it, therefore it must have run. A call that came back
  `isError` doesn't count, or a `409 Git Repository is empty` would read as a completed commit.
  Truncation, exhausted turns, a phase with zero tool calls, and a missing `outcome_record` are all
  reported separately, because they call for different responses. `act-verification.test.ts` runs the
  real #27 step list and tool calls through it.

  The verdict persists to `proposals.act_status` / `act_problems` (`ActStatus`:
  `running` → `interrupted` | `complete` | `incomplete`). **Stored rather than derived from
  `actions` the way `deliverables.ts` is**, for two reasons: the verdict depends on the model's
  finish reason, which no table records, and the state that matters most — an act phase the
  process died inside — is exactly the one with no completion row to derive from.
  `markActStarted` writes `running` *before* the model is called, so anything that kills the
  process in between leaves a marker; `reapInterruptedActPhases()` turns those into
  `interrupted` at the next startup, which is sound because act phases only ever run in the
  orchestrator process.

  **`next_run_at` is the resume marker, and it is only cleared in `drainQueue`'s `finally`** —
  which a killed process never reaches. So an interrupted act phase (and a *completed* one whose
  reflect was cut short) used to still read as due, and `schedulerTick()` would re-run act from
  the top on the next start, repeating real side effects: a second `github_commit_files` is a
  second commit, and a connector that sends an email or creates a payment link is not idempotent
  at all. `reapAfterUncleanShutdown` therefore also **deschedules** anything whose act phase had
  already started, and the operator resumes it deliberately via `POST /api/proposals/:id/rerun`
  (→ `store.requeueApprovedProposal`, picked up by the next `schedulerTick`; approved-only, so it
  re-triggers authorized work and grants nothing).

  The condition is exact rather than a heuristic: a **non-recurring** proposal gets `next_run_at`
  from `scheduleApprovedProposal` and has it nulled by `advanceOrClearSchedule`, so
  `act_status IS NOT NULL AND next_run_at IS NOT NULL` has no legitimate state. **Recurring
  proposals are deliberately left alone** — for them a past-due `next_run_at` after a completed
  act is equally the crash case and an occurrence that came due while the process was down, and
  skipping real scheduled work is the worse error.
- `integrations/{github,vercel,netlify}.ts` + `integrations-server.ts` — thin API wrappers and the tools
  that expose them (`buildIntegrationsTools()`). Read-only tools (`github_read_repo`, `vercel_list_projects`, etc.) are free for the research
  phase to call. Write tools (`github_create_repo`, `vercel_deploy`, `netlify_deploy`, etc.) only work in
  `actPhase`, and only when named in the approved proposal's `required_tools`. Each write tool that
  creates/deploys something returns a plain `url` field on success — `memory-server.ts`'s
  `extractResultUrl` pulls that out generically (by field name, not per-tool switching) to back the
  Actions page's browsable result links.
- `connectors/` — the second way to add a tool, and the one to reach for first. A connector is a JSON
  manifest (`connectors/defs/*.json`) describing a REST API: base URL, auth, and a list of operations
  with typed params. `manifest.ts` is the zod meta-schema, `load.ts` reads and validates the bundled
  dir plus `AGENT_CONNECTORS_DIR` at module load, `tools.ts` turns each operation into an ordinary
  `ToolDefinition`. Shipped: Stripe, Resend, Plausible, Cloudflare.

  The point is that adding a connector stopped being a nine-file change — a client module, two
  hand-maintained risk lists, a `deliverables.ts` switch case, a frontend label map — and became one
  file. Each operation declares its own `risk` next to itself, and `tool-catalog.ts` folds those
  declarations into the same lists everything already reads.

  **What it deliberately can't express**: file-upload deploys (Netlify's sha1 digest manifest,
  Vercel's file payload — those stay native TS in `integrations/`, and both kinds of tool look
  identical to the model) and OAuth refresh flows, which is why the distribution category is email
  and webhooks only. Manifests are operator-authored files at the same trust level as `.env`; the
  agent never writes one.

  **Credentials are read at call time, never captured at module load** — the opposite of what
  `integrations/*.ts` do. That's what lets a key filled in while the loop runs work on the next call
  rather than the next restart, and it's the shape to keep if more config moves out of `.env`. For
  the same reason connector tools are **registered whether or not their key is set** (an unconfigured
  one answers `Error: STRIPE_API_KEY is not set` in band, like the native integrations); what a
  missing key changes is which tools the *research prompt and grant* mention, recomputed per cycle by
  `configuredConnectorTools()`. A `deliverable` block on an operation is what puts its result on the
  Deliverables page. `load.test.ts` / `tools.test.ts` cover manifest validation and request building;
  a broken *bundled* manifest fails `npm run smoke-test` via `CONNECTOR_ERRORS`, while a broken one in
  an operator's own dir is skipped and logged rather than taking the console down with it.
- `tool-catalog.ts` — the one place that knows which tools exist and which touch the real world
  (`toolRisk` → write/read/memory). Three consumers used to each carry their own copy of that answer:
  `orchestrator.ts` (listing act-phase write tools in the research prompt), `server.ts` (validating
  operator edits to `required_tools` against `ALL_GRANTABLE_TOOLS` — now to warn on an uncatalogued name,
  not to reject it), and the console (badging risk at
  decision time, via `GET /api/tools`). Read-only integration tools stay defined next to their
  handlers — in `integrations-server.ts` for the hand-written clients, in a manifest for the
  declarative connectors — and this module merges both. The lists carry **every** connector
  operation, configured or not: what a missing credential changes is what research is told about,
  never whether a name is a legitimate thing for a proposal to have asked for. `GET /api/tools`
  reports `configured` per tool so the console can say so at decision time.
- `agent-control.ts` — runtime knobs (pause, run-now, abort, domains, interval, directive) plus the
  execution snapshot the console reads. Same in-process bus shape as `review-gateway.ts` and
  `reactive-triggers.ts`.
- `settings.ts` — operator settings that used to need a `.env` edit and a restart: the pending-proposal
  cap, the search mode, and the provider/model for each phase. Same shape as `agent-control.ts` on
  purpose — in-memory state plus an injected `persist`, importing nothing from `MemoryStore` — and
  stored in `control_settings` under a `setting:` prefix, so console-only mode can write them through
  the same narrow `ControlSettingsWriter` rather than being handed the store.

  **The rule the whole thing rests on: read at use, not at module load.** A setting captured into a
  module-level const freezes at import time, so it would appear to save and change nothing until a
  restart — worse than not moving it. `llm/index.ts` and `search/index.ts` now call `getSetting()` at
  the point of use, `orchestrator.ts` rebuilds its clients on change, and `getSearchConfig()` caches
  against a signature of its own inputs so it invalidates itself.

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
  the agent's memory today and would cost you a live credential otherwise. `AGENT_DB_PATH`, the port,
  the bind host and `AGENT_API_TOKEN` can't move at all — you need the database before you can read
  settings out of it, and the token gates the console that would edit it. Adding a setting is one entry
  in `SETTINGS`; the API, the source reporting and the page are all driven off it.
- `shutdown.ts` — `createShutdown`, the Ctrl-C path. Without it Ctrl-C was indistinguishable from
  `kill -9`, and **every `finally` in this process is load-bearing**: `runPhase` writes the run's
  cost to the ledger in one (so a killed research cycle's spend simply vanished), `drainQueue`
  clears `next_run_at` in one, and `actPhase` records its verdict only after the run returns.
  The goal is not to let the work finish — an act phase can run half an hour — but to interrupt
  it so the unwinding code executes. Research and reflect now run under a shared
  `AbortController` for that reason; they had no signal at all before. Order matters and is
  asserted in the tests: stop the scheduler and the server *before* aborting, or the scheduler
  can start an act phase into the gap. A second signal exits 130 immediately.

  **Built against injected dependencies** rather than reaching into the orchestrator's module
  state, because the signal itself is untestable here: Node on Windows emulates `SIGINT` as
  unconditional termination, so only a real console Ctrl-C is catchable and no test can fire one.
  `shutdown.test.ts` covers the sequence; the wiring in `orchestrator.ts` is the one line left over.
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
Proposals (full history, bulk approve/reject, click a row for `ProposalDialog`), **Deliverables**,
Actions (every tool call
on an *approved* proposal — action type, an input-derived description, and a browsable result URL when
the tool returned one; phase-filterable, click a row for full input/output JSON via `ActionDialog`),
Economics (spend over time, spend by phase, spend by provider/model, per-domain scoreboard with
forecast accuracy), Lessons, Research notes, **Goals**, Agent control (which also lists the
connectors and which of them are still missing a key), **Settings**.

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
per lane (proposals, approved, shipped, spend, and empty cycles), which was previously invisible — a
goal that had gone quiet looked exactly like one nobody had gotten to yet; and a **Retired** section,
kept rather than deleted so the work stays attributed and the agent is refused if it re-suggests the
lane. Deep-linked at `/goals/:id` like every other detail view, and lazy-loaded like every route
except the Dashboard.

**Deliverables vs Actions — two different questions.** Actions answers "what did it do, call by call",
and that's what it should keep doing. Deliverables answers "what exists now, and where do I click to
see it": one card per approved proposal that produced something reachable, with every artifact as a
real anchor on the card face. The links used to be four interactions deep (scroll the wide table →
expand the row → scroll right to a column that's off-screen at the arriving scroll position → open a
dialog), which is indistinguishable from their not being there. If you add a write tool that creates
something browsable, teach `deliverables.ts` about it — otherwise the thing it builds is reachable
only from raw JSON. For a connector that means one `deliverable` block in its manifest, not a code
change.

**Where the money question gets answered.** `MonetizationBlock.tsx` renders a proposal's revenue
model, monetization block and step list; `web/src/monetization.ts` holds the parsers and labels
(split out so the component file exports only components — oxlint's fast-refresh rule). The dialog
gets the full block, and `ProposalReviewCard` gets a deliberately compact two-line summary, because
the Dashboard card is where the decision actually happens and the money path is the part that used to
be missing there entirely. Everything renders from structured fields rather than Markdown, so
`MarkdownLite`'s bold-and-bullets-only limit doesn't apply — and a legacy proposal with null columns
renders nothing at all rather than a row of dashes.

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
