# Architecture

This page explains how the agent's loop works and what each part of `src/` is responsible for.

## The cycle

Every cycle runs through the same steps, then starts again:

1. **Research.** The agent researches its active goals, saves findings as research notes, and
   files between zero and three ideas. It can work across several goals in one cycle.
2. **Review.** Each idea waits for your decision in the web console. Several can be pending at
   the same time.
3. **Deep dive.** An approved idea gets a longer, read-only investigation that ends with a
   written feasibility report.
4. **Reflect.** The agent compares the report with what research first claimed, and writes or
   reinforces a lesson.

Two rules sit behind this:

- **Nothing the agent can call changes the outside world.** Every tool reads (the web, public
  data sources, public GitHub repos) or writes to the agent's own database.
- **Only you start spending.** Research runs on its schedule, but a deep dive, the most
  expensive phase, only runs on an idea you approved. A rejection teaches the agent a lesson
  instead.

## What an idea has to contain

Besides cost, time and upside estimates, every idea must include:

| Block | What it states |
| --- | --- |
| Market | Market size and how it was derived, demand evidence with source URLs, named competitors with their pricing, key risks, a 1 to 5 viability score and the confidence behind it |
| Monetization | The revenue model, who pays and at what price, how the first payment gets collected and how long that takes, the key assumption, and what to measure |
| Launch outline | The ordered steps a person would follow, cheapest validation test first |

The revenue models include `sponsorship_donations`, `open_core` and `deferred` (build an
audience now, charge later), so free and open-source ideas can state their money path honestly.

## What a deep dive produces

The deep dive gets the idea, its claims as "things to verify", and any focus questions you typed
when you approved it. It must end by calling `report_submit`, which saves:

- a verdict: **pursue**, **maybe** or **drop**
- a 1 to 5 viability score and a confidence level
- a short summary
- a Markdown body with fixed sections: summary, market size, competitors, demand evidence,
  pricing and unit economics, risks, how a human would launch it, and open questions
- the list of sources it relied on

`report_submit` only accepts a report for the idea whose deep dive is running. A deep dive that
stops without a report is pushed back twice. If it still doesn't submit one, it is marked
**incomplete** and shows up under "Unfinished deep dives" so you can retry it.

Running a deep dive again on the same idea files a new report next to the old one. The newest one
counts.

## Priority and scheduling

When you approve an idea you can also set:

- a **priority**: low, normal, high or urgent
- an optional **schedule**: run now, run at a later date and time, or repeat on a fixed cadence
  (useful for re-checking a market periodically) until cancelled

Deep dives run one at a time, which keeps spend and provider rate limits predictable. The next
one is chosen by priority, then by due time. A scheduler checks for due work every 15 seconds by
default (`AGENT_SCHEDULER_TICK_MS`).

If the process is killed during a deep dive, the next start marks it **interrupted**. When it was
still scheduled, it resumes automatically, which is safe because a deep dive has no side effects.

## The market landscape

Each goal has a landscape view in the console, assembled on request from what is already
recorded. Nothing extra is written by the agent:

- the ideas filed under the goal, with their research score and deep-dive verdict
- the competitors those ideas named, merged by name
- the research notes filed under the goal, grouped by kind: gaps, demand, market size,
  competitors, pricing, risks, and ground already found saturated

## Notifications

The review step is the one place where the loop waits indefinitely, so there are two ways to be
told when an idea needs you:

- **Webhook.** Set `AGENT_NOTIFY_URL` to a Slack, Discord or ntfy URL (or any endpoint that
  accepts a JSON POST). A message is sent each time an idea starts waiting for review.
- **Browser notifications.** Turn these on with the bell icon in the console. They fire for new
  ideas and for finished reports, only while the console tab is open.

## Module map

### The loop

- **`orchestrator.ts`** runs the main loop and its four phases, plus the priority queue and
  scheduler that pick which approved idea is investigated next. Every tool call is logged, and
  the model API cost of every phase is recorded.
