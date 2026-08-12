# TODO

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
