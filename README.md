# agent-runner

Single Claude Code agent with persistent memory, run outside any chat UI via
the Agent SDK. No sub-agents: the `agents` option is never set anywhere in
`orchestrator.ts`, so the model has no Agent/Task tool to spawn one.

## Files

- `src/memory-server.ts` — SQLite-backed memory (`data/agent.db`) plus the
  MCP tools the agent can call: `research_note_add`, `research_note_search`,
  `lesson_search`, `lesson_add`, `lesson_reinforce`, `proposal_create`,
  `proposal_status`, `outcome_record`. Approving proposals, logging actions,
  and marking a run successful are deliberately *not* tools the model has —
  those stay with the orchestrator and with you.
- `src/orchestrator.ts` — the loop: research+plan → your approval →
  execute → record outcome → reflect into a lesson → repeat. Every tool
  call is logged automatically via a `PostToolUse` hook, and every phase's
  Claude API cost is recorded so spend counts against profit.
- `src/smoke-test.ts` — exercises the memory store directly, no API key
  needed. Run this first.

## Setup

```bash
npm install
npm run smoke-test   # sanity-checks the DB and tool wiring, no API calls
npm run typecheck
```

You'll need `ANTHROPIC_API_KEY` set (or be logged in via `claude setup-token`)
for `npm start` to actually run the agent, since that's what drives the real
`query()` calls.

```bash
export AGENT_DOMAIN="print-on-demand niche storefront"   # pick one lane, see note below
export AGENT_CYCLE_INTERVAL_MS=3600000                     # how often it researches a new cycle
npm start
```

It'll research, occasionally print a proposal to the console, and wait on
stdin for `y`/`n`. Approve one to watch the act → outcome → reflect steps run.

## Before running unattended

- **Pick one narrow domain.** The lesson store only becomes useful once
  outcomes in the same domain accumulate — mixing lanes dilutes the signal.
- **Swap the review delivery.** Console + stdin is fine for testing; for
  actually leaving this running, replace `humanReviewPhase` in
  `orchestrator.ts` with a Telegram/email notification and a small webhook
  or poll loop that calls `store.decideProposal()` when you respond. Nothing
  else in the file needs to change.
- **The `canUseTool` gate in `actPhase` is a hard fence, not the whole
  safety story.** It stops the agent from touching tools outside what you
  approved; it doesn't stop it from using an approved tool badly. Keep
  `expectedCost` realistic and don't approve proposals whose downside you
  wouldn't accept.
- **No proposal, no action, ever.** If you skip a review or wire
  `humanReviewPhase` to auto-approve "to save time," you've deleted the one
  safeguard this design is actually built around.
