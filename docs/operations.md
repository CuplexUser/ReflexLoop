# Running it

## Multiple domains, multiple proposals

`AGENT_DOMAINS` can list more than one lane, and a single research cycle can
propose across whichever domain looks best rather than being forced to
rotate evenly. Several proposals can be pending review at once — useful if
you're triaging in batches — but `AGENT_MAX_PENDING_PROPOSALS` (default 5)
pauses research once the queue is that full, so it can't grow unbounded
while you're away.

The tradeoff: `lesson_search`'s domain matching is semantic rather than
exact, which offsets some of this, but outcomes still accumulate faster
per-domain with fewer, narrower lanes. More lanes means more breadth, slower
signal in any one of them.

## Before running unattended

- **Tool access is enforced by this process, not by a permission setting.**
  Earlier versions of this app ran on the Claude Agent SDK and needed three
  overlapping mechanisms to hold a phase to its tool list — `settingSources: []`
  (so a developer's own accumulated Claude Code allow-rules in
  `~/.claude/settings.json` couldn't leak permissions into the agent),
  `canUseTool`, and a `PreToolUse` hook — because each had a gap the next one
  patched, and `Bash`/`Read` calls were observed slipping through the first two.
  Off the SDK, that whole class of problem is gone: `agent-loop.ts` dispatches
  every tool call itself, so a tool outside the phase's grant is never described
  to the model and there is no other path from this process to a tool handler.
  `actPhase`'s grant is exactly `proposal.required_tools` plus memory and
  read-only tools (the read-only GitHub/Vercel/Netlify calls, `WebSearch` and
  `WebFetch`) — those are always granted because none of them can change
  anything outside the process, so they widen what the act phase can *learn*,
  never what it can *do*.
- **You can still narrow the fence after approving.** Up until an approved
  proposal's act phase actually starts, "Edit fence" in the proposal dialog
  reworks its `required_tools` — so a queued or scheduled proposal you notice
  is slightly wrong doesn't have to be cancelled and re-proposed. The window
  closes the moment it acts.
- **That fence is a hard boundary, not the whole safety story.** It stops
  the agent from touching tools outside what you approved; it doesn't stop
  it from using an approved tool badly. The `required_tools` the *model*
  writes on a proposal is free text — a name that isn't a real tool simply
  never fires — so actually read what's listed before approving, and don't
  approve a proposal requesting a tool you don't recognize. (Tool names you
  add yourself at approval time *are* validated against the catalog.) Keep
  `expectedCost` realistic and don't approve proposals whose downside you
  wouldn't accept.
- **Connector write tools spend real money or reach real people.** A Stripe
  key creates live products and charges; a Resend key sends mail that can't be
  recalled; a Cloudflare token edits DNS for a real domain. They are behind the
  same approval fence as everything else, but the fence only limits *which*
  tools run, not how well. Start with scoped, minimum-permission tokens and a
  Stripe test-mode key, and read a proposal's step list before approving it.
- **Set `AGENT_API_TOKEN` before exposing the console.** With it unset the
  API is open and nothing gates `/api/proposals/:id/decision` — anyone who
  can reach the port can approve spending. That's why `AGENT_BIND_HOST`
  defaults to loopback and startup warns. Set the token before changing the
  bind host; it's one shared secret for the whole console, not per-user auth.
- **No proposal, no action, ever.** Still true, still the point.
