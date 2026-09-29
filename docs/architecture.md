# Architecture

This page explains how the agent's loop works and what each part of `src/` is responsible for.

## The cycle

Every cycle runs through the same steps, then starts again:

1. **Research and plan.** The agent researches its active goals and files between zero and three
   proposals. It can work across several goals in one cycle.
2. **Review.** Each proposal waits for your decision in the web console. Several can be pending
   at the same time.
3. **Act.** An approved proposal is carried out, limited to the tools it named.
4. **Outcome and reflection.** The result is recorded, and the agent writes or reinforces a lesson.

The rule behind all of this: **no proposal, no action.** Nothing with a real-world effect happens
without a proposal that a person explicitly approved. Please don't add anything that approves
proposals automatically, because the rest of the design relies on that step.

## Proposals must explain the money

Besides the usual cost, time and upside estimates, every proposal has to state:

- the revenue model
- who specifically pays, and at what price
- how the first payment actually gets collected, and how many days that takes
- the one assumption that would sink the idea
- what you would measure to know it is working
- an ordered list of steps from approval to the first dollar, with the steps only a person can
  do marked as such

The console shows all of this on the review card and in the proposal dialog.

The steps are checked against the tool list when the proposal is created. If a step the agent
is supposed to perform needs a tool the proposal did not ask for, the proposal is refused,
because that step could never run. After approval, the steps are handed to the act phase exactly
as written, so the agent follows the plan you approved instead of inventing a new one.

## Priority and scheduling

When you approve a proposal you can also set:

- a **priority**: low, normal, high or urgent
- an optional **schedule**: run now, run at a later date and time, or repeat on a fixed cadence
  until cancelled

Only one proposal is ever in its act phase at a time, so real-world actions never overlap. The
next one to run is chosen by priority, then by due time. A scheduler checks for due work every
15 seconds by default (`AGENT_SCHEDULER_TICK_MS`). Anything approved to run now starts right away.

## Checking the work

When the act phase finishes, the agent's tool calls are compared with the approved step list. If
a step's tool never ran successfully, the build is marked **incomplete**, the reflection step is
told what went wrong, and the console flags it. The act phase is never retried automatically,
since that could repeat side effects such as a second commit or a second email. You can re-run it
yourself from the Deliverables page or the proposal dialog.

## Reactive refinement

If you mark a shipped deliverable as **needs refinement**, the agent immediately runs a focused
research and planning pass on that one proposal instead of waiting for the next cycle. That pass
can only produce a new proposal for you to review, never an action. Repeated toggling is rate
limited so it cannot run up API costs.

## Notifications

The review step is the one place where the loop waits indefinitely, so there are two ways to be
told when a proposal needs you:

- **Webhook.** Set `AGENT_NOTIFY_URL` to a Slack, Discord or ntfy URL (or any endpoint that
  accepts a JSON POST). A message is sent each time a proposal starts waiting for review.
- **Browser notifications.** Turn these on with the bell icon in the console. They only fire
  while the console tab is open, and browsers require a click to grant permission, so they are
  never requested automatically.

## Module map

### The loop

- **`orchestrator.ts`** runs the main loop and its four phases, plus the priority queue and
  scheduler that decide which approved proposal acts next. Every tool call is logged, and the
  model API cost of every phase is recorded so that spending counts against profit.
- **`agent-loop.ts`** is the agentic loop itself: ask the model, run the tools it requested, feed
  back the results, and repeat. This is also where each phase's tool fence is enforced. A tool
  outside the phase's grant is never shown to the model, and is refused if the model names it.
- **`act-verification.ts`** decides whether an act phase finished the approved plan.
- **`reactive-triggers.ts`** connects the "needs refinement" button to a targeted research pass.
- **`settings.ts`** holds operator settings that live in the database and can be changed from the
  console. `.env` supplies the starting values; a value saved in the console takes precedence.
  Secrets and startup values are deliberately excluded.

### Models and tools

- **`llm/`** contains all provider-specific code. One adapter covers every provider that uses
  OpenAI's `/chat/completions` format (OpenRouter, OpenAI, xAI, Moonshot). A second adapter
  covers Anthropic's Messages API. The pricing table that converts tokens into dollars lives here.
- **`tools/`** is the tool registry (name, description, zod schema and handler) plus `web.ts`,
  which implements `WebSearch` and `WebFetch`.
- **`search/`** puts Tavily, Brave, or the model provider's own search behind `WebSearch`,
  selected with `AGENT_SEARCH_PROVIDER`. Whichever you choose, it appears as the same single tool.

### Memory

- **`memory-server.ts`** is the SQLite memory (`data/agent.db`) and the memory tools the agent
  can call, such as `research_note_add`, `lesson_search`, `proposal_create`, `outcome_record`
  and `action_history_search`. Approving proposals, setting priority, logging actions and
  curating memory are deliberately *not* available to the model. Those stay with the
  orchestrator and with you.
- **`qdrant.ts`** is the Qdrant Cloud client for [semantic search](semantic-search.md). It fails
  quietly: if Qdrant is not configured, search falls back to plain text matching.

### Integrations

- **`integrations/`** and **`integrations-server.ts`** wrap GitHub, Vercel and Netlify.
  - Read-only tools such as `github_read_repo` and `vercel_list_projects` are free for research
    to use.
  - Write tools such as `github_create_repo`, `github_commit_files`, `github_merge_pr`,
    `vercel_deploy` and `netlify_deploy` only work when an approved proposal names them.
  - `github_commit_files` writes many files in a single commit.
  - `vercel_deploy` can deploy straight from a GitHub repository, so a large site can be
    committed over several calls and then deployed once.
  - **`github_create_repo` always creates a private repository.** Making it public is a decision
    you make yourself in GitHub, after looking at what was built.
- **`connectors/`** lets you add a REST API with a JSON file instead of code. Each manifest in
  `src/connectors/defs/` describes the base URL, the authentication and a list of operations,
  and each operation becomes an ordinary tool behind the same fence. Shipped connectors:

  | Connector | Used for |
  | --- | --- |
  | Stripe | Products, prices, payment links, balance and charges |
  | Resend | Sending email |
  | Plausible | Traffic statistics |
  | Cloudflare | Zones, Pages, DNS, and Web Analytics |
  | Bing Webmaster Tools | Search impressions and indexing status |
  | IndexNow | Telling search engines about new URLs |
  | DataForSEO | Real search volume for keywords |
  | Hacker News | Demand signals from HN stories and comments |
  | TED | EU public procurement notices |

  To add your own, drop a file in that directory or point `AGENT_CONNECTORS_DIR` at another
  folder. A connector without a key is still listed. Its tools answer "`<KEY>` is not set", and
  research is not told about them. Adding a key takes effect on the next cycle without a restart.

### The live layer

- **`events.ts`** is an in-process event bus the orchestrator reports to as it works.
- **`server.ts`** saves each event, broadcasts it over WebSocket, and serves the REST API and
  the built console.
- **`review-gateway.ts`** delivers your Approve or Reject click to the proposal waiting for it.
- **`notify.ts`** sends the webhook notification described above.
- **`web/`** is the console itself. See [The web console](web-console.md).

### Outside access

- **`mcp-server.ts`** and **`mcp/`** provide a read-only MCP server over the agent's record. See
  [Claude Desktop access](mcp-server.md).

### Tests

- **`*.test.ts`** files are Vitest unit tests. None of them need an API key.
- **`smoke-test.ts`** is a quick end-to-end check against a throwaway database. Run it first.
