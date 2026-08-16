// Covers commitFiles' base-resolution branching -- the logic that decides
// whether a write is an initial commit, a fast-forward, or an error.
//
// This is deliberately not a wire-format mock of the kind CLAUDE.md argues
// against for the LLM adapters. What's under test is *our* control flow across
// three states GitHub reports with three different statuses, and the bug it
// exists to prevent (proposal #22: repo created, four commit attempts, all
// 409, nothing landed, reported as unrecoverable) was a branching bug, not a
// serialization one. The request bodies are asserted because "which commit did
// we parent this to" is exactly what went wrong.

import { describe, it, expect, beforeEach, vi } from "vitest";

process.env.GITHUB_TOKEN = "test-token";
const { commitFiles, GithubApiError } = await import("./github.js");

const API = "https://api.github.com";

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

type Handler = (body: Record<string, unknown> | null) => { status?: number; json?: unknown };

let calls: Call[];
let routes: Record<string, Handler>;

/** Registers `METHOD /path` handlers; anything unrouted fails the test loudly. */
function route(table: Record<string, Handler>) {
  routes = table;
}

function calledPaths() {
  return calls.map((c) => `${c.method} ${c.path}`);
}

function bodyOf(method: string, path: string) {
  const call = calls.find((c) => c.method === method && c.path === path);
  if (!call) throw new Error(`no ${method} ${path} in: ${calledPaths().join(" | ")}`);
  return call.body;
}

