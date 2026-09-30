import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RegistryError } from "./errors.js";
import { CapabilityRegistry, parseSearchQuery } from "./registry.js";
import { blendRankScore } from "./rank.js";
import { capabilityDocument, cosineSimilarity, embedSemantic } from "./text.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function clock(): () => Date {
  return () => new Date("2026-09-28T00:00:00.000Z");
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Invoice extractor",
    description: "Extract structured fields from invoices and receipts.",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    pricing: { model: "per_call", amountUsdc: "0.02" },
    latency: { p95Ms: 400 },
    tags: ["invoice", "extract"],
    ...overrides,
  };
}

describe("semantic vectors", () => {
  it("embeds a near-miss query closer to the capability than to a lexical neighbor", () => {
    const query = embedSemantic("invioce extractr");
    const capability = embedSemantic(
      capabilityDocument({
        name: "Invoice extractor",
        description: "Extract structured fields from invoices and receipts.",
        tags: ["invoice", "extract"],
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      }),
    );
    const neighbor = embedSemantic(
      capabilityDocument({
        name: "Inventory notifier",
        description: "Notifies the team when inventory falls below a threshold.",
        tags: ["inventory", "notify"],
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      }),
    );
    const capabilityScore = cosineSimilarity(query, capability);
    const neighborScore = cosineSimilarity(query, neighbor);
    expect(capabilityScore).toBeGreaterThan(neighborScore);
    expect(neighborScore).toBeLessThan(0.12);
    expect(embedSemantic("invioce extractr")).toEqual(query);
  });
});

