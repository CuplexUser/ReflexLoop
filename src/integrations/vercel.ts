// src/integrations/vercel.ts
//
// Thin wrapper over the Vercel REST API. listProjects/getProject are
// research-phase safe (read-only). deploy is act-phase only, gated behind
// an approved proposal -- see src/integrations-server.ts. Deploy only
// supports small inline text files (the deployments API's `files[].data`
// field), which fits what this agent would realistically produce: a static
// tool, a landing page, a small app scaffold -- not binary assets.
//
// deploy waits for the new deployment to finish building and then deletes the
// ones it superseded (same project, same target, older) -- see pruneSuperseded.

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

export async function deploy(projectName: string, files: DeployFile[], target: "production" | "preview" = "preview") {
  const data = await vc<{ id: string; url: string; readyState: string }>(`/v13/deployments`, {
    method: "POST",
    body: JSON.stringify({
      name: projectName,
      target,
      files: files.map((f) => ({ file: f.path, data: f.content })),
      projectSettings: { framework: null },
    }),
  });
  const status = await waitForTerminalState(data.id, data.readyState);
  const { removed, cleanup } = await pruneSuperseded(projectName, target, data.id, status);
  return { id: data.id, url: `https://${data.url}`, status, removedDeployments: removed, cleanup };
}