beforeEach(() => {
  calls = [];
  routes = {};
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const path = String(url).slice(API.length);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, path, body });

    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unrouted request: ${method} ${path}`);
    const { status = 200, json = {} } = handler(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
    } as Response;
  });
});

const FILES = [
  { path: "index.html", content: "<h1>hi</h1>" },
  { path: "calc.js", content: "console.log(1)" },
];

/** The blob/tree/commit legs, which are identical in every scenario. */
function writeRoutes() {
  let blob = 0;
  return {
    "POST /repos/o/r/git/blobs": () => ({ json: { sha: `blob${++blob}` } }),
    "POST /repos/o/r/git/trees": () => ({ json: { sha: "tree-new" } }),
    "POST /repos/o/r/git/commits": () => ({ json: { sha: "commit-new" } }),
  };
}

describe("commitFiles on a repo that already has commits", () => {
  it("builds on the branch tip and fast-forwards the ref", async () => {
    route({
      "GET /repos/o/r/git/ref/heads/main": () => ({ json: { object: { sha: "base-commit" } } }),
      "GET /repos/o/r/git/commits/base-commit": () => ({ json: { tree: { sha: "base-tree" } } }),
      ...writeRoutes(),
      "PATCH /repos/o/r/git/refs/heads/main": () => ({ json: {} }),
    });

    const result = await commitFiles("o", "r", FILES, "msg", "main");

    expect(result).toEqual({ commitSha: "commit-new", filesCommitted: 2, initialCommit: false });
    expect(bodyOf("POST", "/repos/o/r/git/trees")).toMatchObject({ base_tree: "base-tree" });
    expect(bodyOf("POST", "/repos/o/r/git/commits")).toMatchObject({ parents: ["base-commit"] });
    expect(bodyOf("PATCH", "/repos/o/r/git/refs/heads/main")).toEqual({ sha: "commit-new" });
    // The repo's default branch is never touched on this path.
    expect(calledPaths()).not.toContain("PATCH /repos/o/r");
  });

  it("uploads one blob per file and writes them as a single commit", async () => {
    route({
      "GET /repos/o/r/git/ref/heads/main": () => ({ json: { object: { sha: "base-commit" } } }),
      "GET /repos/o/r/git/commits/base-commit": () => ({ json: { tree: { sha: "base-tree" } } }),
      ...writeRoutes(),
      "PATCH /repos/o/r/git/refs/heads/main": () => ({ json: {} }),
    });

    await commitFiles("o", "r", FILES, "msg", "main");

    expect(calls.filter((c) => c.path === "/repos/o/r/git/blobs")).toHaveLength(2);
    expect(calls.filter((c) => c.path === "/repos/o/r/git/commits" && c.method === "POST")).toHaveLength(1);
    expect(bodyOf("POST", "/repos/o/r/git/trees")).toMatchObject({
      tree: [
        { path: "index.html", mode: "100644", type: "blob", sha: "blob1" },
        { path: "calc.js", mode: "100644", type: "blob", sha: "blob2" },
      ],
    });
  });

  it("base64-encodes content, so non-ASCII survives the round trip", async () => {
    route({
      "GET /repos/o/r/git/ref/heads/main": () => ({ json: { object: { sha: "base-commit" } } }),
      "GET /repos/o/r/git/commits/base-commit": () => ({ json: { tree: { sha: "base-tree" } } }),
      ...writeRoutes(),
      "PATCH /repos/o/r/git/refs/heads/main": () => ({ json: {} }),
    });

    await commitFiles("o", "r", [{ path: "a.md", content: "räntefördelning — 8,55 %" }], "msg", "main");

    const blob = calls.find((c) => c.path === "/repos/o/r/git/blobs")!.body!;
    expect(blob.encoding).toBe("base64");
    expect(Buffer.from(String(blob.content), "base64").toString("utf8")).toBe("räntefördelning — 8,55 %");
  });
});

describe("commitFiles on an empty repo (the proposal #22 failure)", () => {
  const emptyRepo = () => ({ status: 409, json: { message: "Git Repository is empty." } });

  // A zero-commit repo rejects the whole Git Data API, not just the ref lookup,
  // so the only legal first write is through the Contents API. These routes
  // deliberately 409 the blob endpoint the way the live API does -- an earlier
  // version of this fix passed a mock that allowed blobs and failed for real.
  const emptyRepoRoutes = (branch: string) => ({
    [`GET /repos/o/r/git/ref/heads/${branch}`]: emptyRepo,
    "POST /repos/o/r/git/blobs": emptyRepo,
  });

  const bootstrapped = () => ({
    "PUT /repos/o/r/contents/index.html": () => ({ status: 201, json: { commit: { sha: "bootstrap-commit" } } }),
  });

  it("bootstraps through the Contents API instead of 409ing on blobs", async () => {
    route({
      ...emptyRepoRoutes("main"),
      ...bootstrapped(),
      ...writeRoutes(), // overrides the 409 blob route: valid once bootstrapped
      "PATCH /repos/o/r/git/refs/heads/main": () => ({ json: {} }),
      "GET /repos/o/r": () => ({ json: { default_branch: "main" } }),
    });

    const result = await commitFiles("o", "r", FILES, "initial", "main");

    expect(result).toEqual({ commitSha: "commit-new", filesCommitted: 2, initialCommit: true });
    // The bootstrap carries the first real file, not a placeholder, so a later
    // failure still leaves the repo holding content.
    const put = bodyOf("PUT", "/repos/o/r/contents/index.html")!;
    expect(Buffer.from(String(put.content), "base64").toString("utf8")).toBe("<h1>hi</h1>");
    expect(put.branch).toBe("main");
  });

  it("collapses the bootstrap into a single parentless commit", async () => {
    route({
      ...emptyRepoRoutes("main"),
      ...bootstrapped(),
      ...writeRoutes(),
      "PATCH /repos/o/r/git/refs/heads/main": () => ({ json: {} }),
      "GET /repos/o/r": () => ({ json: { default_branch: "main" } }),
    });

    await commitFiles("o", "r", FILES, "initial", "main");

    // No base tree, no parent, and the ref is force-moved off the bootstrap --
    // otherwise the history keeps a commit that is an artifact of the API.
    expect(bodyOf("POST", "/repos/o/r/git/trees")).not.toHaveProperty("base_tree");
    expect(bodyOf("POST", "/repos/o/r/git/commits")).toMatchObject({ parents: [] });
    expect(bodyOf("PATCH", "/repos/o/r/git/refs/heads/main")).toEqual({ sha: "commit-new", force: true });
  });

  it("skips the rewrite when there is only one file to commit", async () => {
    route({
      ...emptyRepoRoutes("main"),
      "PUT /repos/o/r/contents/only.md": () => ({ status: 201, json: { commit: { sha: "bootstrap-commit" } } }),
      "GET /repos/o/r": () => ({ json: { default_branch: "main" } }),
    });

    const result = await commitFiles("o", "r", [{ path: "only.md", content: "# hi" }], "initial", "main");

    // The bootstrap *is* the commit; a second parentless one would be pure cost.
    expect(result).toEqual({ commitSha: "bootstrap-commit", filesCommitted: 1, initialCommit: true });
    expect(calledPaths()).not.toContain("POST /repos/o/r/git/commits");
  });

  it("escapes path segments when bootstrapping", async () => {
    route({
      ...emptyRepoRoutes("main"),
      "PUT /repos/o/r/contents/docs/my%20file.md": () => ({ status: 201, json: { commit: { sha: "c" } } }),
      "GET /repos/o/r": () => ({ json: { default_branch: "main" } }),
    });

    await commitFiles("o", "r", [{ path: "docs/my file.md", content: "x" }], "initial", "main");

    // The slash stays structural; only the segment is escaped.
    expect(calledPaths()).toContain("PUT /repos/o/r/contents/docs/my%20file.md");
  });

  it("repoints the default branch when the first commit lands elsewhere", async () => {
    route({
      ...emptyRepoRoutes("master"),
      ...bootstrapped(),
      ...writeRoutes(),
      "PATCH /repos/o/r/git/refs/heads/master": () => ({ json: {} }),
      "GET /repos/o/r": () => ({ json: { default_branch: "main" } }),
      "PATCH /repos/o/r": () => ({ json: {} }),
    });

    await commitFiles("o", "r", FILES, "initial", "master");

    expect(bodyOf("PATCH", "/repos/o/r")).toEqual({ default_branch: "master" });
  });

  it("leaves the default branch alone when it already matches", async () => {
    route({
      ...emptyRepoRoutes("main"),
      ...bootstrapped(),
      ...writeRoutes(),
      "PATCH /repos/o/r/git/refs/heads/main": () => ({ json: {} }),
      "GET /repos/o/r": () => ({ json: { default_branch: "main" } }),
    });

    await commitFiles("o", "r", FILES, "initial", "main");

    expect(calledPaths()).not.toContain("PATCH /repos/o/r");
  });

  it("still reports success if realigning the default branch fails", async () => {
    route({
      ...emptyRepoRoutes("master"),
      ...bootstrapped(),
      ...writeRoutes(),
      "PATCH /repos/o/r/git/refs/heads/master": () => ({ json: {} }),
      "GET /repos/o/r": () => ({ status: 403, json: { message: "no admin rights" } }),
    });

    // The commit landed; the front-page pointer is cosmetic and must not
    // turn a successful write into a reported failure.
    await expect(commitFiles("o", "r", FILES, "initial", "master")).resolves.toMatchObject({
      commitSha: "commit-new",
      initialCommit: true,
    });
  });
});

describe("commitFiles when the branch is missing but the repo is not empty", () => {
  it("refuses rather than creating an orphan branch", async () => {
    route({
      "GET /repos/o/r/git/ref/heads/master": () => ({ status: 404, json: { message: "Not Found" } }),
      "GET /repos/o/r/branches?per_page=100": () => ({ json: [{ name: "main" }, { name: "dev" }] }),
    });

    await expect(commitFiles("o", "r", FILES, "msg", "master")).rejects.toThrow(
      /Branch 'master' does not exist.*Existing branches: main, dev/s
    );

    // Nothing was written -- no blobs, no commit, no ref.
    expect(calledPaths()).toEqual([
      "GET /repos/o/r/git/ref/heads/master",
      "GET /repos/o/r/branches?per_page=100",
    ]);
  });

  it("still refuses when the branch list itself cannot be fetched", async () => {
    route({
      "GET /repos/o/r/git/ref/heads/master": () => ({ status: 404, json: { message: "Not Found" } }),
      "GET /repos/o/r/branches?per_page=100": () => ({ status: 500, json: { message: "boom" } }),
    });

    await expect(commitFiles("o", "r", FILES, "msg", "master")).rejects.toThrow(
      /Branch 'master' does not exist/
    );
  });
});

describe("error propagation", () => {
  it("surfaces a non-404/409 failure on the ref lookup unchanged", async () => {
    route({
      "GET /repos/o/r/git/ref/heads/main": () => ({ status: 401, json: { message: "Bad credentials" } }),
    });

    await expect(commitFiles("o", "r", FILES, "msg", "main")).rejects.toThrow(GithubApiError);
    await expect(commitFiles("o", "r", FILES, "msg", "main")).rejects.toMatchObject({ status: 401 });
  });

  it("carries the status on GithubApiError so callers can branch on it", () => {
    const err = new GithubApiError(409, "GET", "/x", '{"message":"Git Repository is empty."}');
    expect(err.status).toBe(409);
    expect(err.message).toContain("409");
    expect(err).toBeInstanceOf(Error);
  });
});