describe("semantic search", () => {
  it("ranks the capability ahead of a keyword near-miss", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    const extractor = registry.register(
      "org_a",
      manifest({ pricing: { model: "per_call", amountUsdc: "0.40" }, latency: { p95Ms: 900 } }),
    );
    const notifier = registry.register(
      "org_b",
      manifest({
        name: "Invoice notifier",
        description: "Sends a short alert. It does not extract documents.",
        tags: ["notify"],
        pricing: { model: "per_call", amountUsdc: "0.01" },
        latency: { p95Ms: 40 },
      }),
    );
    const inventory = registry.register(
      "org_c",
      manifest({
        name: "Inventory notifier",
        description: "Notifies the team when inventory falls below a threshold.",
        tags: ["inventory", "notify"],
        pricing: { model: "free", amountUsdc: "0" },
        latency: { p95Ms: 30 },
      }),
    );

    const keyword = registry.search({ q: "invioce extractr" });
    expect(keyword).toEqual([]);
    expect(registry.search({ q: "invioce extractr", semantic: false })).toEqual([]);

    const lexical = registry.search({ q: "invoice notifier" });
    expect(lexical[0]?.listing.id).toBe(notifier.id);

    const semantic = registry.search({ q: "invioce extractr", semantic: true });
    expect(semantic[0]?.listing.id).toBe(extractor.id);
    expect(semantic.map((hit) => hit.listing.id)).not.toContain(inventory.id);
    expect(semantic[0]?.relevance).toBeGreaterThan(semantic[1]?.relevance ?? 1);
    const hit = semantic[0];
    expect(hit?.score).toBeCloseTo(
      (hit?.relevance ?? 0) * (1 + 0.15 * (hit?.priceHint ?? 0) + 0.1 * (hit?.latencyHint ?? 0)),
      10,
    );
  });

  it("reads schema capability names that the keyword path skips", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    const reader = registry.register(
      "org_a",
      manifest({
        name: "File reader",
        description: "Reads an uploaded file.",
        tags: ["files"],
        inputSchema: { type: "object", properties: { documentUrl: { type: "string", description: "Source file" } } },
        outputSchema: { type: "object" },
        pricing: { model: "per_call", amountUsdc: "0.20" },
        latency: { p95Ms: 500 },
      }),
    );
    const shortener = registry.register(
      "org_b",
      manifest({
        name: "Url shortener",
        description: "Shortens links.",
        tags: ["url"],
        pricing: { model: "per_call", amountUsdc: "0.01" },
        latency: { p95Ms: 40 },
      }),
    );

    expect(registry.search({ q: "document url" }).map((hit) => hit.listing.id)).toEqual([shortener.id]);
    const semantic = registry.search({ q: "document url", semantic: true });
    expect(semantic[0]?.listing.id).toBe(reader.id);
    const shortenerHit = semantic.find((hit) => hit.listing.id === shortener.id);
    expect(semantic[0]?.relevance).toBeGreaterThan(shortenerHit?.relevance ?? 1);
  });

  it("keeps price ahead of an equal semantic match and blends reputation when asked", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    const pricey = registry.register(
      "org_a",
      manifest({ pricing: { model: "per_call", amountUsdc: "0.80" }, latency: { p95Ms: 2000 } }),
    );
    const cheap = registry.register("org_b", manifest());
    const hits = registry.search({ q: "invioce extractr", semantic: true });
    expect(hits.map((hit) => hit.listing.id)).toEqual([cheap.id, pricey.id]);
    expect(hits[0]?.relevance).toBe(hits[1]?.relevance);
    expect(hits[0]?.reputationScore).toBeUndefined();

    const scores = new Map<string, number | null>([
      [cheap.id, 0],
      [pricey.id, 95],
    ]);
    const blended = registry.search({ q: "invioce extractr", semantic: true, withReputation: true }, {
      scoresByListingId: scores,
    });
    expect(blended.map((hit) => hit.listing.id)).toEqual([pricey.id, cheap.id]);
    expect(blended.map((hit) => hit.reputationScore)).toEqual([95, 0]);
    expect(blended[0]?.score).toBeCloseTo(
      blendRankScore({
        browsing: false,
        relevance: blended[0]?.relevance ?? 0,
        priceHint: blended[0]?.priceHint ?? 0,
        latencyHint: blended[0]?.latencyHint ?? 0,
        reputationScore: 95,
      }),
      10,
    );

    const floor = registry.search({ q: "invioce extractr", semantic: true, minScore: 80 }, { scoresByListingId: scores });
    expect(floor.map((hit) => hit.listing.id)).toEqual([pricey.id]);
  });

  it("stores vectors in the index and rebuilds them when the manifest changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-semantic-"));
    tempDirs.push(dir);
    const filePath = join(dir, "index.json");
    const registry = new CapabilityRegistry({ filePath, now: clock() });
    const listing = registry.register(
      "org_a",
      manifest({
        name: "Weather forecast",
        description: "Hourly weather for a city.",
        tags: ["weather"],
      }),
    );
    expect(registry.search({ q: "invioce extractr", semantic: true })).toEqual([]);

    const saved = JSON.parse(readFileSync(filePath, "utf8")) as {
      version: number;
      vectors: Record<string, number[]>;
      listings: Record<string, unknown>[];
    };
    expect(saved.version).toBe(2);
    expect(saved.vectors[listing.id]?.length).toBeGreaterThan(0);
    expect(saved.listings[0]).not.toHaveProperty("vector");

    const legacy = { version: 1, listings: saved.listings };
    writeFileSync(filePath, JSON.stringify(legacy));
    const fromLegacy = new CapabilityRegistry({ filePath, now: clock() });
    expect(fromLegacy.search({ q: "weather", semantic: true }).map((hit) => hit.listing.id)).toEqual([listing.id]);

    const updated = fromLegacy.update("org_a", listing.id, {
      name: "Invoice extractor",
      description: "Extract structured fields from invoices and receipts.",
      tags: ["invoice", "extract"],
    });
    expect(updated.name).toBe("Invoice extractor");
    const after = new CapabilityRegistry({ filePath, now: clock() });
    expect(after.search({ q: "invioce extractr", semantic: true }).map((hit) => hit.listing.id)).toEqual([listing.id]);
    const rewritten = JSON.parse(readFileSync(filePath, "utf8")) as { version: number; vectors: Record<string, number[]> };
    expect(rewritten.version).toBe(2);
    expect(rewritten.vectors[listing.id]).not.toEqual(saved.vectors[listing.id]);
  });

  it("rejects a semantic flag other than 0 or 1", () => {
    const raw = {
      q: "invoice",
      tags: undefined,
      maxPriceUsdc: undefined,
      maxP95Ms: undefined,
      limit: undefined,
      minScore: undefined,
      withReputation: undefined,
      semantic: "yes",
    };
    expect(() => parseSearchQuery(raw)).toThrow(RegistryError);
    expect(parseSearchQuery({ ...raw, semantic: "1" }).semantic).toBe(true);
    expect(parseSearchQuery({ ...raw, semantic: "0" }).semantic).toBe(false);
    expect(parseSearchQuery({ ...raw, semantic: undefined }).semantic).toBe(false);
  });
});
