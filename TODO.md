# TODO

## Tier 0 -- bugs & correctness (in progress)

- [x] Fix table column resize collapsing neighbouring columns
- [x] Re-register pending review decisions on restart -- not a bug, already handled
- [x] Surface run cost in the UI (was dead code)

## Backlog

- [ ] Tier 1 -- table & navigation usability
- [ ] Tier 2 -- approval workflow
- [ ] Tier 3 -- economics & observability
- [ ] Tier 4 -- agent control & memory curation
- [ ] Tier 5 -- hardening & polish
- [ ] Move large blobs/JSON out of SQLite (deferred -- see note below, not worth doing yet)
- [x] Switch to npm workspaces
- [x] Switch to Qdrant Cloud

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

Still open: the list endpoint `/api/runs` / `api.runs()` remains unused. It's the
right backing query for the Tier 3 Runs/Spend page (cost per phase / proposal /
domain over time), so it stays until that lands.

## Tier 1 -- table & navigation usability

- Deep-linkable rows (`/proposals/:id` etc.) -- dialogs currently don't touch the URL,
  so nothing is bookmarkable and the back button doesn't close them.
- Column show/hide, density toggle, sticky header, page-size changer (hardcoded 10/20).
- Global search (`Cmd-K`) across proposals, actions, lessons, notes -- today each page
  has its own isolated client-side substring filter.
- Server-side semantic search: Qdrant is fully wired in the backend but the UI only
  does client-side `.includes()`. Expose `/api/search` over the existing vector search.
- Keyboard nav: `j`/`k` move, `Enter` opens, `Esc` closes, `a`/`r` decide.
- CSV/JSON export per table.

## Tier 2 -- approval workflow

- **Approve with edits**: let the operator trim `required_tools` or tighten the
  description before approving. Today it's take-it-or-leave-it plus a notes field --
  and `required_tools` *is* the security fence, so editing it down is the single
  highest-value control the console could offer.
- Risk surfacing in the review card: badge which requested tools are side-effecting
  (`github_create_repo`, `vercel_deploy`, ...) vs read-only, so the fence is visible
  at decision time.
- Bulk approve/reject, plus a "pending for 4h" age indicator.
- Feed rejection reasons back into `reflectPhase` -- a rejected proposal currently
  teaches the agent nothing, so it can re-propose the same thing next cycle.

## Tier 3 -- economics & observability

- Runs/Spend page off `/api/runs`: cost per phase, per proposal, per domain, over time.
- Real P&L on the dashboard. The tiles show Claude spend and self-reported revenue
  side by side but never net them; spend counts against profit by design, so show
  `revenue - reported cost - API spend` as one number.
- Per-domain scoreboard: success rate, avg cost-to-outcome, and forecast accuracy
  (`expected_upside` vs `actual_revenue` -- both stored, never compared).

## Tier 4 -- agent control & memory curation

- Runtime control: pause/resume the loop, "run a cycle now", abort an in-flight act
  phase, edit domains and cycle interval without an env change + restart.
- Steering: a free-text directive the operator can inject into the next research phase.
- **Lesson curation**: the human can't edit, delete, or mute a lesson today. A wrong
  lesson gets `lesson_search`-ed into every future cycle forever. For a system whose
  premise is learning from outcomes, this is the biggest missing capability outside
  the approval fence itself.
- Dedupe/merge view for near-identical research notes.

## Tier 5 -- hardening & polish

- Auth. `server.ts` binds all interfaces with nothing gating
  `POST /api/proposals/:id/decision` -- anyone on the LAN can approve a side-effecting
  proposal. Shared-token gate, and default the bind to `127.0.0.1`.
- Error boundary, WS reconnect backoff with a visible reconnecting state, light-theme
  toggle, mobile-usable table fallback.

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
and the Semantic search section of `README.md`.