import { parseResultSchema, validateResult } from "@albesa/core";
import { CapabilityRegistry, RegistryError } from "@albesa/registry";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { DataCatalog, dataProductDraft } from "./data/catalog.js";
import { DATA_PRODUCTS } from "./data/products/index.js";
import { SOURCES } from "./data/sources.js";
import { LocalDataStore } from "./data/store.js";
import type { DataProductSpec, Row } from "./data/types.js";
import { parseCsv, toCsv, unzipEntry } from "./data/util.js";
import { DemandLog, normalizeNeed } from "./demand.js";
import { appDataCatalog, bootstrapDataProducts, bootstrapSandboxFleet, DATA_ORG_NAME } from "./fleet.js";
import { expandNeed } from "./need.js";

const TOKEN = "admin-token-for-data-tests-0123456789";

const FIXTURES: DataProductSpec[] = [
  {
    slug: "test-rates",
    name: "Test FX rates table",
    kind: "dataset",
    description: "Exchange rates fixture dataset for currency conversion tests.",
    tags: ["fx", "exchange-rates", "currency"],
    sources: [SOURCES.ecbFrankfurter],
    cadence: "daily",
    intervalS: 86_400,
    priceUsdc: "0.01",
    p95Ms: 5000,
    columns: [
      { name: "currency", type: "string", description: "ISO code" },
      { name: "rate", type: "number", description: "Per EUR" },
    ],
    ingest: async (ctx) => {
      const data = await ctx.fetchJson<{ rates: Record<string, number> }>("https://fixture.test/rates");
      return Object.entries(data.rates).map(([currency, rate]) => ({ currency, rate }));
    },
  },
  {
    slug: "test-quakes",
    name: "Test earthquakes feed",
    kind: "feed",
    description: "Earthquake events fixture feed with magnitudes.",
    tags: ["earthquakes", "seismic"],
    sources: [SOURCES.usgs],
    cadence: "hourly",
    intervalS: 3600,
    priceUsdc: "0.003",
    p95Ms: 5000,
    timeField: "time",
    idField: "id",
    retainDays: 30,
    maxRows: 100,
    filterFields: ["alert"],
    columns: [
      { name: "id", type: "string", description: "Event" },
      { name: "time", type: "datetime", description: "When" },
      { name: "alert", type: "string", description: "Alert" },
    ],
    ingest: async () => [
      { id: "a", time: "2026-10-05T10:00:00Z", alert: "green" },
      { id: "b", time: "2026-10-05T11:00:00Z", alert: null },
      { id: "old", time: "2026-08-01T00:00:00Z", alert: null },
    ],
  },
  {
    slug: "test-rate-lookup",
    name: "Test rate lookup",
    kind: "lookup",
    description: "Look up one currency rate from the fixture table.",
    tags: ["fx", "lookup"],
    sources: [SOURCES.ecbFrankfurter],
    cadence: "daily",
    intervalS: 86_400,
    priceUsdc: "0.001",
    p95Ms: 5000,
    columns: [{ name: "rate", type: "number", description: "Rate" }],
    input: { currency: { type: "string" } },
    required: ["currency"],
    example: { currency: "USD" },
    lookup: async (input, ctx) => (await ctx.rowsOf("test-rates")).filter((row) => row.currency === input.currency),
  },
];

const NOW = new Date("2026-10-05T12:00:00Z");

function fixtureFetch(): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href = String(url);
    if (href === "https://fixture.test/rates") {
      return new Response(JSON.stringify({ rates: { USD: 1.12, GBP: 0.85 } }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function fixtureApp() {
  const store = new LocalDataStore({ now: () => NOW, secret: "s" });
  const catalog = new DataCatalog(store, { specs: FIXTURES, fetch: fixtureFetch(), now: () => NOW, log: () => undefined });
  const demand = new DemandLog(null, () => NOW);
  const app = createApp({ mode: "sandbox", autofill: "sync", adminToken: TOKEN, dataCatalog: catalog, dataStore: store, demandLog: demand });
  return { app, catalog, store, demand };
}

async function signup(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/v1/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `buyer-${Math.random().toString(36).slice(2)}@example.com`, password: "password-123456" }),
  });
  const body = (await response.json()) as { apiKey: string };
  return body.apiKey;
}

