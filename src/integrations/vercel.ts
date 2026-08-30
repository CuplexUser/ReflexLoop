// src/integrations/vercel.ts
//
// Thin wrapper over the Vercel REST API. listProjects/getProject are
// research-phase safe (read-only). deploy is act-phase only, gated behind
// an approved proposal -- see src/integrations-server.ts.
//
// deploy takes its files from one of two sources, and having the second is the
// difference between shipping a real site and not:
//
//   inline   -- DeployFile[], sent as the deployments API's `files[].data`.
//               Fine for a landing page or a handful of files.
//   fromRepo -- a GitHub repo, read here with GITHUB_TOKEN. The bytes never
//               pass through the model at all.
//
// The second exists because a Vercel deployment is an immutable, *complete*
// snapshot: every deploy replaces the project, so a site cannot be built up
// over several calls, and the whole thing therefore had to fit inside one tool
// call's arguments. A 21-file static site is past any sane output-token budget,
// so the turn truncated mid-file and the agent could not finish the build --
// it wrote the limit down as "the human must deploy this one by hand". The
// limit was ours, not Vercel's: `files[]` also accepts `{file, sha, size}`
// referencing blobs uploaded first to POST /v2/files, which is how the Vercel
// CLI works and what uploadFile below does. Paired with github.commitFiles
// (which commits on base_tree and so *is* additive across calls), the pipeline
// becomes: commit over as many calls as it takes, then deploy once from the repo.
//
// deploy waits for the new deployment to finish building and then deletes the
// ones it superseded (same project, same target, older) -- see pruneSuperseded.

import { createHash } from "node:crypto";
import { readBlob, readRepo, readTree, type RepoFile } from "./github.js";

const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const API = "https://api.vercel.com";

export const vercelAvailable = Boolean(VERCEL_TOKEN);

