// src/tools/web.ts
//
// WebSearch and WebFetch. Both were Claude Code built-ins and both disappeared with
// the Agent SDK, so this file is their replacement -- and unlike the originals they
// work identically whichever provider is driving the loop.
//
// WebFetch is always registered. WebSearch is registered only when the operator's
// search mode is an HTTP provider (tavily/brave); in "native" mode the model's own
// provider does the searching and there is no local tool to register, and in "none"
// mode there is no search at all. Either way "WebSearch" stays a valid entry in a
// proposal's required_tools -- agent-loop.ts reads the grant and turns on the
// provider's native search instead of a tool call.

import { z } from "zod";
import { getSearchConfig } from "../search/index.js";
import { defineTool, type ToolDefinition } from "./registry.js";

/** Fetched pages are truncated so one enormous page can't blow out the context window. */
const DEFAULT_FETCH_CHARS = Number(process.env.AGENT_WEBFETCH_MAX_CHARS ?? 20_000);
/**
 * The markup skeleton gets its own, larger default. The prose limit is sized for "read
 * this page and summarise it"; a skeleton is read to answer a question *about the whole
 * document* -- which elements have no accessible name, whether the heading levels skip --
 * and a document cut off a third of the way through answers that wrongly rather than
 * partially. Sized against a real target: ellos.se is 1.1 MB of HTML and 40 KB of skeleton.
 */
const DEFAULT_MARKUP_CHARS = 60_000;
const FETCH_TIMEOUT_MS = Number(process.env.AGENT_WEBFETCH_TIMEOUT_MS ?? 20_000);
const USER_AGENT = process.env.AGENT_USER_AGENT ?? "ReflexLoop/1.0 (+autonomous research agent)";

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/**
 * Deliberately a regex pass rather than a DOM parser: the model only needs readable prose,
 * and a real parser would be a dependency (plus a per-fetch cost) for output it would
 * summarise into a research note anyway.
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      // Whole elements whose text content is never prose.
      .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      // Block-level boundaries become line breaks so structure survives tag stripping.
      .replace(/<\/?(p|div|section|article|header|footer|tr|ul|ol|table|h[1-6]|blockquote|pre)\b[^>]*>/gi, "\n")
      .replace(/<br\b[^>]*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/**
 * Elements the skeleton keeps. Everything else is layout scaffolding -- a <div> with no
 * role says nothing about whether a page is usable with a screen reader, and dropping it
 * is most of why the output is 4% of the input.
 */
const STRUCTURAL_TAGS =
  /^(html|head|title|body|main|nav|header|footer|aside|section|article|form|fieldset|legend|label|input|select|option|optgroup|textarea|button|a|img|svg|video|audio|track|table|thead|tbody|tr|th|td|caption|h[1-6]|ul|ol|li|dl|dt|dd|iframe|dialog|details|summary|figure|figcaption)$/i;

/**
 * Attributes the skeleton keeps: the ones an accessibility failure is *defined* by. Note
 * what's missing -- `class` and `style` are where most of a modern page's bytes live and
 * neither answers a WCAG question on its own -- nor does `srcset`, which on a real shop
 * front page is 17% of the output on its own.
 */
const A11Y_ATTRIBUTES =
  /^(aria-[a-z-]+|role|alt|for|id|name|type|title|lang|dir|placeholder|tabindex|hidden|href|src|value|required|disabled|readonly|checked|selected|multiple|controls|autoplay|muted|colspan|rowspan|headers|scope|target|rel|open|width|height|poster|maxlength|autocomplete|inputmode|contenteditable|draggable)$/i;

/** Tags that never take a closing tag, so they must not open an indent level. */
const VOID_TAGS = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;

const MAX_ATTR_CHARS = 80;
const MAX_INLINE_TEXT_CHARS = 60;
/**
 * Indentation is one space per level, capped. Two spaces per level was measured at 31% of
 * the whole output on a real shop's front page -- a page nests 30-odd elements deep and
 * every line pays for it, while nothing past the first couple of dozen levels is telling
 * you anything the tag order didn't.
 */
