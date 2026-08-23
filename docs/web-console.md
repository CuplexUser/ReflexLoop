# The web console

React + TypeScript + Ant Design, linted with oxlint, talking to `src/server.ts`
over REST + WebSocket. Tables (Proposals, Actions, Lessons, Research notes) are
resizable, sortable, filterable, and searchable.

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
  Setting "needs refinement" triggers the
  [reactive research pass](architecture.md#reactive-refinement). Click a row
  for the full input/output JSON.
- **Deliverables** — one card per approved proposal that produced something
  reachable, with every artifact a real link: repo, live deployment, PR, and
  Stripe payment links.
- **Lessons** / **Research notes** — the accumulated memory, browsable.
- **Agent control** — pause, run-now, abort, a one-shot research directive,
  and a connector list showing which are configured and which are still
  missing a key.

## Settings

The knobs that used to need a `.env` edit and a restart: the pending-proposal
cap, the search mode, and the provider and model each phase runs on (with
per-phase overrides). Changes apply from the next phase; a cycle already in
flight finishes on the model it started with.

Every field says whether its value is coming from the database, `.env`, or a
built-in default — once a saved value beats `.env`, "I edited `.env` and
nothing happened" is otherwise a confusing few minutes. Saves are
all-or-nothing and verified before they commit: switching to a provider whose
key isn't in `.env`, or a search mode whose key is missing, is refused at the
click with the same message startup used to give, rather than failing an hour
later on the next cycle.

**API keys and secrets deliberately stayed in `.env`** — provider keys,
`GITHUB_TOKEN`, the connector keys. A leaked `agent.db` (or one of the `.bak`
files next to it) costs you the agent's memory; it shouldn't also cost you a
live Stripe key. The database path, port, bind host and `AGENT_API_TOKEN` stay
there too, for the plainer reason that you need the database before you can
read settings out of it.

## How approval reaches the loop

Approving or rejecting a proposal calls `POST /api/proposals/:id/decision`,
which resolves that proposal's pending promise in `review-gateway.ts` —
nothing is polled or written to a file.
