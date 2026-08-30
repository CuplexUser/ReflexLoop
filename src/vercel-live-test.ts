// Live end-to-end check of the Vercel deploy-from-repo path, against both real APIs.
//
//   npm run test:vercel
//
// Opt-in and never part of `npm test`: it needs a real VERCEL_TOKEN *and* a real
// GITHUB_TOKEN, and it creates (and deletes) a throwaway private repo, a Vercel
// project and its deployments.
//
// vercel.test.ts proves the file-selection logic is right; this proves the two
// APIs agree with what we think they do. That split is not ceremony -- the same
// pair on the GitHub side is what caught the empty-repo bug, where a mock agreed
// with our wrong belief right up until the real API didn't. Everything specific
// to this path is a belief about somebody else's service: that /v2/files takes a
// sha1 digest and an octet-stream body, that a deployment can reference an
// uploaded blob by sha, that skipAutoDetectionConfirmation stops a package.json
// in the tree turning into a 400, and that what lands is actually served.
//
// The last check is the one that matters most. Every earlier step can report
// success while the site serves nothing -- which is the exact failure the whole
// act-verification layer exists to catch -- so this fetches the deployment URL
// and asserts the bytes committed to the repo come back out of it.
//
// Cleanup needs the `delete_repo` scope on the GitHub token. Whatever survives
// is printed with a link, loudly, rather than swallowed.

import "dotenv/config";
import { createRepo, commitFiles, githubAvailable } from "./integrations/github.js";
import { deploy, listDeployments, deleteDeployment, vercelAvailable } from "./integrations/vercel.js";