describe("registry data product kinds", () => {
  it("accepts dataset listings with data metadata and filters search by kind", () => {
    const registry = new CapabilityRegistry();
    const draft = dataProductDraft(FIXTURES[0] as DataProductSpec);
    const listing = registry.register("org_a", draft);
    expect(listing.kind).toBe("dataset");
    expect(listing.data?.sources[0]?.license).toContain("ECB");
    registry.register("org_a", {
      name: "Rate explainer",
      description: "Explains exchange rates in plain words.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      pricing: { model: "per_call", amountUsdc: "0.01" },
      latency: { p95Ms: 1000 },
      tags: ["fx"],
    });
    const all = registry.search({ q: "exchange rates", tags: [], maxPriceUsdc: null, maxP95Ms: null, limit: 10, minScore: null, withReputation: false, semantic: false });
    const onlyData = registry.search({ q: "exchange rates", tags: [], maxPriceUsdc: null, maxP95Ms: null, limit: 10, minScore: null, withReputation: false, semantic: false, kinds: ["dataset"] });
    expect(all.length).toBe(2);
    expect(onlyData.map((hit) => hit.listing.kind)).toEqual(["dataset"]);
  });

  it("rejects inconsistent kind and data", () => {
    const registry = new CapabilityRegistry();
    const draft = dataProductDraft(FIXTURES[0] as DataProductSpec);
    expect(() => registry.register("org_a", { ...draft, data: null })).toThrow(RegistryError);
    expect(() => registry.register("org_a", { ...draft, kind: "service" })).toThrow(/only allowed/);
    expect(() => registry.register("org_a", { ...draft, kind: "table" })).toThrow(/kind must be/);
    expect(() =>
      registry.register("org_a", { ...draft, data: { ...draft.data, sources: [{ ...draft.data.sources[0], licenseUrl: "nope" }] } }),
    ).toThrow(/licenseUrl/);
  });

  it("treats legacy listings without kind as services", () => {
    const registry = new CapabilityRegistry();
    const listing = registry.register("org_a", {
      name: "Legacy",
      description: "Old listing.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      pricing: { model: "per_call", amountUsdc: "0.01" },
      latency: { p95Ms: 1000 },
    });
    expect(listing.kind).toBe("service");
    expect(listing.data).toBeNull();
  });
});

describe("Roster Data catalog definitions", () => {
  it("defines 30-60 products with unique slugs and names, licenses and valid schemas", () => {
    expect(DATA_PRODUCTS.length).toBeGreaterThanOrEqual(30);
    expect(DATA_PRODUCTS.length).toBeLessThanOrEqual(60);
    expect(new Set(DATA_PRODUCTS.map((spec) => spec.slug)).size).toBe(DATA_PRODUCTS.length);
    expect(new Set(DATA_PRODUCTS.map((spec) => spec.name)).size).toBe(DATA_PRODUCTS.length);
    const registry = new CapabilityRegistry();
    for (const spec of DATA_PRODUCTS) {
      expect(spec.sources.length).toBeGreaterThan(0);
      for (const source of spec.sources) {
        expect(source.license.length).toBeGreaterThan(2);
        expect(source.attribution.length).toBeGreaterThan(5);
      }
      expect(Boolean(spec.ingest) || Boolean(spec.lookup)).toBe(true);
      if (spec.kind === "lookup") expect(spec.lookup).toBeTypeOf("function");
      const draft = dataProductDraft(spec);
      // Escrow must accept the listing output schema as a job schema.
      expect(() => parseResultSchema(draft.outputSchema)).not.toThrow();
      const listing = registry.register("org_data", draft);
      expect(listing.kind).toBe(spec.kind);
    }
  });

  it("rejects empty deliveries so the buyer is refunded", () => {
    const lookup = DATA_PRODUCTS.find((spec) => spec.kind === "lookup") as DataProductSpec;
    const schema = parseResultSchema(dataProductDraft(lookup).outputSchema);
    expect(validateResult(schema, { product: lookup.slug, lastRefreshedAt: NOW.toISOString(), count: 0, matches: [], license: "x", attribution: "y" }).ok).toBe(false);
  });
});

describe("data utilities", () => {
  it("parses and writes CSV with quotes", () => {
    const rows = parseCsv('a,b\n"x, y","say ""hi"""\n1,\n');
    expect(rows).toEqual([
      { a: "x, y", b: 'say "hi"' },
      { a: "1", b: "" },
    ]);
    const csv = toCsv([{ a: "x, y", b: null }] as Row[], ["a", "b"]);
    expect(csv).toBe('a,b\n"x, y",\n');
  });

  it("reads a stored ZIP entry", () => {
    // Minimal stored (method 0) ZIP with one file "a.txt" = "hi".
    const name = new TextEncoder().encode("a.txt");
    const body = new TextEncoder().encode("hi");
    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, body.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, body.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, 0, true);
    central.set(name, 46);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(12, central.length, true);
    ev.setUint32(16, local.length, true);
    const archive = new Uint8Array([...local, ...central, ...end]);
    expect(new TextDecoder().decode(unzipEntry(archive, "a.txt"))).toBe("hi");
  });

  it("expands Catalan and Spanish needs into listing vocabulary", () => {
    expect(expandNeed("Necessito el tipus de canvi euro dòlar")).toContain("exchange rates");
    expect(expandNeed("terremotos en Chile")).toContain("earthquakes");
    expect(normalizeNeed("  Tipus de Canvi!! ")).toBe("tipus de canvi");
  });
});