async function vc<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!VERCEL_TOKEN) throw new Error("VERCEL_TOKEN is not set");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Vercel API ${init.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

// ---- read (research-phase safe) --------------------------------------------

export async function listProjects(limit = 20) {
  const data = await vc<{ projects: { id: string; name: string; framework: string | null; updatedAt: number }[] }>(
    `/v9/projects?limit=${limit}`
  );
  return data.projects.map((p) => ({ id: p.id, name: p.name, framework: p.framework, updatedAt: p.updatedAt }));
}

export async function getProject(idOrName: string) {
  const p = await vc<{ id: string; name: string; framework: string | null; latestDeployments?: { url: string }[] }>(
    `/v9/projects/${encodeURIComponent(idOrName)}`
  );
  return {
    id: p.id,
    name: p.name,
    framework: p.framework,
    latestDeploymentUrls: (p.latestDeployments ?? []).map((d) => d.url),
  };
}

// ---- write (act-phase, requires an approved proposal) ----------------------

export interface DeployFile {
  path: string;
  content: string;
}

export interface DeploymentSummary {
  id: string;
  url: string;
  /** Vercel reports a preview deployment's target as null; normalized here. */
  target: "production" | "preview";
  createdAt: number;
}

export async function listDeployments(projectName: string, limit = 100): Promise<DeploymentSummary[]> {
  const data = await vc<{ deployments: { uid: string; url: string; target?: string | null; created: number }[] }>(
    `/v6/deployments?app=${encodeURIComponent(projectName)}&limit=${limit}`
  );
  return data.deployments.map((d) => ({
    id: d.uid,
    url: `https://${d.url}`,
    target: d.target === "production" ? "production" : "preview",
    createdAt: d.created,
  }));
}

export async function deleteDeployment(id: string): Promise<void> {
  await vc(`/v13/deployments/${encodeURIComponent(id)}`, { method: "DELETE" });
}

async function deploymentState(id: string): Promise<string> {
  const d = await vc<{ readyState?: string; status?: string }>(`/v13/deployments/${encodeURIComponent(id)}`);
  return d.readyState ?? d.status ?? "UNKNOWN";
}

const READY_POLL_INTERVAL_MS = 3000;
const READY_POLL_TIMEOUT_MS = 90_000;
const TERMINAL_STATES = new Set(["READY", "ERROR", "CANCELED", "DELETED"]);

/**
 * Wait for a deployment to stop building. `POST /deployments` answers immediately with
 * QUEUED, which is not enough to act on: the pruning below deletes what this deployment
 * replaces, and doing that while it is still building would take the site down if the
 * build then fails. Returns the last state seen -- a timeout is reported, not thrown,
 * since the deploy itself already succeeded.
 */
async function waitForTerminalState(id: string, initial: string): Promise<string> {
  let state = initial;
  const deadline = Date.now() + READY_POLL_TIMEOUT_MS;
  while (!TERMINAL_STATES.has(state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
    try {
      state = await deploymentState(id);
    } catch {
      return state; // A transient read failure isn't worth failing a good deploy over.
    }
  }
  return state;
}

/**
 * Delete the deployments this one just replaced.
 *
 * Every deploy mints a new immutable URL, so without this a project accumulates one
 * live-looking site per build (proposal #30 had three), all but the newest of which is
 * stale content still reachable by anyone holding the link. Scoped to the same project
 * *and* target, and only to deployments older than the new one -- a preview must not
 * delete production, and the deployment now serving the project must survive.
 *
 * Best-effort by construction: it runs after the deploy has succeeded, so a failure here
 * is reported in `cleanup` and never turns a good deploy into a failed tool call.
 */
async function pruneSuperseded(
  projectName: string,
  target: "production" | "preview",
  keepId: string,
  state: string
): Promise<{ removed: string[]; cleanup: string | null }> {
  if (state !== "READY") {
    return { removed: [], cleanup: `new deployment is ${state}, so earlier ${target} deployments were left in place` };
  }
  try {
    const all = await listDeployments(projectName);
    const keep = all.find((d) => d.id === keepId);
    const stale = all.filter(
      (d) => d.id !== keepId && d.target === target && (keep === undefined || d.createdAt < keep.createdAt)
    );
    const removed: string[] = [];
    const failed: string[] = [];
    for (const d of stale) {
      try {
        await deleteDeployment(d.id);
        removed.push(d.url);
      } catch {
        failed.push(d.url);
      }
    }
    return { removed, cleanup: failed.length === 0 ? null : `could not delete ${failed.join(", ")}` };
  } catch (err) {
    return { removed: [], cleanup: `could not list earlier deployments: ${(err as Error).message}` };
  }
}

/** Where a deployment's files come from. Exactly one of these; the caller decides. */
export type DeploySource = { files: DeployFile[] } | { repo: RepoSource };

export interface RepoSource {
  owner: string;
  repo: string;
  /** Branch, tag or commit sha. Defaults to the repo's default branch. */
  ref?: string;
  /** Deploy only this subtree, with its prefix stripped -- see github.selectTreeFiles. */
  directory?: string;
}

/** One entry of a deployment manifest: either inline data, or a reference to an uploaded blob. */
type DeploymentFile = { file: string; data: string } | { file: string; sha: string; size: number };

/**
 * Upload one file's bytes so a deployment can reference them by sha.
 *
 * Needs its own request rather than `vc()`: this endpoint takes a raw octet-stream body
 * rather than JSON, and answers 200 with an *empty* body that `res.json()` would throw on.
 * The digest is a sha1 of the bytes -- the same manifest shape netlify.ts already builds.
 */
async function uploadFile(bytes: Buffer): Promise<{ sha: string; size: number }> {
  if (!VERCEL_TOKEN) throw new Error("VERCEL_TOKEN is not set");
  const sha = createHash("sha1").update(bytes).digest("hex");
  const res = await fetch(`${API}/v2/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.byteLength),
      "x-vercel-digest": sha,
    },
    body: new Uint8Array(bytes),
  });
  if (!res.ok) {
    throw new Error(`Vercel API POST /v2/files -> ${res.status}: ${await res.text()}`);
  }
  return { sha, size: bytes.byteLength };
}

/** How many blobs to read+upload at once. Serial is too slow for a real site; unbounded rate-limits. */
const TRANSFER_CONCURRENCY = 8;

/** Runs `worker` over `items` with at most `limit` in flight, preserving input order in the result. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Copy a repo's files into Vercel's blob store, returning the manifest that references them. */
async function uploadRepoFiles(source: RepoSource, files: RepoFile[]): Promise<DeploymentFile[]> {
  return mapWithConcurrency(files, TRANSFER_CONCURRENCY, async (f) => {
    const bytes = await readBlob(source.owner, source.repo, f.sha);
    const { sha, size } = await uploadFile(bytes);
    return { file: f.path, sha, size };
  });
}

export async function deploy(
  projectName: string,
  source: DeploySource,
  target: "production" | "preview" = "preview"
) {
  let files: DeploymentFile[];
  let bytes: number;
  let describedSource: string;

  if ("repo" in source) {
    const { owner, repo, directory } = source.repo;
    // Resolved rather than defaulted to "main": createRepo realigns the default branch to
    // whatever was first committed to, so guessing here would 404 on a repo built on master.
    const ref = source.repo.ref ?? (await readRepo(owner, repo)).defaultBranch;
    const found = await readTree(owner, repo, ref, directory);
    files = await uploadRepoFiles({ ...source.repo, ref }, found);
    bytes = found.reduce((sum, f) => sum + f.size, 0);
    describedSource = `${owner}/${repo}@${ref}${directory ? ` (${directory})` : ""}`;
  } else {
    files = source.files.map((f) => ({ file: f.path, data: f.content }));
    bytes = source.files.reduce((sum, f) => sum + Buffer.byteLength(f.content, "utf8"), 0);
    describedSource = "inline";
  }

  // skipAutoDetectionConfirmation: a whole repo tree is far likelier than a hand-picked file
  // list to carry a package.json, and Vercel answers 400 asking you to confirm when the
  // framework it detects differs from the project's setting. There is nobody here to confirm.
  const data = await vc<{ id: string; url: string; readyState: string }>(
    `/v13/deployments?skipAutoDetectionConfirmation=1`,
    {
      method: "POST",
      body: JSON.stringify({
        name: projectName,
        target,
        files,
        projectSettings: { framework: null },
      }),
    }
  );
  const status = await waitForTerminalState(data.id, data.readyState);
  const { removed, cleanup } = await pruneSuperseded(projectName, target, data.id, status);
  return {
    id: data.id,
    url: `https://${data.url}`,
    status,
    source: describedSource,
    filesDeployed: files.length,
    bytes,
    removedDeployments: removed,
    cleanup,
  };
}
