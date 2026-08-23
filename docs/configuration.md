# Setup and configuration

## Install and sanity-check

```bash
npm install
npm run smoke-test   # sanity-checks the DB and tool wiring, no API calls
npm test             # unit tests (Vitest)
npm run typecheck
```

## Environment

Copy `.env.example` to `.env` and fill in what you have:

- `AGENT_PROVIDER` + `AGENT_MODEL` + that provider's key — needed for
  `npm start` to run the agent at all. `AGENT_PROVIDER` defaults to
  `openrouter` (one key reaches Claude, GPT, Grok and Kimi, and it reports
  real per-call cost, so the Economics page stays accurate without a pricing
  table). `AGENT_MODEL` is **required and has no default** — model ids change
  too often for a baked-in one to be anything but a future 404; the startup
  error names your provider's model list. Optional per-phase overrides:
  `AGENT_RESEARCH_MODEL`, `AGENT_ACT_MODEL`, `AGENT_REFLECT_MODEL` (and
  `_PROVIDER` variants).
- `TAVILY_API_KEY` or `BRAVE_API_KEY` — optional but recommended. `WebSearch`
  was a Claude Code built-in and is now backed by whichever of these you set
  (both have free tiers). With neither, `AGENT_SEARCH_PROVIDER` falls back to
  `native` — the model provider's own server-side search, which varies in
  quality by provider. `WebFetch` needs no key.
- `AGENT_DOMAINS` — comma-separated lanes research considers each cycle
  (default covers small-business/consumer web tools, a general-audience
  Chrome extension, and a free web calculator/tool — not developer-only).
  See the [tradeoff note](operations.md#multiple-domains-multiple-proposals)
  before adding many.
- `GITHUB_TOKEN` / `VERCEL_TOKEN` / `NETLIFY_AUTH_TOKEN` — optional; omit any
  of them and that integration's tools simply aren't usable.
- `STRIPE_API_KEY` / `RESEND_API_KEY` / `PLAUSIBLE_API_KEY` /
  `CLOUDFLARE_API_TOKEN` — optional connector keys (see `src/connectors/`).
  Unlike the three above, these are read per call rather than at startup, so
  adding one takes effect on the next cycle without a restart. Use a Stripe
  **test-mode** key (`sk_test_…`) until you're sure. `AGENT_CONNECTORS_DIR`
  points at a directory of extra connector manifests, if you'd rather keep
  them outside the repo.
- `QDRANT_URL` + `QDRANT_API_KEY` + `QDRANT_EMBEDDING_MODEL` +
  `QDRANT_EMBEDDING_DIM` (+ `QDRANT_EMBEDDING_DISTANCE`) — optional, but all
  four of the first group are required together; enables
  [semantic search](semantic-search.md). Free cluster at
  [cloud.qdrant.io](https://cloud.qdrant.io), no credit card needed — model
  name and dimension are listed per-cluster in the Cloud Console's Inference
  tab.
- `AGENT_SCHEDULER_TICK_MS` — optional, default 15000; how often the
  scheduler checks for approved proposals whose scheduled/recurring run is
  due.

Anything that isn't a secret or a bootstrap value can also be changed from the
console's Settings page, which then wins over `.env` — see
[The web console](web-console.md#settings).

## Running

```bash
npm start
```

This starts the agent loop *and* the web console together (they share one
process and one SQLite connection — no multi-process file locking). Open
`http://localhost:4001` (or your `AGENT_SERVER_PORT`) to watch it research,
review proposals as they come in, and see history/lessons/research notes.

## Frontend development

For hot reload, run the backend and the Vite dev server side by side:

```bash
npm start           # backend + API on AGENT_SERVER_PORT
npm run web:dev     # Vite dev server, proxies /api and /ws to the backend
```

`npm run web:build` produces the static build `src/server.ts` serves in the
`npm start` flow above; `npm run web:lint` runs oxlint over `web/`.
