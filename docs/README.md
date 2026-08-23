# Documentation

- [Architecture](architecture.md) — the four-phase cycle, how proposals have to
  justify themselves, scheduling and priority, and what every module in `src/`
  is for.
- [Setup and configuration](configuration.md) — install, the `.env` vars,
  running the loop, and the frontend dev workflow.
- [The web console](web-console.md) — every page, and what Settings can change
  without a restart.
- [Semantic search](semantic-search.md) — what Qdrant adds, and what happens
  without it.
- [Reading the record from Claude Desktop](mcp-server.md) — the read-only MCP
  server and how to register it.
- [Running it](operations.md) — multiple lanes, and what to check before
  leaving it unattended.

The root [README](../README.md) is the overview and quickstart. `CLAUDE.md` at
the repo root is the working brief for agents editing this codebase — the *why*
behind the design decisions, kept separate from the *what* documented here.
[TODO.md](../TODO.md) tracks known follow-ups.
