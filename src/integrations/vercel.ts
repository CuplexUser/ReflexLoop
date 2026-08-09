// src/integrations/vercel.ts
//
// Thin wrapper over the Vercel REST API. listProjects/getProject are
// research-phase safe (read-only). deploy is act-phase only, gated behind
// an approved proposal -- see src/integrations-server.ts. Deploy only
// supports small inline text files (the deployments API's `files[].data`
// field), which fits what this agent would realistically produce: a static
// tool, a landing page, a small app scaffold -- not binary assets.

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
  return { id: data.id, url: `https://${data.url}`, status: data.readyState };
}
