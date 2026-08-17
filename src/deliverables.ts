// src/deliverables.ts
//
// "What has this agent actually built?" -- the one question the Actions page
// answers badly, because it answers a different one: every tool call, in order,
// with the artifact URLs buried a table-expansion and a dialog deep.
//
// This turns the same act-phase rows into one record per approved proposal that
// produced something reachable: the repo, the live deployment, the PR. Purely
// derived -- nothing new is written, so it can't disagree with the action log,
// and no new state has to be maintained when a tool is added.
//
// Deliberately deterministic: every artifact comes from a known write tool's
// own output (or, for commits, from its input), never from scanning free text
// for anything that looks like a link. An outcome note that mentions a URL is
// the model's account of what it did; an artifact here is the API's.

import { CONNECTOR_OPERATIONS, connectorOperation } from "./connectors/load.js";
import type { ActStatus } from "./memory-server.js";
import { isErrorResult, parseToolResult } from "./tool-output.js";

const P = "mcp__integrations__";

/**
 * The act-phase tools that can contribute an artifact. Also what MemoryStore selects
 * on, so the query and the switch below can't drift apart -- a tool added to one and
 * not the other would silently produce a deliverable with a missing link.
 *
 * The connector half is derived from the manifests rather than listed by hand, so a
 * declared `deliverable` block is the single place that decision gets made.
 */
export const DELIVERABLE_TOOLS = [
  `${P}github_create_repo`,
  `${P}github_commit_file`,
  `${P}github_commit_files`,
  `${P}github_read_repo`,
  `${P}github_create_pr`,
  `${P}github_merge_pr`,
  `${P}vercel_deploy`,
  `${P}vercel_get_project`,
  `${P}netlify_create_site`,
  `${P}netlify_deploy`,
  ...CONNECTOR_OPERATIONS.filter((op) => op.spec.deliverable).map((op) => op.toolName),
];

export type ArtifactKind = "site" | "repo" | "pull_request" | "payment_link";
/**
 * The three hand-written integrations, or a connector's manifest id. Widened to a
 * string when connectors arrived: the set is open now, and a union that has to be
 * edited for every manifest is the coupling this layer exists to remove.
 */
export type ArtifactProvider = string;

export interface DeliverableArtifact {
  kind: ArtifactKind;
  provider: ArtifactProvider;
  /** What to call it in the UI -- "CuplexUser/mcp-lint", "mcp-lint", "PR #1". */
  label: string;
  url: string;
  /** Qualifier worth showing next to the label: "production", "preview", "merged". */
  detail: string | null;
  occurredAt: string;
  actionId: number;
}

export interface DeliverableOutcome {
  success: boolean;
  revenue: number;
  cost: number;
  notes: string | null;
  recordedAt: string;
}

export interface Deliverable {
  proposalId: number;
  domain: string;
  description: string;
  /** The thing's own name (repo / project / site), not the proposal's prose. */
  name: string | null;
  reviewStatus: "mvp_done" | "needs_refinement" | null;
  /**
   * Whether the act phase that produced these artifacts actually finished.
   *
   * A card is built from whatever write tools succeeded, and `github_create_repo` alone is
   * enough to make one -- which is how proposal #27 came to sit here looking shipped while
   * `CuplexUser/machwatch` was an empty repo with nothing committed and no deploy. The artifact
   * is real; the claim that it is *finished* was never checked. Carried rather than filtered:
   * an interrupted build's repo is still a real thing the operator may need to open (usually
   * to clean it up), and hiding the card would recreate the original problem from the other
   * side -- work that exists in the world and nowhere in the console.
   */
  actStatus: ActStatus | null;
  priority: string;
  artifacts: DeliverableArtifact[];
  /** The artifact a human most likely wants to click: the production deployment if there is one. */
  siteUrl: string | null;
  repoUrl: string | null;
  filesCommitted: number;
  commits: number;
  /** Act-phase tool calls behind this deliverable -- the size of the trail on the Actions page. */
  actionCount: number;
  startedAt: string;
  lastActivityAt: string;
  outcome: DeliverableOutcome | null;
}

/** Just the columns this needs -- kept structural so nothing here depends on MemoryStore. */
export interface DeliverableActionRow {
  id: number;
  proposal_id: number;
  tool_name: string;
  tool_input: string | null;
  tool_output: string | null;
  occurred_at: string;
}

export interface DeliverableProposalRow {
  id: number;
  domain: string;
  description: string;
  status: string;
  priority: string;
  review_status: "mvp_done" | "needs_refinement" | null;
  act_status?: ActStatus | null;
}

export interface DeliverableOutcomeRow {
  proposal_id: number;
  actual_revenue: number;
  actual_cost: number;
  success: number;
  notes: string | null;
  recorded_at: string;
}