describe("data catalog refresh and delivery", () => {
  it("refreshes, stores JSON and CSV, merges feeds with retention, and records errors", async () => {
    const { catalog, store } = fixtureApp();
    const meta = await catalog.refresh("test-rates");
    expect(meta).toMatchObject({ status: "ok", rowCount: 2, lastError: null });
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(new TextDecoder().decode((await store.get("test-rates/latest.csv")) ?? new Uint8Array())).toContain("currency,rate");
    const feed = await catalog.refresh("test-quakes");
    // The 2026-08-01 item is older than the 30-day retention window.
    expect(feed.rowCount).toBe(2);
    expect(feed.sample[0]?.id).toBe("b");
    expect(catalog.isDue(FIXTURES[0] as DataProductSpec)).toBe(false);

    const broken = new DataCatalog(store, {
      specs: [{ ...(FIXTURES[0] as DataProductSpec), slug: "test-broken", name: "Broken", ingest: async () => Promise.reject(new Error("upstream down")) }],
      now: () => NOW,
      log: () => undefined,
    });
    const failed = await broken.refresh("test-broken");
    expect(failed).toMatchObject({ status: "error", lastError: "upstream down", rowCount: 0 });
  });

  it("sells a dataset through escrow and serves the signed download", async () => {
    const { app, catalog } = fixtureApp();
    await bootstrapDataProducts(app);
    await catalog.refresh("test-rates");
    const apiKey = await signup(app);
    const listings = (await (await app.request("/v1/registry/listings")).json()) as { listings: { id: string; name: string; kind: string }[] };
    const listing = listings.listings.find((entry) => entry.name === "Test FX rates table");
    expect(listing?.kind).toBe("dataset");
    const response = await app.request("/v1/need/buy", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ listingId: listing?.id }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { status: string; delivered: boolean; result: { downloadUrl: string; csvUrl: string; rowCount: number; license: string }; receipt: { amountUsdc: string } };
    expect(body.status).toBe("released");
    expect(body.delivered).toBe(true);
    expect(body.result.rowCount).toBe(2);
    expect(body.result.license).toContain("ECB");
    expect(body.receipt.amountUsdc).toBe("0.010000");
    const download = await app.request(body.result.csvUrl);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("test-rates-2026-10-05.csv");
    expect(await download.text()).toContain("USD,1.12");
    const forged = await app.request(body.result.downloadUrl.replace(/.$/, "x"));
    expect(forged.status).toBe(404);
  });

  it("refunds the buyer when a product has nothing to deliver", async () => {
    const { app } = fixtureApp();
    await bootstrapDataProducts(app);
    const apiKey = await signup(app);
    const listings = (await (await app.request("/v1/registry/listings")).json()) as { listings: { id: string; name: string }[] };
    const lookup = listings.listings.find((entry) => entry.name === "Test rate lookup");
    const response = await app.request("/v1/need/buy", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ listingId: lookup?.id, input: { currency: "USD" } }),
    });
    const body = (await response.json()) as { status: string; delivered: boolean; result: unknown };
    expect(body.status).toBe("refunded");
    expect(body.delivered).toBe(false);
    expect(body.result).toBeNull();
  });

  it("answers a lookup from another product's rows and a feed with filters", async () => {
    const { app, catalog } = fixtureApp();
    await bootstrapDataProducts(app);
    await catalog.refresh("test-rates");
    await catalog.refresh("test-quakes");
    const lookup = await catalog.fulfill("Test rate lookup", { currency: "GBP" });
    expect(lookup).toMatchObject({ product: "test-rate-lookup", count: 1, matches: [{ currency: "GBP", rate: 0.85 }] });
    const feed = await catalog.fulfill("Test earthquakes feed", { filter: { alert: "green" }, limit: 5 });
    expect(feed).toMatchObject({ count: 1, totalAvailable: 2 });
    const since = await catalog.fulfill("Test earthquakes feed", { since: "2026-10-05T10:30:00Z" });
    expect(since).toMatchObject({ count: 1 });
  });
});

