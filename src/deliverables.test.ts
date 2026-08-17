import { describe, expect, it } from "vitest";
import { buildDeliverables, type DeliverableActionRow, type DeliverableProposalRow } from "./deliverables.js";
import { extractResultUrl, parseToolResult } from "./tool-output.js";

const P = "mcp__integrations__";

/** The shape rows written under the old Agent SDK still have on disk. */
function mcpBlocks(result: unknown): string {
  return JSON.stringify([{ type: "text", text: JSON.stringify(result, null, 2) }]);
}

/** The shape logAction writes now: the tool's text, JSON.stringify'd once. */
function plainText(result: unknown): string {
  return JSON.stringify(JSON.stringify(result, null, 2));
}

let nextId = 1;
function action(
  toolName: string,
  input: unknown,
  output: string | null,
  opts: { proposalId?: number; at?: string } = {}
): DeliverableActionRow {
  return {
    id: nextId++,
    proposal_id: opts.proposalId ?? 1,
    tool_name: toolName,
    tool_input: JSON.stringify(input),
    tool_output: output,
    occurred_at: opts.at ?? `2026-08-14T10:00:${String(nextId).padStart(2, "0")}.000Z`,
  };
}

const proposal: DeliverableProposalRow = {
  id: 1,
  domain: "VS Code extension for developers",
  description: "mcp-lint landing page",
  status: "approved",
  priority: "normal",
  review_status: null,
};

describe("parseToolResult", () => {
  it("reads the MCP content-block shape written under the old SDK", () => {
    expect(extractResultUrl(mcpBlocks({ url: "https://github.com/o/r" }))).toBe("https://github.com/o/r");
  });

  it("reads the double-encoded plain-text shape written now", () => {
    expect(extractResultUrl(plainText({ url: "https://x.vercel.app" }))).toBe("https://x.vercel.app");
  });

  it("returns the raw text for a non-JSON result, and null for nothing", () => {
    expect(parseToolResult(JSON.stringify("Error: GITHUB_TOKEN is not set"))).toBe("Error: GITHUB_TOKEN is not set");
    expect(extractResultUrl(null)).toBeNull();
    expect(extractResultUrl("not json at all")).toBeNull();
  });
});

