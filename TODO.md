# TODO

- [ ] Move large blobs/JSON out of SQLite (deferred -- see note below, not worth doing yet)
- [x] Switch to npm workspaces
- [ ] Switch to Qdrant Cloud

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
Current usage limits for Voyage API are low. Which makes the following error message come up frequently.
> Voyage API error 429: {"detail":"You have not yet added your payment method in the billing page and will have reduced rate limits of 3  RPM and 10K TPM. To unlock our standard rate limits, please add a payment method in the billing page for the appropriate organization in the user dashboard (https://www.mongodb.com/docs/voyageai/management/billing/#manage-billing). Even with payment methods entered, the free tokens (200M tokens for Voyage series 3) will still apply. After adding a payment method, you should see your rate limits increase after several minutes.