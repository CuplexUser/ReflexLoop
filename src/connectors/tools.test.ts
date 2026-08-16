// Request building is the whole substance of the declarative layer: a manifest is
// inert data until this turns it into a real HTTP call, and every way that can go
// wrong is silent (a param sent under the wrong name, a path placeholder left
// unsubstituted, a nested `url` never surfaced). So fetch is stubbed and the
// resulting Request is inspected, which is the same shape integrations/github.test.ts
// uses -- this is testing our own translation, not a mock of someone's wire format.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../tools/registry.js";
import { buildConnectorTools } from "./tools.js";
import { CONNECTORS } from "./load.js";

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

let captured: Captured[] = [];
let respondWith: { status: number; body: string } = { status: 200, body: "{}" };

const registry = new ToolRegistry(buildConnectorTools());

function stubFetch() {
  vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    captured.push({
      url: input.toString(),
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : null,
    });
    return new Response(respondWith.body, { status: respondWith.status });
  });
}

beforeEach(() => {
  captured = [];
  respondWith = { status: 200, body: "{}" };
  process.env.STRIPE_API_KEY = "sk_test_123";
  process.env.CLOUDFLARE_API_TOKEN = "cf_token";
  process.env.PLAUSIBLE_API_KEY = "pl_token";
  process.env.RESEND_API_KEY = "re_token";
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const call = (name: string, args: Record<string, unknown>) =>
  registry.invoke(`mcp__integrations__${name}`, args);

describe("bundled manifests", () => {
  it("every operation has a registered tool", () => {
    const declared = CONNECTORS.flatMap((c) => c.operations.map((o) => o.toolName));
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) expect(registry.has(name)).toBe(true);
  });
});

describe("request building", () => {
  it("form-encodes a body under the provider's own field names", async () => {
    respondWith = { status: 200, body: JSON.stringify({ id: "plink_1", url: "https://buy.stripe.com/x" }) };
    await call("stripe_create_payment_link", { priceId: "price_1" });

    const [req] = captured;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://api.stripe.com/v1/payment_links");
    expect(req.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    // `as` is what lets the tool argument read as priceId while Stripe gets its own name,
    // and the default quantity has to survive zod's parse to reach the wire at all.
    const form = new URLSearchParams(req.body ?? "");
    expect(form.get("line_items[0][price]")).toBe("price_1");
    expect(form.get("line_items[0][quantity]")).toBe("1");
  });

  it("JSON-encodes a body and sends arrays as arrays", async () => {
    await call("resend_send_email", {
      from: "a@b.com",
      to: ["c@d.com", "e@f.com"],
      subject: "hi",
      text: "hello",
    });

    const [req] = captured;
    expect(req.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(req.body ?? "{}")).toEqual({
      from: "a@b.com",
      to: ["c@d.com", "e@f.com"],
      subject: "hi",
      text: "hello",
    });
  });

  it("substitutes path params and never leaves a placeholder behind", async () => {
    await call("cloudflare_get_pages_project", { accountId: "acc 1", projectName: "site" });
    expect(captured[0].url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc%201/pages/projects/site"
    );
    expect(captured[0].url).not.toContain("{");
  });

  it("puts query params on the URL under their wire names, with defaults applied", async () => {
    await call("plausible_aggregate", { siteId: "example.com" });
    const url = new URL(captured[0].url);
    expect(url.pathname).toBe("/api/v1/stats/aggregate");
    expect(url.searchParams.get("site_id")).toBe("example.com");
    expect(url.searchParams.get("period")).toBe("30d");
    expect(captured[0].body).toBeNull();
  });

  it("sends the bearer credential from the connector's env var", async () => {
    await call("stripe_list_products", {});
    expect(captured[0].headers.authorization).toBe("Bearer sk_test_123");
  });
});

describe("responses", () => {
  it("shapes a nested response into the flat keys the manifest declares", async () => {
    respondWith = {
      status: 200,
      body: JSON.stringify({ result: { id: "rec_1", name: "www", type: "CNAME", extra: "ignored" } }),
    };
    const res = await call("cloudflare_create_dns_record", {
      zoneId: "z1",
      type: "CNAME",
      name: "www",
      content: "example.pages.dev",
    });

    expect(res.isError).toBe(false);
    // Cloudflare's {result: ...} wrapper is exactly why `result` dot-paths exist.
    expect(JSON.parse(res.text)).toEqual({ id: "rec_1", name: "www", type: "CNAME" });
  });

  it("falls back to the raw body when the shaping map resolves nothing", async () => {
    // A response shape that changed under us. `{}` would report success with no
    // information; the raw body at least lands in the action log.
    respondWith = { status: 200, body: JSON.stringify({ unexpected: true }) };
    const res = await call("cloudflare_list_zones", {});
    expect(JSON.parse(res.text)).toEqual({ unexpected: true });
  });

  it("returns a non-2xx as in-band error text rather than throwing", async () => {
    respondWith = { status: 402, body: '{"error":{"message":"card declined"}}' };
    const res = await call("stripe_create_product", { name: "Widget" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("402");
    expect(res.text).toContain("card declined");
  });

  it("reports a missing credential in band, and reads it at call time", async () => {
    delete process.env.STRIPE_API_KEY;
    const res = await call("stripe_list_products", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("STRIPE_API_KEY is not set");
    // Nothing was sent -- the credential is checked before the request is made.
    expect(captured).toHaveLength(0);

    // Same tool, same process: setting the key makes it work with no re-registration,
    // which is the property that lets a key be filled in without a restart.
    process.env.STRIPE_API_KEY = "sk_test_456";
    const after = await call("stripe_list_products", {});
    expect(after.isError).toBe(false);
    expect(captured[0].headers.authorization).toBe("Bearer sk_test_456");
  });

  it("rejects arguments that don't match the manifest's param types", async () => {
    const res = await call("stripe_create_price", {
      product: "prod_1",
      unitAmount: "lots",
      currency: "usd",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("unitAmount");
    expect(captured).toHaveLength(0);
  });
});
