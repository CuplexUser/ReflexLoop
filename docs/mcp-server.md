# Reading the record from Claude Desktop

`npm run mcp` starts an MCP server (`src/mcp-server.ts`) that gives Claude
Desktop — or any MCP client — eight read-only tools over the agent's record:

| Tool | What it answers |
| --- | --- |
| `goals_list` | "What is it pointed at, and is each lane still producing?" |
| `research_notes_search` | "What did it find out about X?" |
| `research_notes_list` | The most recent notes, newest first |
| `lessons_search` | "What has it learned about X?" |
| `lessons_list` | The most recently updated lessons |
| `proposals_list` | "What is waiting on my decision?" — also `stalled` builds |
| `proposal_get` | One proposal in full: fence, money path, steps, verdict |
| `deliverables_list` | "What exists now, and where do I click?" |

They all take a `limit` (default 10, max 100 — `goals_list` shows every goal by
default, since there are only a handful and they're the point). The note and
lesson tools take a `goal`, and the note tools a `kind` (`gap` / `saturated` /
`competitor` / …). `goal` is a goal *title*, matched case-insensitively on a
substring; a name that matches nothing answers with the list of goals that
exist, so a wrong guess teaches you the vocabulary in the same turn.

`goals_list` merges each goal with its health — proposals, approved, shipped,
spend, and the empty cycles since it last produced anything, which is the "is
this lane dead?" number. A `suggested` goal is one the agent proposed and it
says so plainly: it is inert until a human accepts it in the console.

`proposal_get` is where the things a review decision actually turns on live and
which were unreachable before: the act-phase fence (`required_tools`, each
badged write / read / memory), the monetization block the research phase had to
state before it could file the proposal, the ordered steps and who owns each,
whether the approved work finished, and what the proposal cost in model API
spend to produce.

It reads `data/agent.db` directly, opened read-only the same way console-only
mode opens it, so it works whether or not `npm start` is running and needs no
port and no `AGENT_API_TOKEN`.

**There is deliberately no tool that writes** — no adding, editing, muting or
deleting, no approving a proposal, no accepting a suggested goal. Those are
human acts performed in the console, and muted lessons are excluded here exactly
as they are for the agent itself: a lesson taken out of the agent's reasoning
must not come back through a second door. There is also **no live status or
build-queue tool**, because what is running right now lives in the
orchestrator's memory, not in the database — a tool reporting "nothing running"
mid-deploy would be worse than no tool. The half that *is* on record is
`proposals_list` with `status: "stalled"`: approved work whose build stopped and
which nothing will pick up again until someone re-runs it.

Searches use Qdrant when it's [configured](semantic-search.md) and fall back to
`LIKE` otherwise, so a hit carries a `relevance:` score in the first case and
not in the second.

## Registering it with Claude Desktop

In `claude_desktop_config.json` — on Windows
`%APPDATA%\Claude\claude_desktop_config.json`, on macOS
`~/Library/Application Support/Claude/claude_desktop_config.json` — using
absolute paths, since the client launches the server with an arbitrary working
directory:

```json
{
  "mcpServers": {
    "reflexloop-memory": {
      "command": "D:\\Code\\Claude\\ReflexLoop\\node_modules\\.bin\\tsx.cmd",
      "args": ["D:\\Code\\Claude\\ReflexLoop\\src\\mcp-server.ts"]
    }
  }
}
```

Point `command` at the repo's own `tsx`, not at `npx`. The client launches the
server from an arbitrary directory, and `npx tsx` from outside the repo doesn't
find the local copy — it downloads its own into the npx cache, which makes
startup slow and needs the network. On macOS/Linux the same entry is
`node_modules/.bin/tsx` with a `/src/mcp-server.ts` argument.

Nothing else needs configuring: the server finds `.env` and `data/agent.db`
relative to its own location, not to wherever it was launched from. Restart
Claude Desktop after editing the file — it spawns the server at startup and
kills it on exit, so config changes only take effect on a full restart.
