# The web console

The console is built with React, TypeScript and Ant Design. It talks to `src/server.ts` over REST
and WebSocket. Its tables can be resized, sorted, filtered and searched, and every detail view has
its own URL, so you can bookmark it.

## Pages

| Page | What you can do there |
| --- | --- |
| **Dashboard** | See pending proposals, spend and revenue totals, and recent activity |
| **Live feed** | Follow every tool call and model message as it happens, filtered by phase |
| **Proposals** | Browse the full history and open any proposal to review it |
| **Deliverables** | Find what the agent built, with direct links |
| **Build queue** | See what is running now, what is next, and what has stalled |
| **Actions** | Inspect every tool call made for approved proposals |
| **Economics** | Track spending over time and by phase, model and goal |
| **Lessons** and **Research notes** | Browse and curate the agent's memory |
| **Goals** | Decide what the agent researches |
| **Agent control** | Pause, run a cycle now, abort, or give a one-time research directive |
| **Settings** | Change models, search and limits without a restart |

### Proposals

Opening a proposal shows its full description, the monetization details (who pays, the price,
the path to the first payment, the key assumption and how to validate it), the ordered steps with
human-only steps marked, and its tool calls. Pending proposals have Approve and Reject buttons,
along with priority and scheduling fields.

### Deliverables

One card per approved proposal that produced something you can open: a repository, a live
deployment, a pull request or a Stripe payment link. A build that did not finish is clearly
marked, and you can re-run it from the card.

### Build queue

Shows the running build with a timer and its own activity log, followed by the work that is up
next, work scheduled for later, and stalled builds. The time estimate is shown as a median and a
range, because real builds vary widely.

### Actions

Grouped by proposal. Each group shows the tool calls from its act and reflect phases, expected
versus actual cost and time, and a review control. Marking something as **needs refinement**
starts a [focused research pass](architecture.md#reactive-refinement). Click any row to see the
full input and output.

### Goals

Each goal has a short title and a longer brief with detailed instructions. The page also shows:

- **Suggested** goals from the agent, which you can accept, edit and accept, or dismiss
- **Health** for each goal: proposals, approvals, shipped work, spend, and empty cycles
- **Retired** goals, kept so past work stays attributed and the agent cannot bring them back

### Agent control

Besides pause, run now and abort, this page lists the connectors and shows which ones are still
missing a key.

## Settings

The Settings page covers what used to need a `.env` edit and a restart: the pending proposal
limit, the search mode, and the provider and model for each phase. Changes apply from the next
phase. A phase that is already running finishes on the model it started with.

Each field shows where its value comes from: the database, `.env`, or a built-in default. This
matters because a saved value takes precedence over `.env`.

Saves are all or nothing, and they are checked before they are applied. If you choose a provider
or search mode whose API key is missing from `.env`, the save is refused right away with a clear
message.

**API keys and secrets stay in `.env`.** This includes provider keys, `GITHUB_TOKEN` and the
connector keys. If the database file ever leaked, you would lose the agent's memory but not a live
Stripe key. The database path, port, bind address and `AGENT_API_TOKEN` also stay in `.env`,
because they are needed before the database can be read.

## How approval reaches the loop

Clicking Approve or Reject calls `POST /api/proposals/:id/decision`. That resolves the waiting
proposal in `review-gateway.ts` directly, with no polling and no files involved.
