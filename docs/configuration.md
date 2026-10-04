# Setup and configuration

## Install and check

```bash
npm install
npm run smoke-test   # checks the database and tool wiring, no API calls
npm test             # unit tests (Vitest)
npm run typecheck
```

## Environment variables

Copy `.env.example` to `.env` and fill in what you have. Only the first group is required.

### Required: the model

| Variable | Notes |
| --- | --- |
| `AGENT_PROVIDER` | `openrouter` (default), `openai`, `anthropic`, `xai` or `moonshot` |
| `AGENT_MODEL` | The model to use. There is no default. |
| Provider key | `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY` or `MOONSHOT_API_KEY` |

OpenRouter is the default because one key reaches many model families, and it reports the real
cost of each call, which keeps the Economics page accurate.

`AGENT_MODEL` has no default on purpose. Providers rename and retire models often, and a built-in
default would eventually fail with an unclear error. If it is missing, the startup message links
to your provider's model list.

You can give each phase its own model with `AGENT_RESEARCH_MODEL`, `AGENT_ACT_MODEL` (the deep
dive, which kept its old internal name) and `AGENT_REFLECT_MODEL`, plus matching `_PROVIDER`
variables. The deep dive is the phase where your strongest model pays off.

### Recommended: web search

Set `TAVILY_API_KEY` or `BRAVE_API_KEY`. Both have free tiers. Without either, search falls back
to the model provider's own built-in search, whose quality varies. `WebFetch` needs no key.

### Optional

| Variable | What it enables |
| --- | --- |
| `GITHUB_TOKEN` | Read-only GitHub search, for checking software competitors. No write scope needed. |
| `DATAFORSEO_AUTH` | Real Google search volume for keywords (paid per call) |
| `AGENT_CONNECTORS_DIR` | A folder of extra read-only connector manifests outside the repository |
| `AGENT_NOTIFY_URL` | A webhook message when an idea needs review |
| `AGENT_CONSOLE_URL` | The address notification links point to, if you review from another device |
| `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_EMBEDDING_MODEL`, `QDRANT_EMBEDDING_DIM` | [Semantic search](semantic-search.md). All four are required together. |
| `AGENT_DOMAINS` | The starting goals for a brand new database |
| `AGENT_SCHEDULER_TICK_MS` | How often scheduled work is checked (default 15000) |

A few details worth knowing:

- **Connector keys are read on every call**, not at startup, so adding one takes effect on the
  next cycle without a restart. `GITHUB_TOKEN` needs a restart.
- **Hacker News and TED need no key** and are always available.
- **`AGENT_DOMAINS` only seeds the first run.** After that, goals are managed on the console's
  Goals page, and editing `.env` has no effect.
- **Qdrant** has a free cluster at [cloud.qdrant.io](https://cloud.qdrant.io) that needs no
  credit card. The model name and its dimension are listed on your cluster's Inference tab.

Anything that is not a secret or a startup value can also be changed on the console's Settings
page, and a value saved there takes precedence over `.env`. See
[The web console](web-console.md#settings).

## Running

```bash
npm start
```

This starts the agent loop and the web console in a single process that shares one SQLite
connection. Open `http://localhost:4001`, or the port set in `AGENT_SERVER_PORT`.

To browse the real database without running the agent, use:

```bash
npm run start:console
```

This opens the database read-only and makes no model calls, so it needs no API key. Goals,
settings, the cycle interval and pause can still be changed, since those are what the next
real run reads when it starts.

## Frontend development

For hot reload, run the backend and the Vite dev server side by side:

```bash
npm start          # backend and API on AGENT_SERVER_PORT
npm run web:dev    # Vite dev server, forwards /api and /ws to the backend
```

`npm run web:build` produces the static build that `npm start` serves. `npm run web:lint` runs
oxlint over `web/`.