function parseInput(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Vercel reports deployment hosts without a scheme in some responses; a URL has to be clickable. */
function withScheme(url: string): string {
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

interface Accumulator {
  proposal: DeliverableProposalRow;
  artifacts: Map<string, DeliverableArtifact>;
  name: string | null;
  filesCommitted: number;
  commits: number;
  actionCount: number;
  startedAt: string;
  lastActivityAt: string;
  /** PR number -> artifact key, so a later merge can annotate the PR it merged. */
  pullRequests: Map<number, string>;
  /** Supersede group ("vercel:project:production") -> the artifact key currently holding it. */
  latestByGroup: Map<string, string>;
}

function artifactKey(artifact: DeliverableArtifact): string {
  return `${artifact.kind}:${artifact.url}`;
}

function add(acc: Accumulator, artifact: DeliverableArtifact): void {
  const key = artifactKey(artifact);
  const existing = acc.artifacts.get(key);
  // Same URL seen twice (a deploy, then the read-back that confirms it): keep the
  // first sighting's identity but let a later, more specific detail win.
  if (existing) {
    if (!existing.detail && artifact.detail) existing.detail = artifact.detail;
    return;
  }
  acc.artifacts.set(key, artifact);
}

/**
 * Add an artifact that *replaces* the last one in its group rather than joining it.
 *
 * Every Vercel deploy mints its own immutable deployment URL, so re-running a build
 * added a row to the card each time -- proposal #30 accumulated three identical
 * `automationsolver-play · production` links, which is growth without improvement:
 * only the last one is what the project serves, and `vercel.deploy` now deletes the
 * ones it superseded, so the earlier links are dead as well as redundant.
 *
 * The group is project + target, never just the project, because a preview deploy does
 * not supersede production -- they are two different live things.
 */
function addSuperseding(acc: Accumulator, group: string, artifact: DeliverableArtifact): void {
  const previous = acc.latestByGroup.get(group);
  const key = artifactKey(artifact);
  if (previous && previous !== key) acc.artifacts.delete(previous);
  add(acc, artifact);
  acc.latestByGroup.set(group, key);
}

/**
 * One record per approved proposal whose act phase produced something reachable.
 * Newest activity first. Proposals that acted but built nothing linkable are left
 * out -- they're act-phase history, which is what the Actions page is for.
 */
export function buildDeliverables(
  actions: DeliverableActionRow[],
  proposals: DeliverableProposalRow[],
  outcomes: DeliverableOutcomeRow[],
  /**
   * Total act-phase calls per proposal. `actions` is narrowed to the artifact-producing
   * tools, so counting it would report a smaller trail than the Actions page shows for
   * the same proposal; the caller passes the real total.
   */
  actActionCounts?: Map<number, number>
): Deliverable[] {
  const proposalById = new Map(proposals.map((p) => [p.id, p]));
  const outcomeByProposal = new Map(outcomes.map((o) => [o.proposal_id, o]));
  const accs = new Map<number, Accumulator>();

  for (const action of [...actions].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))) {
    const proposal = proposalById.get(action.proposal_id);
    if (!proposal || proposal.status !== "approved") continue;

    let acc = accs.get(action.proposal_id);
    if (!acc) {
      acc = {
        proposal,
        artifacts: new Map(),
        name: null,
        filesCommitted: 0,
        commits: 0,
        actionCount: 0,
        startedAt: action.occurred_at,
        lastActivityAt: action.occurred_at,
        pullRequests: new Map(),
        latestByGroup: new Map(),
      };
      accs.set(action.proposal_id, acc);
    }
    acc.actionCount++;
    acc.lastActivityAt = action.occurred_at;

    const result = parseToolResult(action.tool_output);
    if (isErrorResult(result)) continue;
    const out = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
    const input = parseInput(action.tool_input);
    const at = { occurredAt: action.occurred_at, actionId: action.id };

    // Connectors first, and generically: the manifest already said what kind of thing
    // this operation produces and `result` already shaped the response into a top-level
    // `url`, so there is nothing per-connector left to know. A new manifest with a
    // `deliverable` block shows up here without touching this file.
    const connectorOp = connectorOperation(action.tool_name);
    if (connectorOp?.spec.deliverable) {
      const url = str(out.url);
      if (url) {
        add(acc, {
          kind: connectorOp.spec.deliverable.kind,
          provider: connectorOp.connector.id,
          label: str(out.label) ?? str(out.name) ?? str(input.name) ?? connectorOp.connector.label,
          url: withScheme(url),
          detail: connectorOp.spec.deliverable.detail ?? null,
          ...at,
        });
      }
      continue;
    }

    switch (action.tool_name) {
      case `${P}github_create_repo`: {
        const url = str(out.url);
        acc.name = str(input.name) ?? acc.name;
        if (url) {
          add(acc, { kind: "repo", provider: "github", label: str(out.fullName) ?? url, url, detail: null, ...at });
        }
        break;
      }

      // Commits don't return a URL of their own, but they name the repo they landed
      // in -- which is the deliverable when the agent committed into an existing repo
      // rather than creating one (proposal #15's landing page, for instance).
      case `${P}github_commit_file`:
      case `${P}github_commit_files`: {
        const owner = str(input.owner);
        const repo = str(input.repo);
        acc.commits++;
        acc.filesCommitted += Array.isArray(input.files) ? input.files.length : 1;
        if (owner && repo) {
          acc.name = acc.name ?? repo;
          add(acc, {
            kind: "repo",
            provider: "github",
            label: `${owner}/${repo}`,
            url: `https://github.com/${owner}/${repo}`,
            detail: null,
            ...at,
          });
        }
        break;
      }

      case `${P}github_read_repo`: {
        // A read-back after committing: same repo, and it carries the canonical URL.
        const url = str(out.url);
        if (url) add(acc, { kind: "repo", provider: "github", label: str(out.fullName) ?? url, url, detail: null, ...at });
        break;
      }

      case `${P}github_create_pr`: {
        const url = str(out.url);
        const number = typeof out.number === "number" ? out.number : null;
        if (url) {
          const artifact: DeliverableArtifact = {
            kind: "pull_request",
            provider: "github",
            label: number === null ? "Pull request" : `PR #${number}`,
            url,
            detail: str(out.state),
            ...at,
          };
          add(acc, artifact);
          if (number !== null) acc.pullRequests.set(number, `pull_request:${url}`);
        }
        break;
      }

      case `${P}github_merge_pr`: {
        const number = typeof input.pullNumber === "number" ? input.pullNumber : null;
        const key = number === null ? undefined : acc.pullRequests.get(number);
        const artifact = key ? acc.artifacts.get(key) : undefined;
        if (artifact && out.merged !== false) artifact.detail = "merged";
        break;
      }

      case `${P}vercel_deploy`: {
        const url = str(out.url);
        acc.name = acc.name ?? str(input.projectName);
        if (url) {
          const project = str(input.projectName);
          const target = str(input.target) ?? "preview";
          addSuperseding(acc, `vercel:${project ?? url}:${target}`, {
            kind: "site",
            provider: "vercel",
            label: project ?? url,
            url: withScheme(url),
            detail: target,
            ...at,
          });
        }
        break;
      }

      case `${P}vercel_get_project`: {
        // The read-back the act prompt asks for after deploying: its latest deployment
        // is the live URL, and it's the only place a production alias shows up.
        const urls = Array.isArray(out.latestDeploymentUrls) ? out.latestDeploymentUrls : [];
        const url = str(urls[0]);
        if (url) {
          add(acc, {
            kind: "site",
            provider: "vercel",
            label: str(out.name) ?? url,
            url: withScheme(url),
            detail: null,
            ...at,
          });
        }
        break;
      }

      case `${P}netlify_create_site`:
      case `${P}netlify_deploy`: {
        const url = str(out.url);
        acc.name = acc.name ?? str(out.name) ?? str(input.name);
        if (url) {
          add(acc, {
            kind: "site",
            provider: "netlify",
            label: str(out.name) ?? str(input.name) ?? url,
            url: withScheme(url),
            detail: action.tool_name.endsWith("netlify_deploy") ? "deploy" : null,
            ...at,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  const deliverables: Deliverable[] = [];
  for (const acc of accs.values()) {
    const artifacts = [...acc.artifacts.values()].sort(
      (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.occurredAt.localeCompare(b.occurredAt)
    );
    if (artifacts.length === 0) continue;

    const sites = artifacts.filter((a) => a.kind === "site");
    // Production beats preview: a preview URL is often gated, and it isn't the thing
    // the operator wants to hand to someone.
    const primarySite = sites.find((a) => a.detail === "production") ?? sites[sites.length - 1] ?? null;
    const outcome = outcomeByProposal.get(acc.proposal.id);

    deliverables.push({
      proposalId: acc.proposal.id,
      domain: acc.proposal.domain,
      description: acc.proposal.description,
      name: acc.name,
      reviewStatus: acc.proposal.review_status,
      actStatus: acc.proposal.act_status ?? null,
      priority: acc.proposal.priority,
      artifacts,
      siteUrl: primarySite?.url ?? null,
      repoUrl: artifacts.find((a) => a.kind === "repo")?.url ?? null,
      filesCommitted: acc.filesCommitted,
      commits: acc.commits,
      actionCount: actActionCounts?.get(acc.proposal.id) ?? acc.actionCount,
      startedAt: acc.startedAt,
      lastActivityAt: acc.lastActivityAt,
      outcome: outcome
        ? {
            success: outcome.success === 1,
            revenue: outcome.actual_revenue,
            cost: outcome.actual_cost,
            notes: outcome.notes,
            recordedAt: outcome.recorded_at,
          }
        : null,
    });
  }

  return deliverables.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
}

// A payment link sorts first: on a proposal that produced one, it is the artifact the
// operator came to the page for.
const KIND_ORDER: Record<ArtifactKind, number> = { payment_link: 0, site: 1, repo: 2, pull_request: 3 };
