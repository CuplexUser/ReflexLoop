// src/integrations/github.ts
//
// Thin wrapper over the GitHub REST API. No SDK dependency -- plain fetch,
// since the surface we need is small. Read functions (readRepo, readFile,
// searchRepos) are safe for the research phase (no side effects). Write
// functions (createRepo, createBranch, commitFile, createPullRequest) are
// only ever exposed to the model as part of an approved proposal's
// required_tools -- see src/integrations-server.ts.

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const API = "https://api.github.com";

export const githubAvailable = Boolean(GITHUB_TOKEN);

interface GithubContentFile {
  path: string;
  sha: string;
  content: string;
  encoding: string;
}

interface GithubRepo {
  full_name: string;
  html_url: string;
  default_branch: string;
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
    throw new Error(`GitHub API ${init.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? (null as T) : ((await res.json()) as T);
}

// ---- read (research-phase safe) --------------------------------------------

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

// ---- write (act-phase, requires an approved proposal) ----------------------

export async function createRepo(name: string, description: string, isPrivate: boolean) {
  const data = await gh<GithubRepo>(`/user/repos`, {
    method: "POST",
    body: JSON.stringify({ name, description, private: isPrivate }),
  });
  return { fullName: data.full_name, url: data.html_url, defaultBranch: data.default_branch };
}

export async function createBranch(owner: string, repo: string, branch: string, fromRef = "heads/main") {
  const base = await gh<{ object: { sha: string } }>(`/repos/${owner}/${repo}/git/ref/${fromRef}`);
  const data = await gh<{ ref: string; object: { sha: string } }>(`/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }),
  });
  return { ref: data.ref, sha: data.object.sha };
}

export async function commitFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  message: string,
  branch: string
) {
  let sha: string | undefined;
  try {
    const existing = await gh<GithubContentFile | GithubContentFile[]>(
      `/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`
    );
    sha = Array.isArray(existing) ? undefined : existing.sha;
  } catch {
    // file doesn't exist yet on this branch -- creating, not updating
  }

  const data = await gh<{ content: { path: string; sha: string }; commit: { sha: string } }>(
    `/repos/${owner}/${repo}/contents/${path}`,
    {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch,
        ...(sha ? { sha } : {}),
      }),
    }
  );
  return { path: data.content.path, sha: data.content.sha, commitSha: data.commit.sha };
}

export async function createPullRequest(owner: string, repo: string, title: string, head: string, base: string, body?: string) {
  const data = await gh<{ number: number; html_url: string; state: string }>(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head, base, body }),
  });
  return { number: data.number, url: data.html_url, state: data.state };
}

// Batched alternative to commitFile: writes any number of files as a single
// commit via the Git Data API (blobs -> tree -> commit -> ref update),
// instead of one REST "update contents" call (and one commit) per file.
export async function commitFiles(
  owner: string,
  repo: string,
  files: { path: string; content: string }[],
  message: string,
  branch: string
) {
  const ref = await gh<{ object: { sha: string } }>(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
  const baseCommitSha = ref.object.sha;
  const baseCommit = await gh<{ tree: { sha: string } }>(`/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);

  const blobs = await Promise.all(
    files.map((f) =>
      gh<{ sha: string }>(`/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: Buffer.from(f.content, "utf8").toString("base64"), encoding: "base64" }),
      }).then((b) => ({ path: f.path, sha: b.sha }))
    )
  );

  const tree = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseCommit.tree.sha,
      tree: blobs.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha })),
    }),
  });

  const commit = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [baseCommitSha] }),
  });

  await gh(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });

  return { commitSha: commit.sha, filesCommitted: files.length };
}

export async function mergePullRequest(
  owner: string,
  repo: string,
  pullNumber: number,
  mergeMethod: "merge" | "squash" | "rebase" = "squash"
) {
  const data = await gh<{ sha: string; merged: boolean; message: string }>(
    `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
    { method: "PUT", body: JSON.stringify({ merge_method: mergeMethod }) }
  );
  return { sha: data.sha, merged: data.merged, message: data.message };
}