// Deliberately local to this file rather than added to integrations/*.ts: those
// modules are what integrations-server.ts turns into model-callable tools, and a
// delete-the-project function living there is one wiring mistake away from being
// one. Nothing the agent can reach should be able to delete a repo or a project.
async function apiLocal<T>(base: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(base.includes("github") ? { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? (null as T) : ((await res.json()) as T);
}

const gh = <T>(path: string, init?: RequestInit) =>
  apiLocal<T>("https://api.github.com", process.env.GITHUB_TOKEN!, path, init);
const vc = <T>(path: string, init?: RequestInit) =>
  apiLocal<T>("https://api.vercel.com", process.env.VERCEL_TOKEN!, path, init);

let createdRepo: string | null = null;
let createdProject: string | null = null;
let failures = 0;

function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail === undefined ? "" : ` -- got ${JSON.stringify(detail)}`}`);
  }
}

/**
 * A site big enough to be the case that motivated this: more files than a single
 * tool call could carry inline, plus a package.json (which is what would trip
 * Vercel's framework-detection confirmation) and a subdirectory to prove the
 * `directory` prefix is stripped rather than served one level down.
 */
function siteFiles(marker: string) {
  const pages = Array.from({ length: 12 }, (_, i) => ({
    path: `public/page-${i + 1}.html`,
    content: `<!doctype html><title>Page ${i + 1}</title><h1>Page ${i + 1}</h1>\n`,
  }));
  return [
    { path: "public/index.html", content: `<!doctype html><title>live check</title><h1>${marker}</h1>\n` },
    { path: "public/styles.css", content: "body{font-family:system-ui;margin:2rem}\n" },
    { path: "public/assets/app.js", content: `console.log(${JSON.stringify(marker)})\n` },
    // Not under public/: it must NOT be deployed, and its presence is what makes
    // skipAutoDetectionConfirmation load-bearing rather than decorative.
    { path: "package.json", content: '{"name":"reflexloop-live-check","private":true}\n' },
    { path: "README.md", content: "# Throwaway. Created by npm run test:vercel.\n" },
    ...pages,
  ];
}

async function main() {
  if (!githubAvailable || !vercelAvailable) {
    console.error(
      `Missing credentials -- this test needs both. GITHUB_TOKEN: ${githubAvailable ? "set" : "MISSING"}, VERCEL_TOKEN: ${
        vercelAvailable ? "set" : "MISSING"
      }.`
    );
    process.exit(1);
  }

  const owner = (await gh<{ login: string }>("/user")).login;
  const stamp = Date.now();
  const marker = `reflexloop-live-${stamp}`;
  const name = `reflexloop-vercel-check-${stamp}`;
  console.log(`Authenticated as ${owner}\n`);

  // ---- 1. commit the site across several calls ------------------------------
  // The point of the whole change: commits are additive, so the site is built up
  // over as many calls as it takes and none of them has to carry the whole thing.
  console.log("1. build the repo over multiple commits");
  const repo = await createRepo(name, "Throwaway repo from npm run test:vercel. Safe to delete.");
  createdRepo = repo.fullName;
  console.log(`  repo  ${repo.url}`);

  const files = siteFiles(marker);
  const batches = [files.slice(0, 5), files.slice(5, 11), files.slice(11)];
  for (const [i, batch] of batches.entries()) {
    const result = await commitFiles(owner, name, batch, `feat: part ${i + 1}`, "main");
    check(`commit ${i + 1} landed ${batch.length} file(s)`, result.filesCommitted === batch.length, result);
  }

  // ---- 2. deploy from the repo ----------------------------------------------
  console.log("\n2. deploy from the repo (no file content in the call)");
  createdProject = name;
  const deployed = await deploy(name, { repo: { owner, repo: name, directory: "public" } }, "production");
  console.log(`  url   ${deployed.url}`);

  check("deployment reached READY", deployed.status === "READY", deployed.status);
  check("reports the repo it deployed from", deployed.source.startsWith(`${owner}/${name}@`), deployed.source);
  // 15 files live under public/; package.json and README.md are outside it.
  check("deployed only the scoped subtree", deployed.filesDeployed === 15, deployed.filesDeployed);
  check("reports a non-zero byte count", deployed.bytes > 0, deployed.bytes);

  // ---- 3. what is actually served -------------------------------------------
  // Every step above can succeed while the site serves nothing. This is the check
  // that distinguishes "deployed" from "shipped".
  console.log("\n3. fetch the live site");
  const root = await fetch(deployed.url);
  check("root responds 200", root.status === 200, root.status);
  const body = await root.text();
  check("root serves the committed index.html (directory prefix stripped)", body.includes(marker), body.slice(0, 200));

  const nested = await fetch(`${deployed.url}/assets/app.js`);
  check("nested asset is served", nested.status === 200, nested.status);

  const excluded = await fetch(`${deployed.url}/package.json`);
  check("a file outside the directory is not served", excluded.status === 404, excluded.status);

  // ---- 4. re-deploy supersedes rather than accumulates -----------------------
  console.log("\n4. re-deploy the same project and target");
  await commitFiles(
    owner,
    name,
    [{ path: "public/index.html", content: `<!doctype html><title>live check</title><h1>${marker}-v2</h1>\n` }],
    "feat: update",
    "main"
  );
  const second = await deploy(name, { repo: { owner, repo: name, directory: "public" } }, "production");
  check("second deployment reached READY", second.status === "READY", second.status);
  check("deleted the deployment it replaced", second.removedDeployments.length >= 1, second.removedDeployments);
  check("no cleanup problem reported", second.cleanup === null, second.cleanup);

  const updated = await fetch(second.url);
  check("the new content is what is served", (await updated.text()).includes(`${marker}-v2`), second.url);
}

async function cleanup() {
  console.log("\ncleanup");
  const survivors: string[] = [];

  if (createdProject) {
    try {
      for (const d of await listDeployments(createdProject)) await deleteDeployment(d.id);
      await vc(`/v9/projects/${encodeURIComponent(createdProject)}`, { method: "DELETE" });
      console.log(`  deleted vercel project ${createdProject}`);
    } catch (err) {
      survivors.push(`https://vercel.com/dashboard (project ${createdProject}): ${message(err)}`);
    }
  }
  if (createdRepo) {
    try {
      await gh(`/repos/${createdRepo}`, { method: "DELETE" });
      console.log(`  deleted repo ${createdRepo}`);
    } catch (err) {
      survivors.push(`https://github.com/${createdRepo}/settings (needs the 'delete_repo' scope): ${message(err)}`);
    }
  }

  if (survivors.length) {
    console.error(`\nDelete these by hand:\n${survivors.map((s) => `  ${s}`).join("\n")}`);
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

main()
  .catch((err) => {
    failures++;
    console.error(`\nAborted: ${err instanceof Error ? err.stack : String(err)}`);
  })
  .then(cleanup)
  .then(() => {
    console.log(failures === 0 ? "\nVERCEL LIVE TEST OK" : `\nVERCEL LIVE TEST FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  });
