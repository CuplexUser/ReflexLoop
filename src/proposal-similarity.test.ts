import { describe, expect, it } from "vitest";
import {
  DUPLICATE_THRESHOLD,
  findNearDuplicate,
  similarity,
  stem,
  terms,
} from "./proposal-similarity.js";

// Real proposals from the agent's own history, trimmed to their headline and first bullets.
// #14/#17/#20 are one comparison site proposed three times under three different domain
// strings, two of them pending at the same time -- the case this module exists for.
// #15/#16 are two genuine next steps on one shipped project, which must keep going through.

const P14 = {
  id: 14,
  domain: "comparison site / affiliate",
  description: `**PropertyManagerCompare — a neutral, affiliate-monetized comparison site for property-management software, deployed on Vercel and grown page-by-page across cycles.**

- **What:** Build the first version of a third-party comparison site covering the top property-management software for landlords/property managers (Buildium, DoorLoop, TenantCloud, Avail, TurboTenant, Hemlane). Ship a home page with a side-by-side comparison table (real pricing, key features, best-for), plus one dedicated product page per tool with honest pros/cons and a "visit site" affiliate link.
- **Why now / gap:** Existing comparison content is either vendor-owned and biased or generic aggregators (Capterra/G2/Software Advice). No dominant neutral third-party comparison site exists.
- **Act-phase scope:** Create a public GitHub repo, commit a static HTML/CSS/vanilla-JS site (home + comparison table + 6 product pages + affiliate-link config), deploy to Vercel.`,
};

const P17 = {
  id: 17,
  domain: "affiliate comparison site",
  description: `**PropertyManagementSoftware.review: an affiliate-monetized comparison site for property management software, deployed on Vercel and grown page-by-page**

- Create a new repo \`CuplexUser/pms-compare\` with a single-page static comparison site comparing the top 5-6 property management software tools (Buildium, DoorLoop, TenantCloud, AppFolio, Yardi Breeze, TurboTenant). The page includes a side-by-side feature comparison table, real pricing data, honest pros/cons per tool, and affiliate disclosure.
- Monetization: embed affiliate links to the programs that pay. Buildium pays 25% recurring commission on monthly subscriptions plus a lead bounty via Impact. DoorLoop pays per new subscription and per completed demo.
- Deploy to Vercel as a new project \`pms-compare\` with a clean, professional design optimized for SEO. The site is fully static (vanilla HTML/CSS/JS, no backend needed).`,
};

const P20 = {
  id: 20,
  domain: "comparison directory affiliate site",
  description: `**Property management software comparison site — neutral third-party affiliate site on Vercel, grown page-by-page in one repo.**

- Build the first pages of a neutral comparison site for property management software (landlords/property managers): a home page + a side-by-side comparison table + individual review pages for the top 6 tools (Buildium, DoorLoop, TenantCloud, Avail, AppFolio, Yardi Breeze), each with real pricing, honest pros/cons, and a "who it's for" verdict.
- Monetize with affiliate links to programs that actually pay: Buildium recurring commission plus lead bounty, DoorLoop per new subscription and per demo, TenantCloud recurring commissions.
- Deploy to Vercel as a new project; content lives in the repo regardless.`,
};

const P15 = {
  id: 15,
  domain: "VS Code extension for developers",
  description: `**mcp-lint landing page: give the project a public-facing URL and reduce install friction.**

- Add a single-page static landing site to the mcp-lint repo (\`docs/index.html\` + \`docs/styles.css\`). It explains what mcp-lint lints, shows inline examples of each diagnostic rule (missing description, duplicate tool name, generic param names, description bloat), and gives the exact 3-command install.
- Deploy to Vercel under a new project named \`mcp-lint\` so it gets a public URL that a developer can visit, share, and link to.
- Update the existing README.md with a concise "Quick start — 3 commands" section at the top so the GitHub repo itself doubles as a landing page.`,
};

const P16 = {
  id: 16,
  domain: "VS Code extension for developers",
  description: `**mcp-lint Python SDK support: expand the audience from TypeScript-only to the much larger Python MCP server ecosystem**

- Add a \`src/python-analyzer.ts\` module that statically checks Python MCP server source for the same 6 rules the existing TS analyzer covers. It targets the \`@mcp.tool()\` decorator pattern and \`@server.call_tool()\` pattern, plus Pydantic model field descriptions.
- Add \`examples/bad-python-server.py\` and \`examples/good-python-server.py\` fixture files so a visitor can see Python linting work in 30 seconds.
- Update \`src/extension.ts\` to activate on Python files too and dispatch to the new Python analyzer alongside the existing TS analyzer.`,
};

