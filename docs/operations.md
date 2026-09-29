# Running it safely

## Goals and the proposal queue

Goals are what the agent researches. You manage them on the console's Goals page, where each one
has a short title and an optional brief with detailed instructions. A single research cycle can
work on whichever goals look most promising, rather than rotating through them evenly.

The agent can suggest a new goal when the ones it has keep coming up empty, but a suggestion does
nothing until you accept it.

Several proposals can wait for review at the same time, which is handy if you prefer to review in
batches. Research pauses once `AGENT_MAX_PENDING_PROPOSALS` (default 5) are waiting, so the queue
cannot grow endlessly while you are away.

There is a tradeoff in how many goals you run. Lessons are matched by meaning rather than exact
wording, which helps, but results still build up faster when there are fewer, narrower goals.
More goals give you breadth; fewer give you a clearer signal from each one.

## Checklist before running unattended

### Understand the tool fence

The agent process itself decides which tools each phase may use. The act phase gets exactly the
tools named in the approved proposal, plus tools that cannot change anything outside the process:
memory tools, read-only GitHub, Vercel and Netlify calls, `WebSearch` and `WebFetch`. Those extra
tools let the agent check its own work. They never let it do more.

### You can narrow the fence after approving

Until an approved proposal's act phase starts, **Edit fence** in the proposal dialog lets you
change its tool list. A queued or scheduled proposal that is slightly wrong does not have to be
cancelled. Once the act phase starts, the fence is locked.

### The fence is not the whole story

The fence limits *which* tools run, not how well they are used. So before you approve:

- Read the tool list. A name that is not a real tool grants nothing, but be wary of any tool you
  do not recognize.
- Read the step list.
- Check that the expected cost is realistic.
- Only approve proposals whose worst case you would accept.

### Connector tools have real consequences

- A Stripe key creates real products and charges.
- A Resend key sends email that cannot be recalled.
- A Cloudflare token changes DNS for a real domain.

These tools sit behind the same approval step as everything else. Still, start with tokens that
have the narrowest permissions possible, and use a Stripe test-mode key.

### Protect the console

Set `AGENT_API_TOKEN` before exposing the console to a network. Without it, the API is open and
anyone who can reach the port can approve spending. That is why `AGENT_BIND_HOST` defaults to
`127.0.0.1` and the agent prints a warning at startup. The token is one shared secret for the
whole console, not per-user login.

### Get notified

Set `AGENT_NOTIFY_URL` so you hear about new proposals. Otherwise a cycle that finishes at 3 a.m.
waits until the next time you open the console.

### And above all

**No proposal, no action.** That is still the whole point.
