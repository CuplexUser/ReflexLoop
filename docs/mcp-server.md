# Claude Desktop access

`npm run mcp` starts an MCP server (`src/mcp-server.ts`) that gives Claude Desktop, or any other
MCP client, read-only access to the agent's record.

## Tools

| Tool | What it answers |
| --- | --- |
| `goals_list` | What is the agent working on, and is each goal still producing? |
| `research_notes_search` | What did it find out about a topic? |
| `research_notes_list` | The most recent research notes |
| `lessons_search` | What has it learned about a topic? |
| `lessons_list` | The most recently updated lessons |
| `proposals_list` | Which ideas are waiting for my decision, and what did the others come to? |
| `proposal_get` | One idea in full: verdict, market read, money path and launch outline |
| `reports_list` | What did the deep dives conclude? Filter by verdict or goal. |
| `report_get` | One feasibility report in full, with its sources |

### Parameters

- Every tool takes a `limit`, which defaults to 10 with a maximum of 100. `goals_list` shows all
  goals by default, since there are only a few.
- The note and lesson tools accept a `goal`, matched against goal titles without regard to case.
  If nothing matches, the answer lists the goals that do exist.
- The note tools also accept a `kind`, such as `gap`, `saturated` or `competitor`.

### What the answers include

- **`goals_list`** shows each goal's health: ideas, approvals, deep dives, spend, and the
  number of empty cycles since it last produced anything. A goal with the status `suggested` was
  proposed by the agent and has no effect until you accept it in the console.
- **`proposal_get`** shows the latest report's verdict, the market assessment, the monetization
  details, the launch outline, whether the deep dive finished, and how much the idea cost in model
  API spend. Ideas from before the switch to research-only also show their old tool list and
  recorded outcome.
- **`report_get`** takes a report id, or an idea id to get that idea's newest report.
- **Search results** carry a relevance score when [Qdrant](semantic-search.md) is configured. Without
  it, search uses plain text matching and no score is shown.

## Deliberate limits

- **There are no write tools.** You cannot add, edit, mute or delete anything, approve an
  idea, or accept a suggested goal. Those actions belong in the console. Muted lessons are
  also hidden here, just as they are hidden from the agent.
- **There is no live status tool.** What is running right now lives in the agent process's
  memory, not in the database, so this server cannot see it. To find approved ideas whose deep
  dive stopped without a report, use `proposals_list` with `status: "stalled"`.

The server reads `data/agent.db` directly in read-only mode. It works whether or not `npm start`
is running, and needs no port and no `AGENT_API_TOKEN`.

## Registering it with Claude Desktop

Edit `claude_desktop_config.json`:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

Use absolute paths, because Claude Desktop starts the server from an arbitrary folder:

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

On macOS and Linux, use `node_modules/.bin/tsx` as the command and `/src/mcp-server.ts` as the
argument.

Point `command` at the repository's own `tsx` rather than `npx`. Run from outside the repository,
`npx tsx` cannot find the local copy and downloads its own, which is slow and needs a network
connection.

Nothing else needs configuring. The server finds `.env` and `data/agent.db` relative to its own
location. Fully restart Claude Desktop after editing the file, since it only starts MCP servers
when it launches.
