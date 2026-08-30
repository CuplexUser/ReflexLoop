import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetSearchConfig } from "../search/index.js";
import { resetSettings } from "../settings.js";
import { buildWebTools, htmlToMarkup, htmlToText } from "./web.js";
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

// The audit case htmlToText cannot serve: stripping markup answers "what does this page
// say", and an accessibility failure is defined by the markup it strips.
describe("htmlToMarkup", () => {
  it("keeps accessibility attributes and drops styling and prose", () => {
    const markup = htmlToMarkup(
      '<div class="wrapper"><img src="/a.png" class="hero" data-track="x"><p>Some prose</p></div>'
    );
    expect(markup).toContain('<img src="/a.png">');
    expect(markup).not.toContain("wrapper");
    expect(markup).not.toContain("data-track");
    // The <p> isn't structural, so neither it nor its text survives -- read the page as
    // text if the prose is what you're after.
    expect(markup).not.toContain("Some prose");
  });

  it("distinguishes a missing alt from an empty one -- they are different failures", () => {
    const markup = htmlToMarkup('<img src="/a.png"><img src="/b.png" alt=""><img src="/c.png" alt="A cat">');
    const lines = markup.split("\n");
    expect(lines[0]).not.toContain("alt");
    expect(lines[1]).toContain('alt=""');
    expect(lines[2]).toContain('alt="A cat"');
  });

  it("keeps a bare boolean attribute as itself", () => {
    expect(htmlToMarkup('<input type="email" required aria-label="Epost">')).toBe(
      '<input type="email" required aria-label="Epost">'
    );
  });

  it("carries the text right after a tag, so an unnamed control is visible as a gap", () => {
    const markup = htmlToMarkup("<h1></h1><button></button><a href=\"/x\">Till kassan</a>");
    expect(markup.split("\n")).toContain("<h1>");
    expect(markup).toContain('<a href="/x"> Till kassan');
  });

  it("nests structural elements and never lets a void element open a level", () => {
    const markup = htmlToMarkup("<form><label>Namn</label><input><button>Skicka</button></form>");
    expect(markup).toBe(["<form>", " <label> Namn", " </label>", " <input>", " <button> Skicka", " </button>", "</form>"].join("\n"));
  });

  it("survives a > inside an attribute value rather than cutting the tag short", () => {
    expect(htmlToMarkup('<a href="/s?q=a>b" title="x">go</a>')).toContain('href="/s?q=a>b"');
  });

  it("drops script and style bodies, which is where most of a real page's bytes are", () => {
    const markup = htmlToMarkup('<body><script>var a = "<img alt=fake>";</script><style>.a{}</style></body>');
    expect(markup).not.toContain("fake");
    expect(markup).not.toContain(".a{}");
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

  // Three formats over one fetch, so the choice is what the model sees rather than which
  // tool it reached for -- and non-HTML is unaffected by any of them.
  it("returns prose, markup or raw source from the same URL", async () => {
    const page = '<!doctype html><html lang="sv"><body><h1>Rea</h1><img src="/a.png"></body></html>';
    vi.stubGlobal("fetch", async () =>
      new Response(page, { status: 200, headers: { "content-type": "text/html" } })
    );
    const registry = fetchTool();

    const text = await registry.invoke("WebFetch", { url: "https://shop.example/" });
    expect(text.text).toBe("Rea");

    const markup = await registry.invoke("WebFetch", { url: "https://shop.example/", format: "markup" });
    expect(markup.text).toContain('<img src="/a.png">');
    expect(markup.text).toContain('<html lang="sv">');

    const raw = await registry.invoke("WebFetch", { url: "https://shop.example/", format: "html" });
    expect(raw.text).toBe(page);
    vi.unstubAllGlobals();
  });

  it("hands back a stylesheet verbatim whatever format was asked for", async () => {
    const css = ".btn { color: #767676; background: #fff; }";
    vi.stubGlobal("fetch", async () =>
      new Response(css, { status: 200, headers: { "content-type": "text/css" } })
    );
    // Contrast values live in the stylesheet, and reading one has always worked -- it was
    // only the HTML path that needed a way out of htmlToText.
    const result = await fetchTool().invoke("WebFetch", { url: "https://shop.example/a.css", format: "markup" });
    expect(result.text).toBe(css);
    vi.unstubAllGlobals();
  });

  it("refuses non-http schemes", async () => {
    const result = await fetchTool().invoke("WebFetch", { url: "file:///etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Only http and https/);
  });
});
