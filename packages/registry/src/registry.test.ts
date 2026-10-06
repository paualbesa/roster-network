import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RegistryError } from "./errors.js";
import { CapabilityRegistry } from "./registry.js";
import type { CapabilityListing } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function clock(iso = "2026-09-28T00:00:00.000Z"): () => Date {
  return () => new Date(iso);
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Invoice extractor",
    description: "Extract structured fields from invoices and receipts.",
    inputSchema: {
      type: "object",
      properties: { documentUrl: { type: "string" } },
      required: ["documentUrl"],
    },
    outputSchema: {
      type: "object",
      properties: { total: { type: "string" } },
    },
    pricing: { model: "per_call", amountUsdc: "0.02" },
    latency: { p95Ms: 400, p50Ms: 180 },
    tags: ["invoice", "extract"],
    ...overrides,
  };
}

describe("capability registry", () => {
  it("registers a manifest and returns it by id", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    const listing = registry.register("org_acme", body());

    expect(listing.id.startsWith("cap_")).toBe(true);
    expect(listing.organizationId).toBe("org_acme");
    expect(listing.pricing).toEqual({ model: "per_call", amountUsdc: "0.020000" });
    expect(listing.latency).toEqual({ p95Ms: 400, p50Ms: 180 });
    expect(listing.tags).toEqual(["extract", "invoice"]);
    expect(listing.version).toBe("1.0.0");
    expect(listing.agentId).toBeNull();
    expect(listing.manifest).toBeNull();
    expect(listing.createdAt).toBe("2026-09-28T00:00:00.000Z");
    expect(registry.get(listing.id)).toEqual(listing);
    expect(registry.get("cap_missing")).toBeNull();
  });

  it("ranks equal matches by price and latency hints, and synonyms still match", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    const cheap = registry.register(
      "org_a",
      body({ pricing: { model: "per_call", amountUsdc: "0.02" }, latency: { p95Ms: 400 } }),
    );
    const pricey = registry.register(
      "org_b",
      body({ pricing: { model: "per_call", amountUsdc: "0.50" }, latency: { p95Ms: 2000 } }),
    );
    const weather = registry.register(
      "org_c",
      body({
        name: "Weather forecast",
        description: "Hourly weather for a city.",
        tags: ["weather"],
        pricing: { model: "per_call", amountUsdc: "0.01" },
        latency: { p95Ms: 100 },
      }),
    );

    const extracted = registry.search({ q: "extract invoices" });
    expect(extracted.map((hit) => hit.listing.id)).toEqual([cheap.id, pricey.id]);
    expect(extracted[0]?.score).toBeGreaterThan(extracted[1]?.score ?? 0);
    expect(extracted[0]?.relevance).toBe(extracted[1]?.relevance);
    expect(extracted[0]?.priceHint).toBeGreaterThan(extracted[1]?.priceHint ?? 1);
    expect(extracted[0]?.latencyHint).toBeGreaterThan(extracted[1]?.latencyHint ?? 1);
    expect(extracted.some((hit) => hit.listing.id === weather.id)).toBe(false);

    const paraphrased = registry.search({ q: "parse receipts" });
    expect(paraphrased.map((hit) => hit.listing.id)).toEqual([cheap.id, pricey.id]);

    const forecast = registry.search({ q: "weather" });
    expect(forecast.map((hit) => hit.listing.id)).toEqual([weather.id]);

    const affordable = registry.search({ q: "extract invoices", maxPriceUsdc: "0.05" });
    expect(affordable.map((hit) => hit.listing.id)).toEqual([cheap.id]);

    const tagged = registry.search({ q: "", tags: ["weather"] });
    expect(tagged.map((hit) => hit.listing.id)).toEqual([weather.id]);
  });

  it("keeps a strongly relevant listing ahead of a cheap weak match", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    const focused = registry.register(
      "org_a",
      body({
        name: "Invoice extractor",
        description: "Extract invoice line items, tax, and totals.",
        pricing: { model: "per_call", amountUsdc: "2.00" },
        latency: { p95Ms: 800 },
      }),
    );
    const cheapAside = registry.register(
      "org_b",
      body({
        name: "General utilities",
        description: "Misc helpers. One note mentions invoices in passing.",
        tags: ["utility"],
        pricing: { model: "per_call", amountUsdc: "0.01" },
        latency: { p95Ms: 50 },
      }),
    );

    const hits = registry.search({ q: "extract invoices" });
    expect(hits[0]?.listing.id).toBe(focused.id);
    expect(hits.findIndex((hit) => hit.listing.id === cheapAside.id)).toBeGreaterThan(0);
    expect(hits[0]?.relevance).toBeGreaterThan(hits[1]?.relevance ?? 1);
  });

  it("updates the owner's listing and re-ranks from the new hints", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    const first = registry.register("org_a", body({ pricing: { model: "per_call", amountUsdc: "0.02" } }));
    const second = registry.register(
      "org_b",
      body({ pricing: { model: "per_call", amountUsdc: "0.10" }, latency: { p95Ms: 900 } }),
    );

    expect(registry.search({ q: "invoice" })[0]?.listing.id).toBe(first.id);

    const updated = registry.update("org_a", first.id, {
      pricing: { model: "per_call", amountUsdc: "5" },
      latency: { p95Ms: 8000 },
      description: "Extract structured fields from invoices and receipts, slowly.",
    });
    expect(updated.pricing.amountUsdc).toBe("5.000000");
    expect(updated.createdAt).toBe(first.createdAt);
    expect(registry.search({ q: "extract invoices" })[0]?.listing.id).toBe(second.id);

    expect(() => registry.update("org_b", first.id, { name: "Stolen" })).toThrow(RegistryError);
    try {
      registry.update("org_b", first.id, { name: "Stolen" });
    } catch (error) {
      expect(error).toBeInstanceOf(RegistryError);
      expect((error as RegistryError).status).toBe(403);
      expect((error as RegistryError).code).toBe("forbidden");
    }
    expect(registry.get(first.id)?.name).toBe("Invoice extractor");
  });

  it("hides paused listings from search and reloads them from a JSON index", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-registry-"));
    tempDirs.push(dir);
    const filePath = join(dir, "index.json");
    const registry = new CapabilityRegistry({ filePath, now: clock() });
    const live = registry.register("org_a", body({ name: "Invoice extractor" }));
    const paused = registry.register("org_a", body({ name: "Paused extractor", status: "paused" }));

    expect(registry.search({ q: "extract invoices" }).map((hit) => hit.listing.id)).toEqual([live.id]);
    expect(registry.get(paused.id)?.status).toBe("paused");

    const raw = readFileSync(filePath, "utf8");
    const saved = JSON.parse(raw) as {
      version: number;
      listings: Record<string, unknown>[];
      vectors: Record<string, number[]>;
    };
    expect(saved.version).toBe(2);
    expect(saved.listings.every((listing) => !("vector" in listing) && !("embedding" in listing))).toBe(true);
    expect(saved.vectors[live.id]?.length).toBeGreaterThan(0);
    expect(registry.get(live.id)).not.toHaveProperty("vector");
    const reloaded = new CapabilityRegistry({ filePath, now: clock("2026-09-29T00:00:00.000Z") });
    expect(reloaded.get(live.id)?.description).toBe(live.description);
    expect(reloaded.search({ q: "parse receipts" }).map((hit) => hit.listing.id)).toEqual([live.id]);

    const renamed = reloaded.update("org_a", live.id, { version: "1.1.0" });
    expect(renamed.version).toBe("1.1.0");
    expect(renamed.updatedAt).toBe("2026-09-29T00:00:00.000Z");
    const again = new CapabilityRegistry({ filePath });
    expect(again.get(live.id)?.version).toBe("1.1.0");
  });

  it("reloads an index written before listings had agentId", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-registry-"));
    tempDirs.push(dir);
    const filePath = join(dir, "index.json");
    const registry = new CapabilityRegistry({ filePath, now: clock() });
    const live = registry.register("org_a", body({ agentId: "agt_seller" }));
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
      listings: Record<string, unknown>[];
    };
    delete parsed.listings[0]?.agentId;
    delete parsed.listings[0]?.manifest;
    writeFileSync(filePath, JSON.stringify(parsed));

    const legacy = new CapabilityRegistry({ filePath });
    expect(legacy.get(live.id)?.agentId).toBeNull();
    expect(legacy.get(live.id)?.manifest).toBeNull();
    expect(legacy.search({ q: "extract invoices" }).map((hit) => hit.listing.id)).toEqual([live.id]);
    expect(legacy.search({ q: "extract invoices" })[0]?.reputationScore).toBeUndefined();
  });

  it("stores an MCP and OpenAPI manifest and reloads it", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-registry-"));
    tempDirs.push(dir);
    const filePath = join(dir, "index.json");
    const registry = new CapabilityRegistry({ filePath, now: clock() });
    const inputSchema = { type: "object", properties: { text: { type: "string" } } };
    const outputSchema = { type: "object", properties: { fields: { type: "array" } } };
    const listing = registry.register(
      "org_a",
      body({
        name: "Structured data extract",
        manifest: {
          mcp: { name: "structured_extract", description: "Extract named fields.", inputSchema },
          openapi: {
            openapi: "3.0.3",
            operationId: "extractStructuredData",
            method: "post",
            path: "/sandbox/structured-extract",
            requestSchema: inputSchema,
            responseSchema: outputSchema,
          },
        },
      }),
    );
    expect(listing.manifest?.mcp.name).toBe("structured_extract");
    expect(listing.manifest?.openapi.path).toBe("/sandbox/structured-extract");

    const reloaded = new CapabilityRegistry({ filePath });
    expect(reloaded.get(listing.id)?.manifest).toEqual(listing.manifest);

    const cleared = registry.update("org_a", listing.id, { manifest: null });
    expect(cleared.manifest).toBeNull();
  });

  it("rejects malformed manifests", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    expect(() => registry.register("org_a", body({ inputSchema: ["nope"] }))).toThrow(RegistryError);
    expect(() => registry.register("org_a", body({ pricing: { model: "free", amountUsdc: "1" } }))).toThrow(
      RegistryError,
    );
    expect(() => registry.register("org_a", body({ latency: { p95Ms: 100, p50Ms: 200 } }))).toThrow(RegistryError);
    expect(() => registry.register("org_a", body({ agentId: "seller" }))).toThrow(RegistryError);
    expect(() => registry.register("org_a", body({ manifest: { mcp: { name: "Bad Name" } } }))).toThrow(RegistryError);
    expect(() => registry.search({ limit: 0 })).toThrow(RegistryError);
    expect(() => registry.search({ minScore: 101 })).toThrow(RegistryError);
    expect(registry.get("cap_none")).toBeNull();
  });
});