describe("stem", () => {
  it("folds the inflections that let one idea look like two", () => {
    expect(stem("manager")).toBe(stem("management"));
    expect(stem("compare")).toBe(stem("comparison"));
    expect(stem("deployed")).toBe(stem("deployment"));
    expect(stem("property")).toBe(stem("properties"));
  });

  it("leaves short words alone rather than mangling them into collisions", () => {
    expect(stem("site")).toBe("site");
    expect(stem("mcp")).toBe("mcp");
    expect(stem("lint")).toBe("lint");
  });
});

describe("terms", () => {
  it("splits a CamelCase product name into the phrase it hides", () => {
    const t = terms("PropertyManagerCompare");
    expect([...t].sort()).toEqual(["compar", "manag", "propert"]);
  });

  it("sees the same three words in the spelled-out version", () => {
    const t = terms("Property management software comparison site");
    expect(t.has("propert")).toBe(true);
    expect(t.has("manag")).toBe(true);
    expect(t.has("compar")).toBe(true);
  });

  it("drops markdown, URLs and filler that every proposal contains", () => {
    const t = terms("**Build a thing** with https://vercel.com/docs and the other one");
    expect(t.has("http")).toBe(false);
    expect(t.has("vercel")).toBe(false); // inside the URL, not prose
    expect(t.has("the")).toBe(false);
    expect(t.has("with")).toBe(false);
    expect(t.has("thing")).toBe(true);
  });
});

describe("similarity", () => {
  it("is 1 for a proposal against itself and symmetric between two", () => {
    expect(similarity(P14.description, P14.description).score).toBe(1);
    expect(similarity(P14.description, P20.description).score).toBeCloseTo(
      similarity(P20.description, P14.description).score,
      10
    );
  });

  it("scores empty text as 0 rather than dividing by zero", () => {
    expect(similarity("", P14.description).score).toBe(0);
    expect(similarity("   **__**  ", P14.description).score).toBe(0);
  });

  it("reports the shared terms, so a refusal can say what collided", () => {
    const { shared } = similarity(P14.description, P20.description);
    expect(shared).toContain("propert");
    expect(shared).toContain("compar");
    expect(shared).toContain("affiliat");
  });
});

describe("findNearDuplicate", () => {
  it("catches the reworded rewrite of a pending proposal", () => {
    // The case reported by the operator: a CamelCase product name and its spelled-out twin.
    const match = findNearDuplicate(P20, [P14]);
    expect(match?.proposal.id).toBe(14);
    expect(match!.score).toBeGreaterThan(DUPLICATE_THRESHOLD);
  });

  it("catches two variants of the same site that were pending simultaneously", () => {
    expect(findNearDuplicate(P17, [P14])?.proposal.id).toBe(14);
  });

  it("does not care that each rewording arrived under a different domain", () => {
    // All three domain strings differ, so a per-domain check would have missed every pair.
    expect(new Set([P14.domain, P17.domain, P20.domain]).size).toBe(3);
    expect(findNearDuplicate(P17, [P14, P15, P16])?.proposal.id).toBe(14);
  });

  it("lets a genuine next step on a shipped project through", () => {
    // Two real follow-ups on one repo -- exactly what the research prompt asks for instead
    // of a duplicate. Blocking these would make the check worse than the problem.
    expect(findNearDuplicate(P16, [P15])).toBeNull();
    expect(findNearDuplicate(P15, [P16])).toBeNull();
  });

  it("returns the closest match, not just the first, when several are above the line", () => {
    // Both #14 and #17 are duplicates of #20; the refusal names one, so it must be the
    // nearest one rather than whichever the query happened to return first.
    const best = findNearDuplicate(P20, [P17, P14])!;
    const runnerUp = [P14, P17].find((p) => p.id !== best.proposal.id)!;
    expect(best.score).toBeGreaterThanOrEqual(similarity(
      `${P20.domain}\n${P20.description}`,
      `${runnerUp.domain}\n${runnerUp.description}`
    ).score);
    // Order of the candidate list must not change the answer.
    expect(findNearDuplicate(P20, [P14, P17])!.proposal.id).toBe(best.proposal.id);
  });

  it("finds nothing in an empty queue", () => {
    expect(findNearDuplicate(P14, [])).toBeNull();
  });
});
