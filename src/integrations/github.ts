// src/integrations/github.ts
//
// Thin wrapper over the GitHub REST API. No SDK dependency -- plain fetch,
// since the surface we need is small. Read-only by construction: this agent
// researches, and GitHub is one more place to look for competitors and
// prior art. There are no write functions here and there should not be.

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const API = "https://api.github.com";

export const githubAvailable = Boolean(GITHUB_TOKEN);

interface GithubContentFile {
  path: string;
  sha: string;
  content: string;
  encoding: string;
}

// Carries the HTTP status alongside the message so callers can branch on it
// rather than regex-matching an error string.
export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: string
  ) {
    super(`GitHub API ${method} ${path} -> ${status}: ${body}`);
    this.name = "GithubApiError";
  }
}

async function gh<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not set");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new GithubApiError(res.status, init.method ?? "GET", path, await res.text());
  }
  return res.status === 204 ? (null as T) : ((await res.json()) as T);
}

export async function readRepo(owner: string, repo: string) {
  const data = await gh<{
    full_name: string;
    description: string | null;
    stargazers_count: number;
    language: string | null;
    default_branch: string;
    html_url: string;
  }>(`/repos/${owner}/${repo}`);
  return {
    fullName: data.full_name,
    description: data.description,
    stars: data.stargazers_count,
    language: data.language,
    defaultBranch: data.default_branch,
    url: data.html_url,
  };
}

export async function readFile(owner: string, repo: string, path: string, ref?: string) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const data = await gh<GithubContentFile | GithubContentFile[]>(`/repos/${owner}/${repo}/contents/${path}${query}`);
  if (Array.isArray(data)) throw new Error(`${path} is a directory, not a file`);
  return { path: data.path, sha: data.sha, content: Buffer.from(data.content, "base64").toString("utf8") };
}

export async function searchRepos(query: string, limit = 10) {
  const data = await gh<{
    items: { full_name: string; description: string | null; stargazers_count: number; html_url: string; updated_at: string }[];
  }>(`/search/repositories?q=${encodeURIComponent(query)}&per_page=${limit}`);
  return data.items.map((r) => ({
    fullName: r.full_name,
    description: r.description,
    stars: r.stargazers_count,
    url: r.html_url,
    updatedAt: r.updated_at,
  }));
}
