# agent-runner

An autonomous agent with persistent memory, run outside any chat UI, with a web
console (React + Ant Design) to watch it work, approve or reject what it wants
to do, and set priority/scheduling on approved work. No sub-agents: nothing in
the tool registry can spawn one.

**Bring your own model.** It calls model APIs directly over HTTP — no Claude
Code, no Agent SDK, no vendor SDK. Set `AGENT_PROVIDER` to `openrouter`,
`openai`, `anthropic`, `xai` (Grok) or `moonshot` (Kimi), set that provider's
key, and name a model in `AGENT_MODEL`. Different phases can use different
models: cheap and wide for research, your best model for writing the code.

**No proposal, no action, ever.** Each cycle is **research + plan → your
approval → act → record outcome → reflect into a lesson**. Nothing with
real-world effect runs without a proposal a human explicitly approved, and the
act phase is fenced to exactly the tools that proposal named. Don't wire
anything to auto-approve "to save time" — that deletes the one safeguard the
rest of the design assumes is there.

Every proposal has to state how it makes money: a revenue model, who pays, at
what price, how the *first* dollar is actually collected, and an ordered step
list to get there — so the review decision isn't made on a headline number and
a paragraph of prose.

## Quickstart

```bash
npm install
npm run smoke-test   # sanity-checks the DB and tool wiring, no API calls
cp .env.example .env # then set AGENT_PROVIDER, AGENT_MODEL and that provider's key
npm start            # agent loop + web console, one process
```

Open `http://localhost:4001` (or your `AGENT_SERVER_PORT`) to watch it
research, review proposals as they come in, and browse
history/lessons/research notes.

Everything else — search keys, GitHub/Vercel/Netlify tokens, connector keys,
Qdrant — is optional, and each is simply unavailable rather than a startup
error when its key is missing. Read [Running it](docs/operations.md) before
leaving it unattended.

## Documentation

- [Architecture](docs/architecture.md) — the four-phase cycle, scheduling and
  priority, and what every module in `src/` is for.
- [Setup and configuration](docs/configuration.md) — install, the `.env` vars,
  and the frontend dev workflow.
- [The web console](docs/web-console.md) — every page, and what Settings can
  change without a restart.
- [Semantic search](docs/semantic-search.md) — what Qdrant adds, and what
  happens without it.
- [Reading the record from Claude Desktop](docs/mcp-server.md) — the read-only
  MCP server and how to register it.
- [Running it](docs/operations.md) — multiple lanes, the tool fence, and the
  unattended checklist.

`CLAUDE.md` is the working brief for agents editing this codebase — the *why*
behind these decisions. `TODO.md` has known follow-ups (moving large blobs off
SQLite, switching to npm workspaces).
