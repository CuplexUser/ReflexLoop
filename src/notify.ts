// src/notify.ts
//
// Push a message to the operator when a proposal starts waiting for review.
//
// The review step is the one place the loop stops dead: humanReviewPhase emits
// `proposal_pending` and then blocks on a promise until somebody clicks Approve or
// Reject. Until this module existed the only way to learn that had happened was to be
// looking at the console. A cycle that finished at 03:00 sat there until the operator
// next opened a browser, which is latency the agent cannot do anything about and the
// largest single delay in the whole loop.
//
// Deliberately *not* a tool. Giving the model a "message the operator" tool would open a
// channel out of the process that is not the review flow, and the whole design rests on
// the review flow being the only one. This subscribes to the event bus in the
// orchestrator, one level above anything the model can reach.
//
// The webhook URL is a credential -- a Slack or Discord webhook URL is bearer-equivalent,
// whoever holds it can post as you -- so it lives in .env with the provider keys rather
// than in settings and the database. It is read at call time, like the connector
// credentials: a URL filled in while the loop runs works on the next proposal instead of
// the next restart.
//
// Nothing here is allowed to throw. A notification is a courtesy on top of the record; a
// failed POST must not take down a phase, and must not be retried into a loop either.

import type { AgentEvent } from "./events.js";
import { onAgentEvent } from "./events.js";
import type { ProposalRow } from "./memory-server.js";

const TIMEOUT_MS = 10_000;
/** Discord's hard cap is 2000 characters; the others are far more generous. Stay under all. */
const MAX_BODY_CHARS = 1_500;
const MAX_DESCRIPTION_CHARS = 400;

/**
 * Which flavour of webhook this is. Detected from the URL host rather than configured,
 * because the URL already says: nobody pastes a hooks.slack.com URL and means Discord, and
 * a second env var that can disagree with the first is a support question waiting to happen.
 */
export type NotifyKind = "slack" | "discord" | "ntfy" | "generic";

export function detectKind(url: string): NotifyKind {
  let host: string;
  try {
    host = new URL(url).host.toLowerCase();
  } catch {
    return "generic";
  }
  if (host === "hooks.slack.com" || host.endsWith(".slack.com")) return "slack";
  if (host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) {
    return "discord";
  }
  if (host === "ntfy.sh" || host.endsWith(".ntfy.sh")) return "ntfy";
  return "generic";
}

export interface NotifyConfig {
  url: string;
  kind: NotifyKind;
  consoleUrl: string;
}

/**
 * Read at call time, never captured at module load -- same rule as the connector
 * credentials, and for the same reason.
 */
export function notifyConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig | null {
  const url = env.AGENT_NOTIFY_URL?.trim();
  if (!url) return null;
  const port = env.AGENT_SERVER_PORT?.trim() || "4317";
  const consoleUrl = (env.AGENT_CONSOLE_URL?.trim() || `http://127.0.0.1:${port}`).replace(/\/$/, "");
  return { url, kind: detectKind(url), consoleUrl };
}

/** Collapses whitespace first: a proposal description is multi-line Markdown. */
function truncate(text: string, max: number): string {
  return hardCap(text.replace(/\s+/g, " ").trim(), max);
}

/**
 * The last-resort cap on the assembled message. Deliberately does *not* collapse
 * whitespace -- by this point the newlines are the message's line structure, and
 * flattening them turns three labelled lines into one unreadable paragraph.
 */
function hardCap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface NotifyMessage {
  title: string;
  body: string;
  /** Where the operator has to go to act on it. */
  link: string;
}

/**
 * What the operator needs in order to decide whether to stop what they are doing: which
 * lane, how it makes money, what it will cost, and how much real-world reach it asks for.
 * The tool list is spelled out rather than counted, because which write tools a proposal
 * wants is the part that cannot be undone once approved.
 */
export function formatProposalPending(proposal: ProposalRow, consoleUrl: string): NotifyMessage {
  const tools = (proposal.required_tools ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => t.replace(/^mcp__(memory|integrations)__/, ""));

  // Typeof rather than truthiness: an upside of 0 is a real forecast worth showing, and
  // these columns are null on proposals written before they existed.
  const money = [
    proposal.revenue_model ? `revenue: ${proposal.revenue_model}` : null,
    typeof proposal.expected_upside === "number" ? `upside: $${proposal.expected_upside}` : null,
    typeof proposal.expected_cost === "number" ? `cost: $${proposal.expected_cost}` : null,
    typeof proposal.expected_time_hours === "number" ? `~${proposal.expected_time_hours}h` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const lines = [
    truncate(proposal.description ?? "", MAX_DESCRIPTION_CHARS),
    money,
    tools.length > 0 ? `tools: ${tools.join(", ")}` : "tools: none",
  ].filter(Boolean);

  return {
    title: `Proposal #${proposal.id} needs review -- ${proposal.domain}`,
    body: hardCap(lines.join("\n"), MAX_BODY_CHARS),
    link: `${consoleUrl}/proposals/${proposal.id}`,
  };
}

export interface NotifyRequest {
  body: string;
  headers: Record<string, string>;
}

/** Shapes one message for one webhook flavour. Pure, so notify.test.ts needs no network. */
export function buildRequest(kind: NotifyKind, message: NotifyMessage): NotifyRequest {
  const text = `${message.title}\n${message.body}\n${message.link}`;
  switch (kind) {
    case "slack":
      return { body: JSON.stringify({ text }), headers: { "content-type": "application/json" } };
    case "discord":
      return {
        body: JSON.stringify({ content: text.slice(0, 2000) }),
        headers: { "content-type": "application/json" },
      };
    case "ntfy":
      // ntfy takes the message as the raw body and everything else as headers. Title and
      // Click are what make the phone notification tappable straight through to the review
      // page, which is the entire point of sending one.
      return {
        body: `${message.body}\n${message.link}`,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          Title: message.title,
          Click: message.link,
          Tags: "inbox_tray",
        },
      };
    case "generic":
      return {
        body: JSON.stringify({
          event: "proposal_pending",
          title: message.title,
          body: message.body,
          url: message.link,
        }),
        headers: { "content-type": "application/json" },
      };
  }
}

/**
 * Posts one message. Resolves to whether it was delivered and never rejects, so a caller
 * on the event bus can fire it without a try/catch and a failure costs a log line.
 */
export async function sendNotification(
  config: NotifyConfig,
  message: NotifyMessage,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  const { body, headers } = buildRequest(config.kind, message);
  try {
    const res = await fetchImpl(config.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[notify] ${config.kind} webhook -> ${res.status} ${detail.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`[notify] ${config.kind} webhook failed: ${detail}`);
    return false;
  }
}

/**
 * Subscribes to the bus. Returns the unsubscribe, so the shutdown sequence can drop it
 * along with everything else.
 *
 * Only `proposal_pending` is wired. Every other event either needs nothing from the
 * operator or is already on screen by the time they arrive -- and a channel that fires on
 * everything is one people mute, which would cost the loop the single signal that actually
 * blocks it.
 */
export function startNotifier(): () => void {
  const configured = notifyConfig();
  if (!configured) {
    console.log("[notify] AGENT_NOTIFY_URL not set -- proposals will wait silently for review");
    return () => {};
  }
  console.log(`[notify] proposal alerts -> ${configured.kind} webhook`);
  return onAgentEvent((event: AgentEvent) => {
    if (event.type !== "proposal_pending") return;
    // Re-read per event: the URL may have been filled in since startup.
    const config = notifyConfig();
    if (!config) return;
    void sendNotification(config, formatProposalPending(event.proposal, config.consoleUrl));
  });
}
