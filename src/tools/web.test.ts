import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSearchConfig } from "../search/index.js";
import { resetSettings } from "../settings.js";
import { buildWebTools, htmlToText } from "./web.js";
import { ToolRegistry } from "./registry.js";

beforeEach(() => {
  // The search mode is a setting now, and settings.ts seeds itself from the environment on
  // first read and then holds that value -- correct in production, where env doesn't change
  // mid-process, but it means a later vi.stubEnv would otherwise be ignored. Reset both
  // caches, in this order: the search config's own cache keys off the setting.
  vi.unstubAllEnvs();
  resetSettings();
  resetSearchConfig();
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
  // Registration used to be conditional on a search provider existing at startup, which
  // quietly made the search mode restart-only: switching from native to tavily left no tool
  // to call. Both tools are now always registered and the *mode* is read at use -- whether
  // WebSearch is described to the model is decided per run in agent-loop.ts.
  it("registers both tools whatever the search mode", () => {
    vi.stubEnv("AGENT_SEARCH_PROVIDER", "none");
    expect(buildWebTools().map((t) => t.name).sort()).toEqual(["WebFetch", "WebSearch"]);

    vi.stubEnv("AGENT_SEARCH_PROVIDER", "native");
    expect(buildWebTools().map((t) => t.name).sort()).toEqual(["WebFetch", "WebSearch"]);

    vi.stubEnv("AGENT_SEARCH_PROVIDER", "tavily");
    vi.stubEnv("TAVILY_API_KEY", "test-key");
    expect(buildWebTools().map((t) => t.name).sort()).toEqual(["WebFetch", "WebSearch"]);
  });

  it("reports in band when WebSearch is called with no HTTP provider behind it", async () => {
    vi.stubEnv("AGENT_SEARCH_PROVIDER", "none");
    const registry = new ToolRegistry(buildWebTools());
    const result = await registry.invoke("WebSearch", { query: "anything" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not configured");
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