- **`agent-loop.ts`** is the agentic loop itself: ask the model, run the tools it requested, feed
  back the results, and repeat. It only ever describes and dispatches the tools a phase was
  granted.
- **`deep-dive.ts`** decides whether a deep dive finished (a report was accepted) and writes the
  push-back when it hasn't.
- **`landscape.ts`** builds a goal's market landscape from its notes, ideas and reports.
- **`settings.ts`** holds operator settings that live in the database and can be changed from the
  console. `.env` supplies the starting values; a value saved in the console takes precedence.
  Secrets and startup values are deliberately excluded.

The deep dive keeps the internal phase name `act` (in the run ledger and the `AGENT_ACT_*`
settings), inherited from when the agent built software. The console labels it "Deep dive".

### Models and tools

- **`llm/`** contains all provider-specific code. One adapter covers every provider that uses
  OpenAI's `/chat/completions` format (OpenRouter, OpenAI, xAI, Moonshot). A second adapter
  covers Anthropic's Messages API. The pricing table that converts tokens into dollars lives here.
- **`tools/`** is the tool registry (name, description, zod schema and handler) plus `web.ts`,
  which implements `WebSearch` and `WebFetch`.
- **`search/`** puts Tavily, Brave, or the model provider's own search behind `WebSearch`,
  selected with `AGENT_SEARCH_PROVIDER`. Whichever you choose, it appears as the same single tool.
- **`tool-catalog.ts`** lists every tool and what it can touch (`read` or `memory`).

### Memory

- **`memory-server.ts`** is the SQLite memory (`data/agent.db`) and the tools the agent can call:
  `research_note_add`, `research_note_search`, `lesson_search`, `lesson_add`, `lesson_reinforce`,
  `proposal_status`, plus `proposal_create` and `goal_suggest` (research only) and
  `report_submit` (deep dive only). Approving ideas, setting priority, logging actions and
  curating memory are deliberately *not* available to the model.
- **`qdrant.ts`** is the Qdrant Cloud client for [semantic search](semantic-search.md). It fails
  quietly: if Qdrant is not configured, search falls back to plain text matching.

### Data sources

- **`integrations-server.ts`** exposes three read-only GitHub tools: search public repos, read a
  repo's metadata, and read a file. For a software idea, that is a quick check of who already
  exists and how much traction they have.
- **`connectors/`** lets you add a read-only REST API with a JSON file instead of code. Each
  manifest in `src/connectors/defs/` describes the base URL, the authentication and a list of
  operations, and each operation becomes an ordinary tool. A manifest declaring a write
  operation is refused at load. Shipped connectors:

  | Connector | Used for |
  | --- | --- |
  | DataForSEO | Real Google search volume and CPC for keywords |
  | Hacker News | Demand signals from HN stories and comments |
  | TED | EU public procurement notices |

  To add your own, drop a file in that directory or point `AGENT_CONNECTORS_DIR` at another
  folder. A connector without a key is left out of every phase. Adding a key takes effect on the
  next cycle without a restart.

### The live layer

- **`events.ts`** is an in-process event bus the orchestrator reports to as it works.
- **`server.ts`** saves each event, broadcasts it over WebSocket, and serves the REST API and
  the built console.
- **`review-gateway.ts`** delivers your Approve or Reject click to the idea waiting for it.
- **`notify.ts`** sends the webhook notification described above.
- **`web/`** is the console itself. See [The web console](web-console.md).

### Outside access

- **`mcp-server.ts`** and **`mcp/`** provide a read-only MCP server over the agent's record. See
  [Claude Desktop access](mcp-server.md).

### Tests

- **`*.test.ts`** files are Vitest unit tests. None of them need an API key.
- **`smoke-test.ts`** is a quick end-to-end check against a throwaway database. Run it first. It
  also fails if any registered tool could change something outside the agent's database.
