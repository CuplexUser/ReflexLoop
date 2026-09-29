# agent-runner

An autonomous agent that looks for ways to make money, proposes concrete plans, and acts on
them only after you approve. It keeps a persistent memory of what it has tried and learned, and
it comes with a web console where you can watch it work and make the decisions.

## How it works

Each cycle has four steps:

1. **Research and plan.** The agent researches the goals you gave it and files proposals.
2. **Review.** You approve or reject each proposal in the web console.
3. **Act.** The agent carries out an approved proposal, using only the tools that proposal named.
4. **Reflect.** It records the real outcome and writes down a lesson for next time.

## Design principles

**No proposal, no action.** Nothing with a real-world effect runs unless a person has approved
a proposal for it. The act phase is limited to exactly the tools that proposal asked for. Please
don't add anything that approves proposals automatically, since every other safeguard depends
on this one.

**Every proposal explains how it makes money.** A proposal must name a revenue model, who pays,
the price, how the first payment actually gets collected, and an ordered list of steps to get
there. You decide on a plan, not on a headline number.

**Bring your own model.** The agent calls model APIs directly over HTTP, with no vendor SDK.
Supported providers are OpenRouter, OpenAI, Anthropic, xAI (Grok) and Moonshot (Kimi). Each
phase can use a different model, for example a cheap one for research and your strongest one
for writing code.

**No sub-agents.** Nothing in the tool registry can start another agent.

## Quickstart

```bash
npm install
npm run smoke-test    # checks the database and tool wiring, no API calls
cp .env.example .env  # then set AGENT_PROVIDER, AGENT_MODEL and that provider's key
npm start             # runs the agent loop and the web console together
```

Then open `http://localhost:4001`, or whichever port you set in `AGENT_SERVER_PORT`.

Everything beyond the model key is optional: search keys, GitHub, Vercel and Netlify tokens,
connector keys, and Qdrant. If a key is missing, that feature is simply unavailable. Please read
[Running it safely](docs/operations.md) before you leave the agent running unattended.

## Documentation

| Guide | What it covers |
| --- | --- |
| [Architecture](docs/architecture.md) | The cycle, scheduling, and what each module does |
| [Setup and configuration](docs/configuration.md) | Installing, environment variables, frontend development |
| [The web console](docs/web-console.md) | Each page, and what the Settings page can change |
| [Semantic search](docs/semantic-search.md) | What Qdrant adds, and what happens without it |
| [Claude Desktop access](docs/mcp-server.md) | The read-only MCP server and how to register it |
| [Running it safely](docs/operations.md) | Goals, the tool fence, and a checklist for unattended runs |

`CLAUDE.md` is the working brief for AI agents that edit this codebase. It explains the reasoning
behind the design. `TODO.md` lists known follow-up work.
