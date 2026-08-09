// src/integrations/netlify.ts
//
// Thin wrapper over the Netlify REST API. listSites/getSite are
// research-phase safe (read-only). createSite/deploy are act-phase only,
// gated behind an approved proposal -- see src/integrations-server.ts.
//
// deploy uses Netlify's digest-based "manual deploy" flow: declare a sha1
// per file, Netlify says which ones it doesn't already have, upload just
// those. No zip library needed, and it naturally skips re-uploading files
// that haven't changed since the last deploy.

import { createHash } from "node:crypto";

const NETLIFY_TOKEN = process.env.NETLIFY_AUTH_TOKEN;
const API = "https://api.netlify.com/api/v1";

export const netlifyAvailable = Boolean(NETLIFY_TOKEN);

async function nf<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!NETLIFY_TOKEN) throw new Error("NETLIFY_AUTH_TOKEN is not set");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${NETLIFY_TOKEN}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Netlify API ${init.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? (null as T) : ((await res.json()) as T);
}

// ---- read (research-phase safe) --------------------------------------------

export async function listSites(limit = 20) {
  const data = await nf<{ id: string; name: string; url: string; updated_at: string }[]>(`/sites?per_page=${limit}`);
  return data.map((s) => ({ id: s.id, name: s.name, url: s.url, updatedAt: s.updated_at }));
}

export async function getSite(siteId: string) {
  const s = await nf<{ id: string; name: string; url: string; state: string }>(`/sites/${siteId}`);
  return { id: s.id, name: s.name, url: s.url, state: s.state };
}

// ---- write (act-phase, requires an approved proposal) ----------------------

export async function createSite(name: string) {
  const s = await nf<{ id: string; name: string; url: string }>(`/sites`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  return { id: s.id, name: s.name, url: s.url };
}

export interface DeployFile {
  path: string;
  content: string;
}

export async function deploy(siteId: string, files: DeployFile[]) {
  const digests: Record<string, string> = {};
  const byPath = new Map<string, string>();
  for (const f of files) {
    const normalizedPath = f.path.startsWith("/") ? f.path : `/${f.path}`;
    digests[normalizedPath] = createHash("sha1").update(f.content).digest("hex");
    byPath.set(normalizedPath, f.content);
  }

  const deployResult = await nf<{ id: string; required: string[] }>(`/sites/${siteId}/deploys`, {
    method: "POST",
    body: JSON.stringify({ files: digests }),
  });

  for (const sha of deployResult.required ?? []) {
    const path = Object.keys(digests).find((p) => digests[p] === sha);
    const content = path ? byPath.get(path) : undefined;
    if (!path || content === undefined) continue;
    await fetch(`${API}/deploys/${deployResult.id}/files${path}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${NETLIFY_TOKEN}`, "Content-Type": "application/octet-stream" },
      body: content,
    });
  }

  return { id: deployResult.id, siteId };
}
