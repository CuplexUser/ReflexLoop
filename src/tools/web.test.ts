import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSearchConfig } from "../search/index.js";
import { buildWebTools, htmlToText } from "./web.js";
import { ToolRegistry } from "./registry.js";

beforeEach(() => {
  // buildWebTools reads the search mode, which is cached after the first call.
  resetSearchConfig();
  vi.unstubAllEnvs();
});

describe("htmlToText", () => {
  it("drops elements whose text content is never prose", () => {
    const text = htmlToText("<p>Keep</p><script>var drop = 1;</script><style>.drop{}</style>");
    expect(text).toBe("Keep");
    expect(text).not.toContain("drop");
  });

  it("separates block elements with a blank line and list items with their own", () => {
    // Open and close tags each contribute a break, so paragraphs end up blank-line
    // separated -- which is what makes the stripped output read as prose.
    expect(htmlToText("<h1>Title</h1><p>One</p><p>Two</p>")).toBe("Title\n\nOne\n\nTwo");
    expect(htmlToText("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
  });

  it("decodes named and numeric entities", () => {
    expect(htmlToText("<p>Tom &amp; Jerry &mdash; &#65;&#x42;</p>")).toBe("Tom & Jerry — AB");
  });

  it("collapses runaway whitespace to at most one blank line", () => {
    expect(htmlToText("<p>a</p>\n\n\n\n\n\n<p>b</p>")).toBe("a\n\nb");
    expect(htmlToText("<p>a   \t   b</p>")).toBe("a b");
  });
});

describe("buildWebTools", () => {
  it("always registers WebFetch", () => {
    vi.stubEnv("AGENT_SEARCH_PROVIDER", "none");
    expect(buildWebTools().map((t) => t.name)).toEqual(["WebFetch"]);
  });

  it("registers WebSearch only when an HTTP search provider is configured", () => {
    vi.stubEnv("AGENT_SEARCH_PROVIDER", "tavily");
    vi.stubEnv("TAVILY_API_KEY", "test-key");
    expect(buildWebTools().map((t) => t.name).sort()).toEqual(["WebFetch", "WebSearch"]);
  });

  it("registers no WebSearch tool in native mode -- the provider searches instead", () => {
    vi.stubEnv("AGENT_SEARCH_PROVIDER", "native");
    expect(buildWebTools().map((t) => t.name)).toEqual(["WebFetch"]);
  });
});

describe("WebFetch", () => {
  const fetchTool = () => {
    vi.stubEnv("AGENT_SEARCH_PROVIDER", "none");
    return new ToolRegistry(buildWebTools());
  };

  it("refuses loopback and private addresses", async () => {
    const registry = fetchTool();
    for (const url of ["http://localhost:4001/api/proposals", "http://127.0.0.1/", "http://192.168.1.5/"]) {
      const result = await registry.invoke("WebFetch", { url });
      expect(result.isError, url).toBe(true);
      expect(result.text, url).toMatch(/private or loopback/);
    }
  });

  it("refuses non-http schemes", async () => {
    const result = await fetchTool().invoke("WebFetch", { url: "file:///etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Only http and https/);
  });
});