const MAX_INDENT_DEPTH = 24;

function indent(depth: number): string {
  return " ".repeat(Math.min(depth, MAX_INDENT_DEPTH));
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

/**
 * An indented outline of a page's markup: which elements exist, in what nesting, with the
 * attributes that decide whether they are accessible -- and none of the prose, styling or
 * scripting.
 *
 * This is what htmlToText cannot answer. Stripping markup is right for "what does this page
 * say" and useless for "does this page have 71 images with no alt text", which is the
 * question an accessibility audit is made of. Returning the raw source instead would be no
 * better: a real shop's front page is over a megabyte, so the model would get the first few
 * percent of it and no way to know what it hadn't seen. Measured on ellos.se: 1 138 538
 * characters of HTML in, 40 218 of skeleton out -- and 71 of its 117 images have no alt
 * attribute, which is the kind of finding neither of the other two formats can produce.
 *
 * Same regex-over-parser trade as htmlToText, and the same limits follow from it -- it sees
 * what the server sent, so a client-rendered page shows little, and an unbalanced closing
 * tag skews the indentation after it without changing which elements are listed.
 */
export function htmlToMarkup(html: string): string {
  const cleaned = html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");

  const lines: string[] = [];
  let depth = 0;
  // An attribute value can contain ">" (a URL, a title), so a tag body is matched as quoted
  // runs or plain characters rather than "everything up to the next >".
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)\/?>/g;
  const attrPattern = /([a-zA-Z_:][-\w:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

  for (const match of cleaned.matchAll(tagPattern)) {
    const [raw, closing, rawTag, rawAttrs] = match;
    const tag = rawTag.toLowerCase();
    if (!STRUCTURAL_TAGS.test(tag)) continue;

    if (closing) {
      depth = Math.max(0, depth - 1);
      lines.push(`${indent(depth)}</${tag}>`);
      continue;
    }

    const attrs: string[] = [];
    for (const attr of rawAttrs.matchAll(attrPattern)) {
      const name = attr[1].toLowerCase();
      if (!A11Y_ATTRIBUTES.test(name)) continue;
      const value = attr[3] ?? attr[4] ?? attr[5];
      // A bare attribute (`required`, `hidden`) is written back as itself. `alt=""` and a
      // missing alt are different failures, so both have to survive to the output.
      attrs.push(value === undefined ? name : `${name}="${truncate(decodeEntities(value), MAX_ATTR_CHARS)}"`);
    }

    // The text right after the tag, which is what gives a link, button or heading its
    // accessible name -- an empty <h1> or an icon-only <button> is only visible as a gap here.
    const following = cleaned.slice(match.index + raw.length, match.index + raw.length + 200);
    const text = truncate(
      decodeEntities(following.split("<")[0]).replace(/\s+/g, " ").trim(),
      MAX_INLINE_TEXT_CHARS
    );

    lines.push(
      `${indent(depth)}<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}>${text ? ` ${text}` : ""}`
    );
    if (!VOID_TAGS.test(tag)) depth++;
  }

  return lines.join("\n");
}

/**
 * Blocks a fetch from being pointed at the machine's own network. Exported because the
 * declarative connectors in src/connectors/ resolve their request URLs from a manifest
 * and need the same guarantee -- one check, not two that can drift.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https URLs can be fetched (got ${url.protocol}).`);
  }
  const host = url.hostname.toLowerCase();
  const isLoopback =
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal");
  if (isLoopback) {
    // The console, the SQLite file and any integration tokens all live on this host;
    // a research phase has no legitimate reason to reach them, and a page it read
    // could be what asked it to.
    throw new Error(`Refusing to fetch a private or loopback address (${url.hostname}).`);
  }
  return url;
}

export type FetchFormat = "text" | "markup" | "html";

async function fetchAsText(rawUrl: string, maxChars: number, format: FetchFormat): Promise<string> {
  const url = assertPublicHttpUrl(rawUrl);
  const res = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const body = await res.text();
  const isHtml = contentType.includes("html") || /^\s*<(!doctype|html)/i.test(body);
  // Only HTML has markup to keep or strip. A stylesheet, a JSON feed or a robots.txt comes
  // back verbatim whatever the format asks for -- which is also why reading a stylesheet has
  // always worked, and why only the HTML path needed a way out of htmlToText.
  const text = !isHtml
    ? body.trim()
    : format === "html"
      ? body
      : format === "markup"
        ? htmlToMarkup(body)
        : htmlToText(body);

  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} characters]`;
}

function formatResults(query: string, results: { title: string; url: string; snippet: string }[]): string {
  if (results.length === 0) return `No results for "${query}".`;
  return results
    .map((hit, index) => `${index + 1}. ${hit.title}\n   ${hit.url}\n   ${hit.snippet.replace(/\s+/g, " ").trim()}`)
    .join("\n\n");
}

/**
 * WebFetch always; WebSearch only when an HTTP search provider is configured. The
 * caller adds these to the same registry as the memory and integration tools.
 */
export function buildWebTools(): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    defineTool(
      "WebFetch",
      "Fetch a web page. Use it to read a specific URL you already have -- from a search result, a research note, or a repo. By default it returns readable text with the markup stripped; `format` can return the markup instead, which is what lets you inspect how a page is built rather than what it says. Truncated if the page is very long. Files that aren't HTML (a stylesheet, a JSON feed, robots.txt) always come back verbatim.",
      {
        url: z.string().describe("Absolute http(s) URL to fetch"),
        format: z
          .enum(["text", "markup", "html"])
          .optional()
          .describe(
            "text (default): readable prose, markup stripped -- right for reading a page. " +
              "markup: an indented outline of the page's elements with their accessibility-relevant " +
              "attributes (aria-*, role, alt, for, id, lang, type, href) and no styling or prose -- use " +
              "this to audit structure, e.g. images with no alt, buttons with no accessible name, " +
              "unlabelled form fields, heading order. html: the raw source, which is usually far too " +
              "large to read in one call -- prefer markup unless you need the exact bytes."
          ),
        maxChars: z
          .number()
          .int()
          .positive()
          .max(200_000)
          .optional()
          .describe("Cap on returned characters; defaults to a sensible limit, larger for format=markup"),
      },
      async ({ url, format, maxChars }) => {
        const mode = format ?? "text";
        try {
          return await fetchAsText(
            url,
            maxChars ?? (mode === "text" ? DEFAULT_FETCH_CHARS : DEFAULT_MARKUP_CHARS),
            mode
          );
        } catch (err) {
          return { text: `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }
    ),
  ];

  // WebSearch is registered unconditionally, and resolves its provider inside the handler.
  // It used to be registered only when a search provider existed at startup, which quietly
  // made the search mode a restart-only setting: switching from native to tavily left no
  // tool to call. Whether the model is *offered* WebSearch is decided per run in
  // agent-loop.ts, which is also where native mode is turned on -- one place, read at use.
  tools.push(
    defineTool(
      "WebSearch",
      "Search the web and return ranked results with titles, URLs and snippets. Use it to find sources; follow up with WebFetch to read any result in full.",
      {
        query: z.string().describe("The search query"),
        limit: z.number().int().positive().max(20).optional().describe("Maximum results to return (default 8)"),
      },
      async ({ query, limit }) => {
        const { provider } = getSearchConfig();
        if (!provider) {
          return { text: "Error: web search is not configured. Use WebFetch on a known URL instead.", isError: true };
        }
        try {
          return formatResults(query, await provider.search(query, limit ?? 8));
        } catch (err) {
          return { text: `Error searching for "${query}": ${err instanceof Error ? err.message : String(err)}`, isError: true };
        }
      }
    )
  );

  return tools;
}