describe("buildDeliverables", () => {
  it("collects repo, deployment and PR artifacts for one proposal", () => {
    const rows = [
      action(`${P}github_create_repo`, { name: "mcp-lint" }, mcpBlocks({ fullName: "acme/mcp-lint", url: "https://github.com/acme/mcp-lint" })),
      action(`${P}github_commit_files`, { owner: "acme", repo: "mcp-lint", files: [{ path: "a" }, { path: "b" }] }, plainText({ commitSha: "abc", filesCommitted: 2 })),
      action(`${P}github_create_pr`, { owner: "acme", repo: "mcp-lint" }, mcpBlocks({ number: 1, url: "https://github.com/acme/mcp-lint/pull/1", state: "open" })),
      action(`${P}github_merge_pr`, { pullNumber: 1 }, mcpBlocks({ merged: true })),
      action(`${P}vercel_deploy`, { projectName: "mcp-lint", target: "production" }, plainText({ url: "https://mcp-lint.vercel.app" })),
    ];

    const [d] = buildDeliverables(rows, [proposal], []);

    expect(d.name).toBe("mcp-lint");
    expect(d.repoUrl).toBe("https://github.com/acme/mcp-lint");
    expect(d.siteUrl).toBe("https://mcp-lint.vercel.app");
    expect(d.filesCommitted).toBe(2);
    expect(d.commits).toBe(1);
    expect(d.artifacts.map((a) => a.kind)).toEqual(["site", "repo", "pull_request"]);
    expect(d.artifacts.find((a) => a.kind === "pull_request")?.detail).toBe("merged");
  });

  it("derives the repo from commit inputs when nothing created it this run", () => {
    const rows = [action(`${P}github_commit_file`, { owner: "acme", repo: "existing" }, plainText({ commitSha: "abc" }))];
    const [d] = buildDeliverables(rows, [proposal], []);

    expect(d.repoUrl).toBe("https://github.com/acme/existing");
    expect(d.name).toBe("existing");
    expect(d.filesCommitted).toBe(1);
  });

  it("prefers the production deployment over a preview, and de-duplicates read-backs", () => {
    const rows = [
      action(`${P}vercel_deploy`, { projectName: "site", target: "preview" }, plainText({ url: "https://preview.vercel.app" })),
      action(`${P}vercel_deploy`, { projectName: "site", target: "production" }, plainText({ url: "https://live.vercel.app" })),
      // The read-back the act prompt asks for -- same URL, no scheme, must not double up.
      action(`${P}vercel_get_project`, { idOrName: "site" }, plainText({ name: "site", latestDeploymentUrls: ["live.vercel.app"] })),
    ];

    const [d] = buildDeliverables(rows, [proposal], []);

    expect(d.siteUrl).toBe("https://live.vercel.app");
    expect(d.artifacts.filter((a) => a.kind === "site")).toHaveLength(2);
  });

  // Proposal #30's card grew a row per re-run -- three identical
  // "automationsolver-play · production" links, only the last of which the project served.
  it("keeps only the newest deploy of a project+target, but never across targets", () => {
    const rows = [
      action(`${P}vercel_deploy`, { projectName: "play", target: "production" }, plainText({ url: "https://play-one.vercel.app" })),
      action(`${P}vercel_deploy`, { projectName: "play", target: "preview" }, plainText({ url: "https://play-prev.vercel.app" })),
      action(`${P}vercel_deploy`, { projectName: "play", target: "production" }, plainText({ url: "https://play-two.vercel.app" })),
      action(`${P}vercel_deploy`, { projectName: "play", target: "production" }, plainText({ url: "https://play-three.vercel.app" })),
    ];

    const [d] = buildDeliverables(rows, [proposal], []);
    const sites = d.artifacts.filter((a) => a.kind === "site");

    expect(sites.map((a) => a.url)).toEqual(["https://play-prev.vercel.app", "https://play-three.vercel.app"]);
    expect(d.siteUrl).toBe("https://play-three.vercel.app");
  });

  it("ignores failed calls, unapproved proposals, and proposals that built nothing linkable", () => {
    const rows = [
      action(`${P}github_create_repo`, { name: "nope" }, plainText("Error: GITHUB_TOKEN is not set")),
      action(`${P}vercel_deploy`, { projectName: "x" }, plainText({ url: "https://x.vercel.app" }), { proposalId: 2 }),
    ];
    const pending: DeliverableProposalRow = { ...proposal, id: 2, status: "pending" };

    expect(buildDeliverables(rows, [proposal, pending], [])).toEqual([]);
  });

  it("reports the full act trail size, not just the artifact-producing calls", () => {
    const rows = [action(`${P}github_create_repo`, { name: "r" }, plainText({ url: "https://github.com/acme/r" }))];
    const [d] = buildDeliverables(rows, [proposal], [], new Map([[1, 24]]));

    expect(d.actionCount).toBe(24);
  });

  it("attaches the recorded outcome and sorts newest activity first", () => {
    const rows = [
      action(`${P}vercel_deploy`, { projectName: "old" }, plainText({ url: "https://old.vercel.app" }), { at: "2026-08-01T00:00:00.000Z" }),
      action(`${P}vercel_deploy`, { projectName: "new" }, plainText({ url: "https://new.vercel.app" }), { proposalId: 2, at: "2026-08-10T00:00:00.000Z" }),
    ];
    const second: DeliverableProposalRow = { ...proposal, id: 2 };
    const outcomes = [
      { proposal_id: 1, actual_revenue: 0, actual_cost: 3, success: 1, notes: "shipped", recorded_at: "2026-08-01T01:00:00.000Z" },
    ];

    const built = buildDeliverables(rows, [proposal, second], outcomes);

    expect(built.map((d) => d.proposalId)).toEqual([2, 1]);
    expect(built[1].outcome).toMatchObject({ success: true, cost: 3, notes: "shipped" });
    expect(built[0].outcome).toBeNull();
  });
});
