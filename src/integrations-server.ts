// src/integrations-server.ts
//
// MCP tools wrapping the GitHub/Vercel/Netlify clients in src/integrations/.
// Split the same way memory-server.ts splits research from proposal
// approval: *_read_* / *_list_* / *_get_* tools have no side effects and
// are safe for the research phase to call freely, same as WebSearch/
// WebFetch today (READONLY_INTEGRATION_TOOLS, exported for orchestrator.ts
// to add to that phase's allowedTools). Write tools (create/deploy/commit)
// are never in that list -- they only become callable when a proposal's
// required_tools names them and a human has approved it, same as any other
// act-phase tool.
//
// Every handler catches its own errors and returns them as tool text
// rather than throwing, including "TOKEN is not set" for an integration
// nobody configured -- so a phase run degrades to a clear in-band error
// instead of crashing.

import { tool, createSdkMcpServer, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import * as github from "./integrations/github.js";
import * as vercel from "./integrations/vercel.js";
import * as netlify from "./integrations/netlify.js";

export const READONLY_INTEGRATION_TOOLS = [
  "mcp__integrations__github_read_repo",
  "mcp__integrations__github_read_file",
  "mcp__integrations__github_search_repos",
  "mcp__integrations__vercel_list_projects",
  "mcp__integrations__vercel_get_project",
  "mcp__integrations__netlify_list_sites",
  "mcp__integrations__netlify_get_site",
];

async function toResult(fn: () => Promise<unknown>) {
  try {
    const data = await fn();
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

export function buildIntegrationsServer(): McpSdkServerConfigWithInstance {
  // ---- GitHub ---------------------------------------------------------------

  const githubReadRepo = tool(
    "github_read_repo",
    "Read a GitHub repo's metadata (description, stars, language, default branch). Read-only.",
    { owner: z.string(), repo: z.string() },
    ({ owner, repo }) => toResult(() => github.readRepo(owner, repo))
  );

  const githubReadFile = tool(
    "github_read_file",
    "Read a single file's contents from a GitHub repo. Read-only.",
    { owner: z.string(), repo: z.string(), path: z.string(), ref: z.string().optional().describe("branch, tag, or commit SHA") },
    ({ owner, repo, path, ref }) => toResult(() => github.readFile(owner, repo, path, ref))
  );

  const githubSearchRepos = tool(
    "github_search_repos",
    "Search public GitHub repos (e.g. to check whether something similar already exists). Read-only.",
    { query: z.string(), limit: z.number().int().positive().max(30).optional() },
    ({ query, limit }) => toResult(() => github.searchRepos(query, limit ?? 10))
  );

  const githubCreateRepo = tool(
    "github_create_repo",
    "Create a new GitHub repo under the authenticated account. Only usable when a proposal listing this tool has been approved.",
    { name: z.string(), description: z.string(), isPrivate: z.boolean().default(false) },
    ({ name, description, isPrivate }) => toResult(() => github.createRepo(name, description, isPrivate))
  );

  const githubCreateBranch = tool(
    "github_create_branch",
    "Create a new branch in a GitHub repo. Only usable when a proposal listing this tool has been approved.",
    { owner: z.string(), repo: z.string(), branch: z.string(), fromRef: z.string().optional().describe("e.g. 'heads/main'") },
    ({ owner, repo, branch, fromRef }) => toResult(() => github.createBranch(owner, repo, branch, fromRef))
  );

  const githubCommitFile = tool(
    "github_commit_file",
    "Create or update a single file on a branch with a commit. Only usable when a proposal listing this tool has been approved.",
    {
      owner: z.string(),
      repo: z.string(),
      path: z.string(),
      content: z.string(),
      message: z.string(),
      branch: z.string(),
    },
    ({ owner, repo, path, content, message, branch }) =>
      toResult(() => github.commitFile(owner, repo, path, content, message, branch))
  );

  const githubCommitFiles = tool(
    "github_commit_files",
    "Create or update any number of files on a branch as a single commit. Prefer this over repeated github_commit_file calls when scaffolding more than one file -- avoids a noisy one-commit-per-file history. Only usable when a proposal listing this tool has been approved.",
    {
      owner: z.string(),
      repo: z.string(),
      files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
      message: z.string(),
      branch: z.string(),
    },
    ({ owner, repo, files, message, branch }) => toResult(() => github.commitFiles(owner, repo, files, message, branch))
  );

  const githubCreatePr = tool(
    "github_create_pr",
    "Open a pull request. Only usable when a proposal listing this tool has been approved. If you open a PR, also call github_merge_pr afterward -- a human already reviewed and approved this work at proposal-approval time, so an unmerged PR just leaves the default branch empty/stale.",
    { owner: z.string(), repo: z.string(), title: z.string(), head: z.string(), base: z.string(), body: z.string().optional() },
    ({ owner, repo, title, head, base, body }) => toResult(() => github.createPullRequest(owner, repo, title, head, base, body))
  );

  const githubMergePr = tool(
    "github_merge_pr",
    "Merge an open pull request into its base branch. Only usable when a proposal listing this tool has been approved.",
    {
      owner: z.string(),
      repo: z.string(),
      pullNumber: z.number().int().positive(),
      mergeMethod: z.enum(["merge", "squash", "rebase"]).default("squash"),
    },
    ({ owner, repo, pullNumber, mergeMethod }) => toResult(() => github.mergePullRequest(owner, repo, pullNumber, mergeMethod))
  );

  // ---- Vercel -----------------------------------------------------------------

  const vercelListProjects = tool(
    "vercel_list_projects",
    "List projects in the authenticated Vercel account. Read-only.",
    { limit: z.number().int().positive().max(50).optional() },
    ({ limit }) => toResult(() => vercel.listProjects(limit ?? 20))
  );

  const vercelGetProject = tool(
    "vercel_get_project",
    "Get a Vercel project's details and latest deployment URLs. Read-only.",
    { idOrName: z.string() },
    ({ idOrName }) => toResult(() => vercel.getProject(idOrName))
  );

  const vercelDeploy = tool(
    "vercel_deploy",
    "Deploy a small set of files to Vercel. Only usable when a proposal listing this tool has been approved. Files are inline text (no binaries).",
    {
      projectName: z.string(),
      files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
      target: z.enum(["production", "preview"]).default("preview"),
    },
    ({ projectName, files, target }) => toResult(() => vercel.deploy(projectName, files, target))
  );

  // ---- Netlify ----------------------------------------------------------------

  const netlifyListSites = tool(
    "netlify_list_sites",
    "List sites in the authenticated Netlify account. Read-only.",
    { limit: z.number().int().positive().max(50).optional() },
    ({ limit }) => toResult(() => netlify.listSites(limit ?? 20))
  );

  const netlifyGetSite = tool(
    "netlify_get_site",
    "Get a Netlify site's details. Read-only.",
    { siteId: z.string() },
    ({ siteId }) => toResult(() => netlify.getSite(siteId))
  );

  const netlifyCreateSite = tool(
    "netlify_create_site",
    "Create a new Netlify site. Only usable when a proposal listing this tool has been approved.",
    { name: z.string() },
    ({ name }) => toResult(() => netlify.createSite(name))
  );

  const netlifyDeploy = tool(
    "netlify_deploy",
    "Deploy a small set of files to a Netlify site. Only usable when a proposal listing this tool has been approved. Files are inline text (no binaries).",
    { siteId: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })).min(1) },
    ({ siteId, files }) => toResult(() => netlify.deploy(siteId, files))
  );

  return createSdkMcpServer({
    name: "integrations",
    version: "1.0.0",
    tools: [
      githubReadRepo,
      githubReadFile,
      githubSearchRepos,
      githubCreateRepo,
      githubCreateBranch,
      githubCommitFile,
      githubCommitFiles,
      githubCreatePr,
      githubMergePr,
      vercelListProjects,
      vercelGetProject,
      vercelDeploy,
      netlifyListSites,
      netlifyGetSite,
      netlifyCreateSite,
      netlifyDeploy,
    ],
  });
}
