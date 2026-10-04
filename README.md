# agent-runner

An autonomous market-research agent. You give it goals, it researches them, and it files business
ideas worth your attention, software or not. When you approve an idea, it investigates it in depth
and writes a feasibility report: market size, competitors, pricing, demand evidence, risks and how
you would launch it. It keeps a persistent memory of what it has found and learned, and it comes
with a web console where you watch it work and make the decisions.

## How it works

Each cycle has four steps:

1. **Research.** The agent researches the goals you gave it, saves findings as research notes, and
   files ideas. Each idea carries a market assessment and a money path.
2. **Review.** You approve or reject each idea in the web console. Approving can include focus
   questions for the next step.
3. **Deep dive.** The agent investigates an approved idea further and submits a written report with
   a verdict: pursue, maybe or drop.
4. **Reflect.** It compares the report with what research first claimed and writes down a lesson.

Each goal also gets a **market landscape** in the console: its ideas and their verdicts, the
competitors they named, and the research notes grouped by kind (gaps, demand, pricing, risks, dead
ends).

## Design principles

**Read-only by construction.** The agent never builds, launches, buys, publishes or contacts
anyone. Every tool it has either reads (the web, public data sources) or writes to its own
database. A connector declaring a write operation is refused when it loads, and the smoke test
fails if any registered tool is anything else.

**No accepted goal, no research. No approval, no deep dive.** The agent may suggest a new goal,
but a suggestion is inert until you accept it. A deep dive is the expensive step, and only your
approval starts one.

**Every idea explains the market and the money.** An idea must cite demand evidence with sources,
name competitors, estimate the market size, list the key risks, and say who pays, how much, and
how the first payment gets collected. You decide on evidence, not on a headline number.

**Bring your own model.** The agent calls model APIs directly over HTTP, with no vendor SDK.
Supported providers are OpenRouter, OpenAI, Anthropic, xAI (Grok) and Moonshot (Kimi). Each
phase can use a different model, for example a cheap one for research and your strongest one for
deep dives.

**No sub-agents.** Nothing in the tool registry can start another agent.

## Quickstart

```bash
npm install
npm run smoke-test    # checks the database and tool wiring, no API calls
cp .env.example .env  # then set AGENT_PROVIDER, AGENT_MODEL and that provider's key
npm start             # runs the agent loop and the web console together
```

Then open `http://localhost:4001`, or whichever port you set in `AGENT_SERVER_PORT`.

Everything beyond the model key is optional: web search keys (Tavily or Brave), a read-only
GitHub token for competitor search, DataForSEO for search volume, and Qdrant for semantic search.
If a key is missing, that feature is simply unavailable. Please read
[Running it](docs/operations.md) before you leave the agent running unattended.

## Documentation

| Guide | What it covers |
| --- | --- |
| [Architecture](docs/architecture.md) | The cycle, scheduling, and what each module does |
| [Setup and configuration](docs/configuration.md) | Installing, environment variables, frontend development |
| [The web console](docs/web-console.md) | Each page, and what the Settings page can change |
| [Semantic search](docs/semantic-search.md) | What Qdrant adds, and what happens without it |
| [Claude Desktop access](docs/mcp-server.md) | The read-only MCP server and how to register it |
| [Running it](docs/operations.md) | Goals, controlling spend, and a checklist for unattended runs |

`CLAUDE.md` is the working brief for AI agents that edit this codebase. It explains the reasoning
behind the design. `TODO.md` lists known follow-up work.
