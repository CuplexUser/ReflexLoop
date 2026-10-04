# The web console

The console is built with React, TypeScript and Ant Design. It talks to `src/server.ts` over REST
and WebSocket. Its tables can be resized, sorted, filtered and searched, and every detail view has
its own URL, so you can bookmark it.

## Pages

| Page | What you can do there |
| --- | --- |
| **Dashboard** | Review pending ideas, see verdict counts and spend, and follow recent activity |
| **Live feed** | Follow every tool call and model message as it happens, filtered by phase |
| **Deep-dive queue** | See which idea is being investigated, what is next, and what didn't finish |
| **Ideas** | Browse every idea with its research score and report verdict, and review pending ones |
| **Reports** | Read the feasibility reports, filtered by verdict |
| **Actions** | Inspect every tool call made for approved ideas |
| **Economics** | Track spending over time and by phase, model and goal |
| **Lessons** and **Research notes** | Browse and curate the agent's memory |
| **Goals** | Decide what the agent researches, and see each goal's market landscape |
| **Agent control** | Pause, run a cycle now, abort, or give a one-time research directive |
| **Settings** | Change models, search and limits without a restart |

### Ideas

Opening an idea shows its latest deep-dive report (once there is one), the market assessment
from research (demand evidence with links, competitors, size, risks, viability score), the
monetization details (who pays, the price, the path to the first payment, the key assumption and
how to validate it), the launch outline, and its tool calls.

Pending ideas have Approve and Reject buttons. When approving you can add **focus questions**,
which the deep dive's report has to answer first, and set priority or a schedule. A rejection
reason teaches the agent not to re-propose the idea.

Ideas from before the switch to research-only still render. They show their old tool list and
recorded outcome as history, and have no report until you run a deep dive on one.

### Reports

One row per report, with the verdict (pursue, maybe or drop), the score, the confidence and the
summary. Click a row for the full report and its sources. An idea investigated more than once has
several reports; the idea dialog shows the newest and links the earlier ones.

### Deep-dive queue

Shows the running deep dive with a timer and its own activity log, then the ideas that are up
next, those scheduled for later, and **unfinished deep dives** (approved ideas whose deep dive
ended without a report), each with a Retry button. The time estimate is shown as a median and a
range, because runs vary widely.

### Actions

Grouped by idea. Each group shows the tool calls from its deep dive and reflect phases and what
the work came to: the report verdict, or for older ideas the recorded outcome. Click any row to
see the full input and output.

### Goals

Each goal has a short title and a longer brief with detailed instructions. The page also shows:

- **Suggested** goals from the agent, which you can accept, edit and accept, or dismiss
- **Health** for each goal: ideas, approvals, deep dives, spend, and empty cycles
- **Retired** goals, kept so past work stays attributed and the agent cannot bring them back

Opening a goal shows its **market landscape**:

- the ideas filed under it, with their research score and report verdict
- the competitors those ideas named
- its research notes grouped by kind: gaps, demand, market size, competitors, pricing, risks,
  and ground already found saturated

The Edit tab next to it changes the title, brief and weight.

### Agent control

Besides pause, run now and abort, this page lists the research data sources (connectors) and
shows which ones are still missing a key.

## Settings

The Settings page covers what used to need a `.env` edit and a restart: the pending idea limit,
the search mode, and the provider and model for each phase. Changes apply from the next
phase. A phase that is already running finishes on the model it started with.

Each field shows where its value comes from: the database, `.env`, or a built-in default. This
matters because a saved value takes precedence over `.env`.

Saves are all or nothing, and they are checked before they are applied. If you choose a provider
or search mode whose API key is missing from `.env`, the save is refused right away with a clear
message.

**API keys and secrets stay in `.env`.** This includes provider keys, `GITHUB_TOKEN` and the
connector keys. If the database file ever leaked, you would lose the agent's memory but not a live
credential. The database path, port, bind address and `AGENT_API_TOKEN` also stay in `.env`,
because they are needed before the database can be read.

## How approval reaches the loop

Clicking Approve or Reject calls `POST /api/proposals/:id/decision`. That resolves the waiting
idea in `review-gateway.ts` directly, with no polling and no files involved.