describe("browse order", () => {
  it("orders an empty query by price and latency hints", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    const slow = registry.register(
      "org_a",
      body({ pricing: { model: "per_call", amountUsdc: "0.50" }, latency: { p95Ms: 2000 } }),
    );
    const fast = registry.register(
      "org_b",
      body({
        name: "Weather forecast",
        description: "Hourly weather for a city.",
        tags: ["weather"],
        pricing: { model: "free", amountUsdc: "0" },
        latency: { p95Ms: 80 },
      }),
    );
    const hits = registry.search({ q: "" });
    expect(hits.map((hit) => hit.listing.id)).toEqual([fast.id, slow.id]);
    expect(hits[0]?.relevance).toBe(0);
    expect(hits[0]?.priceHint).toBe(1);
    const listed: CapabilityListing[] = hits.map((hit) => hit.listing);
    expect(listed).toHaveLength(2);
  });
});

describe("admin remove", () => {
  it("hard-deletes a listing from the index", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    const listing = registry.register("org_a", body());
    expect(registry.get(listing.id)?.id).toBe(listing.id);
    const removed = registry.remove(listing.id);
    expect(removed.id).toBe(listing.id);
    expect(registry.get(listing.id)).toBeNull();
    expect(registry.list()).toHaveLength(0);
    expect(() => registry.remove(listing.id)).toThrow(RegistryError);
  });

  it("rejects paid listings below the 0.01 USDC floor", () => {
    const registry = new CapabilityRegistry();
    expect(() =>
      registry.register("org_a", body({ pricing: { model: "per_call", amountUsdc: "0.009" } })),
    ).toThrow(/at least 0.010000/);
  });
});