describe("POST /v1/need", () => {
  it("ranks data products with freshness and a buy path, and logs unmet demand for admins", async () => {
    const { app, catalog } = fixtureApp();
    await bootstrapDataProducts(app);
    await catalog.refresh("test-rates");
    const matched = await app.request("/v1/need", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ need: "currency exchange rates table", budgetUsdc: "0.05" }),
    });
    expect(matched.status).toBe(200);
    const body = (await matched.json()) as {
      matched: boolean;
      matches: { name: string; kind: string; priceUsdc: string; freshness: { status: string; rowCount: number }; buy: { path: string; body: { listingId: string } } }[];
    };
    expect(body.matched).toBe(true);
    expect(body.matches[0]?.name).toBe("Test FX rates table");
    expect(body.matches[0]?.freshness).toMatchObject({ status: "ok", rowCount: 2 });
    expect(body.matches[0]?.buy.path).toBe("/v1/need/buy");

    const unmet = await app.request("/v1/need", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ need: "pizza delivery near my office" }),
    });
    const unmetBody = (await unmet.json()) as { matched: boolean; unmet: { logged: boolean } };
    expect(unmetBody.matched).toBe(false);
    expect(unmetBody.unmet.logged).toBe(true);
    await app.request("/v1/need", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ need: "Pizza delivery near my office!" }),
    });
    const admin = await app.request("/v1/admin/demand", { headers: { "x-roster-admin-token": TOKEN } });
    expect(admin.status).toBe(200);
    const demand = (await admin.json()) as { entries: { need: string; count: number }[]; totals: { requests: number } };
    expect(demand.entries[0]).toMatchObject({ count: 2 });
    expect(demand.totals.requests).toBe(2);
    const anonymous = await app.request("/v1/admin/demand");
    expect(anonymous.status).toBe(401);
  });

  it("validates the body and requires a key to buy", async () => {
    const { app } = fixtureApp();
    const bad = await app.request("/v1/need", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ need: "" }) });
    expect(bad.status).toBe(400);
    const buy = await app.request("/v1/need", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ need: "exchange rates", buy: true }),
    });
    expect(buy.status).toBe(401);
    const unauth = await app.request("/v1/need/buy", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(unauth.status).toBe(401);
  });

  it("rejects a buy whose input misses a required field before any money moves", async () => {
    const { app, catalog } = fixtureApp();
    await bootstrapDataProducts(app);
    await catalog.refresh("test-rates");
    const apiKey = await signup(app);
    const products = (await (await app.request("/v1/data/products")).json()) as { products: { slug: string; listingId: string }[] };
    const listingId = products.products.find((product) => product.slug === "test-rate-lookup")!.listingId;
    const wrong = await app.request("/v1/need/buy", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ listingId, input: { code: "GBP" } }),
    });
    expect(wrong.status).toBe(400);
    const error = (await wrong.json()) as { error: { code: string; message: string } };
    expect(error.error.code).toBe("invalid_input");
    expect(error.error.message).toContain("currency");
    const jobs = (await (await app.request("/v1/jobs", { headers: { authorization: `Bearer ${apiKey}` } })).json()) as { jobs: unknown[] };
    expect(jobs.jobs).toHaveLength(0);
  });

  it("buys the top match in one call with buy: true", async () => {
    const { app, catalog } = fixtureApp();
    await bootstrapDataProducts(app);
    await catalog.refresh("test-rates");
    const apiKey = await signup(app);
    const response = await app.request("/v1/need", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ need: "currency exchange rates table", buy: true }),
    });
    const body = (await response.json()) as { bought: { status: string; result: { product: string } } };
    expect(body.bought.status).toBe("released");
    expect(body.bought.result.product).toBe("test-rates");
  });
});

describe("Roster Data bootstrap", () => {
  it("publishes every product under its own org, binds autofill, and is idempotent", async () => {
    const app = createApp({ mode: "sandbox", autofill: "sync" });
    await bootstrapSandboxFleet(app);
    const first = await bootstrapDataProducts(app);
    expect(first.organizationName).toBe(DATA_ORG_NAME);
    expect(first.listings.length).toBe(DATA_PRODUCTS.length);
    const before = (await (await app.request("/v1/registry/listings")).json()) as { listings: { id: string; updatedAt: string; kind: string }[] };
    const second = await bootstrapDataProducts(app);
    expect(second.listings.map((listing) => listing.id)).toEqual(first.listings.map((listing) => listing.id));
    const after = (await (await app.request("/v1/registry/listings")).json()) as { listings: { id: string; updatedAt: string }[] };
    expect(after.listings.map((listing) => listing.updatedAt)).toEqual(before.listings.map((listing) => listing.updatedAt));
    expect(before.listings.filter((listing) => listing.kind !== "service").length).toBe(DATA_PRODUCTS.length);
    expect(appDataCatalog(app)?.specs.length).toBe(DATA_PRODUCTS.length);
    const products = (await (await app.request("/v1/data/products")).json()) as { products: { listingId: string | null; status: string }[] };
    expect(products.products.every((product) => product.listingId !== null)).toBe(true);
  }, 30_000);
});
