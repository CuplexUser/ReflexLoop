# Running it

## Goals and the review queue

Goals are what the agent researches. You manage them on the console's Goals page, where each one
has a short title and an optional brief with detailed instructions: which markets, which buyers,
which incumbents to check first, which language to search in. A single research cycle can work
on whichever goals look most promising, rather than rotating through them evenly.

The agent can suggest a new goal when the ones it has keep coming up empty, but a suggestion does
nothing until you accept it.

Several ideas can wait for review at the same time, which is handy if you prefer to review in
batches. Research pauses once `AGENT_MAX_PENDING_PROPOSALS` (default 5) are waiting, so the queue
cannot grow endlessly while you are away.

There is a tradeoff in how many goals you run. Fewer, narrower goals build up a clearer market
picture and sharper lessons faster. More goals give you breadth.

## What the agent can and cannot do

It can:

- search and read the web
- query the read-only data sources you have keys for (DataForSEO, Hacker News, TED, GitHub search)
- write research notes, lessons, ideas and reports to its own database
- suggest a new goal, which stays inert until you accept it

It cannot build, deploy, publish, buy, sign up for anything, send email or contact anyone. There
is no tool for any of that, and the system refuses to load one:

- a connector manifest declaring a write operation fails validation and is skipped
- `npm run smoke-test` fails if any registered tool could change something outside the database

## Controlling spend

Every phase calls a model API, so every phase costs money. The Economics page shows spend by
phase, model and goal. Your levers:

| Lever | Effect |
| --- | --- |
| Cycle interval (Agent control) | How often research runs |
| Pending idea limit (Settings) | Research pauses while this many ideas wait for you |
| Pause (Agent control) | Stops research entirely; persists across restarts |
| Per-phase models (Settings) | A cheap model for research, a strong one for deep dives |
| Approving | The only way a deep dive starts; it is the most expensive phase |
| Recurring deep dives | Repeat spend on a schedule, so set the interval deliberately |
| DataForSEO key | Paid per call; leave it unset if you don't want that cost |

## Checklist before running unattended

- **Set a sensible cycle interval.** The default is one hour.
- **Pick models per phase.** Research can run on something cheap.
- **Protect the console.** Set `AGENT_API_TOKEN` before exposing it to a network. Without it,
  the API is open and anyone who can reach the port can approve deep dives on your bill. That is
  why `AGENT_BIND_HOST` defaults to `127.0.0.1` and the agent prints a warning at startup. The
  token is one shared secret for the whole console, not per-user login.
- **Get notified.** Set `AGENT_NOTIFY_URL` so you hear about new ideas. Otherwise a cycle that
  finishes at 3 a.m. waits until the next time you open the console.

## Treat the reports as research, not advice

Reports cite their sources and separate measured figures from estimates, but they are written by
a model. Check the sources behind any figure you plan to act on, especially market sizes and
competitor prices.
