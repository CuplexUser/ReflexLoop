// Live end-to-end check of the GitHub write path, against the real API.
//
//   npm run test:github
//
// Opt-in and never part of `npm test`: it needs a real GITHUB_TOKEN and it
// creates (and deletes) throwaway private repos on the authenticated account.
// github.test.ts proves our branching is right; this proves GitHub agrees with
// what we think it does -- the two together are what "tested" means here,
// because the bug in proposal #22 was our code holding a wrong belief about
// the API's behaviour on an empty repo, which no self-consistent mock catches.
//
// Cleanup needs the `delete_repo` scope. Without it the repos survive and
// their URLs are printed at the end for manual deletion; that is reported
// loudly rather than swallowed.

import "dotenv/config";
import { createRepo, commitFiles, readFile, readRepo, githubAvailable } from "./integrations/github.js";

// Deliberately local to this file rather than added to integrations/github.ts:
// that module is what integrations-server.ts turns into model-callable tools,
// and a repo-deletion function living there is one wiring mistake away from
// being one. Nothing the agent can reach should be able to delete a repo.
async function ghLocal<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? (null as T) : ((await res.json()) as T);
}

const getAuthenticatedLogin = async () => (await ghLocal<{ login: string }>("/user")).login;
const deleteRepo = (owner: string, repo: string) => ghLocal(`/repos/${owner}/${repo}`, { method: "DELETE" });

const created: string[] = [];
let failures = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail === undefined ? "" : ` -- got ${JSON.stringify(detail)}`}`);
  }
}

async function expectRejection(label: string, fn: () => Promise<unknown>, pattern: RegExp) {
  try {
    await fn();
    check(label, false, "resolved, expected a rejection");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    check(label, pattern.test(message), message);
  }
}

async function makeRepo(suffix: string) {
  const name = `reflexloop-github-check-${Date.now()}-${suffix}`;
  const repo = await createRepo(name, "Throwaway repo from npm run test:github. Safe to delete.", true);
  created.push(repo.fullName);
  console.log(`  repo  ${repo.url}`);
  return name;
}

async function main() {
  if (!githubAvailable) {
    console.error("GITHUB_TOKEN is not set -- nothing to test against. Set it in .env and re-run.");
    process.exit(1);
  }

  const owner = await getAuthenticatedLogin();
  console.log(`Authenticated as ${owner}\n`);

  // ---- 1. create a repo, then commit straight into it -----------------------
  // This exact sequence is what failed four times in proposal #22.
  console.log("1. commit into a freshly created (empty) repo");
  const repo1 = await makeRepo("a");
  const first = await commitFiles(
    owner,
    repo1,
    [
      { path: "index.html", content: "<h1>hej</h1>\n" },
      { path: "README.md", content: "# räntefördelning 8,55 %\n" },
    ],
    "feat: initial commit",
    "main"
  );
  check("reported as an initial commit", first.initialCommit === true, first);
  check("committed both files", first.filesCommitted === 2, first);

  const html = await readFile(owner, repo1, "index.html");
  check("index.html reads back with its content", html.content === "<h1>hej</h1>\n", html.content);
  const readme = await readFile(owner, repo1, "README.md");
  check("non-ASCII survives the round trip", readme.content === "# räntefördelning 8,55 %\n", readme.content);

  // ---- 2. a second commit on the now-populated repo -------------------------
  console.log("\n2. second commit on the same branch");
  const second = await commitFiles(
    owner,
    repo1,
    [
      { path: "index.html", content: "<h1>hej igen</h1>\n" },
      { path: "calc.js", content: "console.log(1)\n" },
    ],
    "feat: update",
    "main"
  );
  check("not reported as an initial commit", second.initialCommit === false, second);
  check("parented to a different commit", second.commitSha !== first.commitSha);

  const updated = await readFile(owner, repo1, "index.html");
  check("updated file reflects the new content", updated.content === "<h1>hej igen</h1>\n", updated.content);
  const preserved = await readFile(owner, repo1, "README.md");
  check("untouched file survives (base_tree was applied)", preserved.content.startsWith("# rä"), preserved.content);

  // ---- 3. a branch that does not exist on a non-empty repo ------------------
  console.log("\n3. missing branch on a repo that has commits");
  await expectRejection(
    "refuses instead of creating an orphan branch",
    () => commitFiles(owner, repo1, [{ path: "x.txt", content: "x" }], "nope", "no-such-branch"),
    /does not exist/
  );
  await expectRejection(
    "names the branches that do exist",
    () => commitFiles(owner, repo1, [{ path: "x.txt", content: "x" }], "nope", "no-such-branch"),
    /Existing branches:.*main/
  );

  // ---- 4. initial commit onto a non-default branch name ---------------------
  // The agent retried on 'master' after 'main' failed; the repo's front page
  // must end up pointing at whatever branch actually received the commit.
  console.log("\n4. initial commit on 'master' when the repo defaults to 'main'");
  const repo2 = await makeRepo("b");
  const onMaster = await commitFiles(
    owner,
    repo2,
    [{ path: "README.md", content: "# on master\n" }],
    "feat: initial commit",
    "master"
  );
  check("reported as an initial commit", onMaster.initialCommit === true, onMaster);
  const info = await readRepo(owner, repo2);
  check("default branch follows the first commit", info.defaultBranch === "master", info.defaultBranch);
  const onMasterFile = await readFile(owner, repo2, "README.md");
  check("file is readable at the repo default", onMasterFile.content === "# on master\n", onMasterFile.content);
}

async function cleanup() {
  if (created.length === 0) return;
  console.log("\ncleanup");
  const survivors: string[] = [];
  for (const fullName of created) {
    const [owner, repo] = fullName.split("/");
    try {
      await deleteRepo(owner, repo);
      console.log(`  deleted ${fullName}`);
    } catch (err) {
      survivors.push(fullName);
      console.error(`  could not delete ${fullName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (survivors.length) {
    console.error(
      `\nDelete these by hand (the token likely lacks the 'delete_repo' scope):\n` +
        survivors.map((s) => `  https://github.com/${s}/settings`).join("\n")
    );
  }
}

main()
  .catch((err) => {
    failures++;
    console.error(`\nAborted: ${err instanceof Error ? err.stack : String(err)}`);
  })
  .then(cleanup)
  .then(() => {
    console.log(failures === 0 ? "\nGITHUB LIVE TEST OK" : `\nGITHUB LIVE TEST FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  });
