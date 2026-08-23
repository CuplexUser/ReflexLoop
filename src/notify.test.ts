import { describe, expect, it } from "vitest";
import {
  buildRequest,
  detectKind,
  formatProposalPending,
  notifyConfig,
  sendNotification,
  type NotifyConfig,
  type NotifyMessage,
} from "./notify.js";
import type { ProposalRow } from "./memory-server.js";

function proposal(overrides: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id: 41,
    domain: "affiliate comparison sites for B2B software",
    description:
      "**FieldServiceCompare** -- a comparison site for field service management software, " +
      "monetized through the affiliate programs of the five vendors that accept new applicants.",
    expected_cost: 0,
    expected_time_hours: 4,
    expected_upside: 200,
    required_tools: "mcp__integrations__github_create_repo,mcp__integrations__vercel_deploy",
    status: "pending",
    revenue_model: "affiliate",
    ...overrides,
  } as ProposalRow;
}

describe("detectKind", () => {
  it("recognizes the three webhook flavours by host", () => {
    expect(detectKind("https://hooks.slack.com/services/T00/B00/xxx")).toBe("slack");
    expect(detectKind("https://discord.com/api/webhooks/123/abc")).toBe("discord");
    expect(detectKind("https://discordapp.com/api/webhooks/123/abc")).toBe("discord");
    expect(detectKind("https://ntfy.sh/reflexloop-reviews")).toBe("ntfy");
  });

  it("falls back to a generic JSON post for anything else", () => {
    expect(detectKind("https://hooks.example.com/agent")).toBe("generic");
    // A malformed URL must not throw here -- the send attempt is where it should fail,
    // with an error naming the URL, not during detection on the event bus.
    expect(detectKind("not a url")).toBe("generic");
  });
});

describe("notifyConfig", () => {
  it("is null when no webhook is set, which is the default state", () => {
    expect(notifyConfig({})).toBeNull();
    expect(notifyConfig({ AGENT_NOTIFY_URL: "   " })).toBeNull();
  });

  it("builds the console link from the port when no console URL is given", () => {
    const config = notifyConfig({ AGENT_NOTIFY_URL: "https://ntfy.sh/x", AGENT_SERVER_PORT: "5000" });
    expect(config).toEqual({ url: "https://ntfy.sh/x", kind: "ntfy", consoleUrl: "http://127.0.0.1:5000" });
  });

  it("prefers an explicit console URL and strips its trailing slash", () => {
    const config = notifyConfig({
      AGENT_NOTIFY_URL: "https://ntfy.sh/x",
      AGENT_CONSOLE_URL: "https://agent.example.com/",
    });
    expect(config?.consoleUrl).toBe("https://agent.example.com");
  });
});

describe("formatProposalPending", () => {
  it("links straight to the proposal's own deep link, not the dashboard", () => {
    const message = formatProposalPending(proposal(), "https://agent.example.com");
    expect(message.link).toBe("https://agent.example.com/proposals/41");
  });

  it("names the lane and the money path, and strips the tool namespaces", () => {
    const message = formatProposalPending(proposal(), "http://127.0.0.1:4317");
    expect(message.title).toContain("#41");
    expect(message.title).toContain("affiliate comparison sites");
    expect(message.body).toContain("revenue: affiliate");
    expect(message.body).toContain("upside: $200");
    expect(message.body).toContain("~4h");
    expect(message.body).toContain("tools: github_create_repo, vercel_deploy");
    expect(message.body).not.toContain("mcp__integrations__");
  });

  it("shows an upside of zero rather than dropping it as falsy", () => {
    const message = formatProposalPending(proposal({ expected_upside: 0 }), "http://x");
    expect(message.body).toContain("upside: $0");
  });

  it("says so explicitly when a proposal asks for no tools at all", () => {
    const message = formatProposalPending(proposal({ required_tools: "" }), "http://x");
    expect(message.body).toContain("tools: none");
  });

  it("renders a legacy proposal with null money columns without printing empty labels", () => {
    const message = formatProposalPending(
      proposal({ revenue_model: null, expected_upside: null, expected_cost: null } as unknown as Partial<ProposalRow>),
      "http://x"
    );
    expect(message.body).not.toContain("revenue:");
    expect(message.body).not.toContain("upside:");
    expect(message.body).toContain("tools:");
  });

  it("truncates a long description rather than sending a wall of Markdown to a phone", () => {
    const message = formatProposalPending(proposal({ description: "word ".repeat(500) }), "http://x");
    expect(message.body.length).toBeLessThan(600);
    expect(message.body).toContain("…");
  });

  // The description is collapsed to one line, but the message's own line structure has to
  // survive -- flattening it turned three labelled lines into one unreadable paragraph.
  it("keeps the description, the money line and the tool line on separate lines", () => {
    const message = formatProposalPending(proposal({ description: "line one\n\nline two" }), "http://x");
    const [description, money, tools] = message.body.split("\n");
    expect(description).toBe("line one line two");
    expect(money).toContain("revenue: affiliate");
    expect(tools).toContain("tools: github_create_repo");
  });
});

describe("buildRequest", () => {
  const message: NotifyMessage = {
    title: "Proposal #41 needs review -- affiliate",
    body: "a body",
    link: "http://127.0.0.1:4317/proposals/41",
  };

  it("uses each service's own field name", () => {
    expect(JSON.parse(buildRequest("slack", message).body)).toHaveProperty("text");
    expect(JSON.parse(buildRequest("discord", message).body)).toHaveProperty("content");
    expect(JSON.parse(buildRequest("generic", message).body)).toMatchObject({
      event: "proposal_pending",
      url: message.link,
    });
  });

  it("sends ntfy the message as a raw body with the link in a Click header", () => {
    const request = buildRequest("ntfy", message);
    expect(request.headers["content-type"]).toContain("text/plain");
    expect(request.headers.Title).toBe(message.title);
    expect(request.headers.Click).toBe(message.link);
    expect(request.body).toContain("a body");
  });

  it("keeps a Discord payload under the 2000-character hard limit", () => {
    const long: NotifyMessage = { ...message, body: "x".repeat(5000) };
    const content = JSON.parse(buildRequest("discord", long).body).content as string;
    expect(content.length).toBeLessThanOrEqual(2000);
  });
});

describe("sendNotification", () => {
  const config: NotifyConfig = {
    url: "https://ntfy.sh/x",
    kind: "ntfy",
    consoleUrl: "http://127.0.0.1:4317",
  };
  const message: NotifyMessage = { title: "t", body: "b", link: "http://x/proposals/1" };

  it("reports delivery on a 2xx", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await sendNotification(config, message, fake)).toBe(true);
    expect(calls[0][0]).toBe(config.url);
    expect(calls[0][1]?.method).toBe("POST");
  });

  // The whole point of the module is that it is a courtesy on top of the record. A webhook
  // that is down, misconfigured or slow must cost a log line, never a phase.
  it("swallows a non-2xx rather than throwing into the event bus", async () => {
    const fake = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    expect(await sendNotification(config, message, fake)).toBe(false);
  });

  it("swallows a network failure too", async () => {
    const fake = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await sendNotification(config, message, fake)).toBe(false);
  });
});
