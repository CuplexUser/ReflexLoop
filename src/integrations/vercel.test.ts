// Covers the pure half of deploying a repo to Vercel: turning a GitHub tree
// listing into the file set a deployment should carry.
//
// Pure functions only, so this needs no token and mocks nobody's wire format --
// the thing worth testing here is which entries we keep and what path each one
// lands at, and both are decided before any request is made. The failure this
// guards is specific: a site deployed one directory down is live, reachable,
// and serves a 404 at its own root.

import { describe, it, expect } from "vitest";
import { selectTreeFiles, type TreeEntry } from "./github.js";

const blob = (path: string, size = 10): TreeEntry => ({ path, type: "blob", sha: `sha-${path}`, size });
const tree = (path: string): TreeEntry => ({ path, type: "tree", sha: `sha-${path}` });

describe("selectTreeFiles", () => {
  it("keeps blobs and drops everything else", () => {
    const entries: TreeEntry[] = [
      blob("index.html"),
      tree("assets"),
      blob("assets/app.js"),
      { path: "vendor/lib", type: "commit", sha: "submodule-sha" },
    ];

    expect(selectTreeFiles(entries).map((f) => f.path)).toEqual(["index.html", "assets/app.js"]);
  });

  it("carries each blob's sha and size through", () => {
    expect(selectTreeFiles([blob("index.html", 4096)])).toEqual([
      { path: "index.html", sha: "sha-index.html", size: 4096 },
    ]);
  });

  it("treats a missing size as zero rather than undefined", () => {
    const entry: TreeEntry = { path: "index.html", type: "blob", sha: "abc" };
    expect(selectTreeFiles([entry])[0].size).toBe(0);
  });

  it("scopes to a directory and strips its prefix, so the subtree serves at the site root", () => {
    const entries = [blob("README.md"), blob("public/index.html"), blob("public/css/site.css"), blob("src/build.ts")];

    expect(selectTreeFiles(entries, "public").map((f) => f.path)).toEqual(["index.html", "css/site.css"]);
  });

  it("normalizes the directory's slashes", () => {
    const entries = [blob("public/index.html")];
    for (const dir of ["public", "public/", "/public", "/public/"]) {
      expect(selectTreeFiles(entries, dir).map((f) => f.path)).toEqual(["index.html"]);
    }
  });

  it("treats an empty directory string as the whole repo", () => {
    const entries = [blob("index.html"), blob("public/index.html")];
    expect(selectTreeFiles(entries, "").map((f) => f.path)).toEqual(["index.html", "public/index.html"]);
  });

  it("does not match a sibling directory that merely shares a prefix", () => {
    // 'public-draft/index.html' starts with 'public' as a string but is a different
    // directory; matching it would deploy an unfinished copy of the site alongside the real one.
    const entries = [blob("public/index.html"), blob("public-draft/index.html")];
    expect(selectTreeFiles(entries, "public").map((f) => f.path)).toEqual(["index.html"]);
  });

  it("returns nothing when the directory does not exist, so the caller can say so", () => {
    expect(selectTreeFiles([blob("index.html")], "public")).toEqual([]);
  });
});
