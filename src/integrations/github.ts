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

// Carries the HTTP status alongside the message so callers can branch on it.
// `commitFiles` needs to tell 409 ("repository is empty", a state it can
// recover from) apart from 404 ("no such branch", which it must not) -- and
// regex-matching an error string to make that call is how it stays wrong.
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
// Resolves the commit this write builds on. Three cases the Git Data API
// reports differently and which must not be collapsed into one:
//
//   ok   -> the branch exists; commit on top of it.
//   409  -> the repo has zero commits, so no ref exists *anywhere* in it.
//           `createRepo` produces exactly this state, so "create a repo then
//           commit to it" -- the normal shape of a build -- used to fail here
//           with `Git Repository is empty.` and no way forward. This is the
//           initial commit: no base tree, no parents, and the ref has to be
//           created rather than fast-forwarded.
//   404  -> the repo *has* commits but not this branch. Deliberately still an
//           error: treating it as an initial commit would answer success while
//           silently leaving an orphan branch (no shared history with the
//           default branch, invisible on the repo's front page) -- the same
//           "reported fine, nothing there" failure, one level subtler. The
//           message names the branches that do exist, because a caller that
//           guesses main-vs-master otherwise just burns turns guessing again.
async function resolveBase(owner: string, repo: string, branch: string) {
  try {
    const ref = await gh<{ object: { sha: string } }>(`/repos/${owner}/${repo}/git/ref/heads/${branch}`);
    const commit = await gh<{ tree: { sha: string } }>(`/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
    return { commitSha: ref.object.sha, treeSha: commit.tree.sha };
  } catch (err) {
    if (!(err instanceof GithubApiError)) throw err;
    if (err.status === 409) return null; // empty repo -> initial commit
    if (err.status === 404) {
      const known = await listBranchNames(owner, repo);
      throw new Error(
        `Branch '${branch}' does not exist in ${owner}/${repo}` +
          (known.length ? `. Existing branches: ${known.join(", ")}` : "") +
          `. Pass one of those as 'branch', or create it first with github_create_branch.`
      );
    }
    throw err;
  }
}

async function listBranchNames(owner: string, repo: string): Promise<string[]> {
  try {
    const branches = await gh<{ name: string }[]>(`/repos/${owner}/${repo}/branches?per_page=100`);
    return branches.map((b) => b.name);
  } catch {
    return []; // best-effort detail on an error path; never mask the real failure
  }
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** Path segments need escaping individually -- the slashes are structural. */
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

async function uploadTree(owner: string, repo: string, files: { path: string; content: string }[], baseTreeSha?: string) {
  const blobs = await Promise.all(
    files.map((f) =>
      gh<{ sha: string }>(`/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: b64(f.content), encoding: "base64" }),
      }).then((b) => ({ path: f.path, sha: b.sha }))
    )
  );
  return gh<{ sha: string }>(`/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({
      ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
      tree: blobs.map((b) => ({ path: b.path, mode: "100644", type: "blob", sha: b.sha })),
    }),
  });
}

export async function commitFiles(
  owner: string,
  repo: string,
  files: { path: string; content: string }[],
  message: string,
  branch: string
) {
  const base = await resolveBase(owner, repo, branch);
  if (!base) return initialCommit(owner, repo, files, message, branch);

  const tree = await uploadTree(owner, repo, files, base.treeSha);
  const commit = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [base.commitSha] }),
  });
  await gh(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });

  return { commitSha: commit.sha, filesCommitted: files.length, initialCommit: false };
}

// The first commit into a repo that has none.
//
// The whole Git Data API -- blobs and trees included, not just the ref lookup
// -- answers 409 "Git Repository is empty." until a repo has a commit, so the
// batched path cannot bootstrap itself. The Contents API is the one write that
// works on a zero-commit repo, and it will create a branch of any name there.
//
// This is verified against the real API by `npm run test:github`, not inferred
// from the docs: an earlier version of this fix handled the 409 on the ref
// lookup and then died on the very next call, because a mock that agreed with
// our assumptions could not tell us the assumption was wrong.
//
// Bootstrapping leaves a commit we don't want in the history, so when there is
// more than one file the real tree is committed *parentless* and the branch is
// force-moved onto it -- discarding the bootstrap commit rather than leaving a
// two-commit history whose first commit is an artifact of GitHub's API. Safe
// only because the repo provably had no commits a moment ago, which is exactly
// the condition this function is reached under.
async function initialCommit(
  owner: string,
  repo: string,
  files: { path: string; content: string }[],
  message: string,
  branch: string
) {
  // Bootstrap with a real file rather than a placeholder: if any later step
  // fails, the repo is left holding actual content instead of scaffolding.
  const [first, ...rest] = files;
  const bootstrap = await gh<{ commit: { sha: string } }>(
    `/repos/${owner}/${repo}/contents/${encodePath(first.path)}`,
    { method: "PUT", body: JSON.stringify({ message, content: b64(first.content), branch }) }
  );

  if (rest.length === 0) {
    await realignDefaultBranch(owner, repo, branch);
    return { commitSha: bootstrap.commit.sha, filesCommitted: 1, initialCommit: true };
  }

  const tree = await uploadTree(owner, repo, files);
  const commit = await gh<{ sha: string }>(`/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [] }),
  });
  await gh(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });

  await realignDefaultBranch(owner, repo, branch);
  return { commitSha: commit.sha, filesCommitted: files.length, initialCommit: true };
}

// An empty repo still carries a `default_branch` in its metadata (whatever the
// account default is), and it does not follow the first branch created. Left
// alone, committing to 'master' on a main-defaulted repo yields a repo whose
// front page shows an empty 'main' -- indistinguishable, to the human opening
// the link, from the empty-repo bug this file now fixes.
async function realignDefaultBranch(owner: string, repo: string, branch: string) {
  try {
    const info = await gh<{ default_branch: string }>(`/repos/${owner}/${repo}`);
    if (info.default_branch === branch) return;
    await gh(`/repos/${owner}/${repo}`, { method: "PATCH", body: JSON.stringify({ default_branch: branch }) });
  } catch {
    // Cosmetic alignment -- the commit already landed, so never fail the write
    // (and never report failure) over the repo's front-page pointer.
  }
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
