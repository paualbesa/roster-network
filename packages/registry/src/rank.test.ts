import { describe, expect, it } from "vitest";
import { CapabilityRegistry } from "./registry.js";
import {
  blendRankScore,
  commercialHint,
  NEUTRAL_REPUTATION_SCORE,
  normalizeReputationScore,
  RANK_BLEND_WEIGHTS,
} from "./rank.js";

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
    tags: ["invoice"],
    ...overrides,
  };
}

describe("blend math", () => {
  it("weights relevance, price-latency, and reputation", () => {
    expect(RANK_BLEND_WEIGHTS.relevance + RANK_BLEND_WEIGHTS.priceLatency + RANK_BLEND_WEIGHTS.reputation).toBe(1);
    const commercial = commercialHint(1, 0.5);
    expect(commercial).toBeCloseTo(0.6 * 1 + 0.4 * 0.5, 10);

    const shared = { browsing: false, relevance: 0.8, priceHint: 1, latencyHint: 0.5 };
    expect(blendRankScore({ ...shared, reputationScore: 100 })).toBeCloseTo(0.7 * 0.8 + 0.15 * commercial + 0.15, 10);
    expect(blendRankScore({ ...shared, reputationScore: 0 })).toBeCloseTo(0.7 * 0.8 + 0.15 * commercial, 10);
    expect(blendRankScore({ ...shared, reputationScore: 50 })).toBeCloseTo(0.7 * 0.8 + 0.15 * commercial + 0.075, 10);
  });

  it("folds relevance into the browse score when the query is empty", () => {
    const browse = 0.6 * 1 + 0.4 * 0.5;
    expect(
      blendRankScore({ browsing: true, relevance: 0, priceHint: 1, latencyHint: 0.5, reputationScore: 80 }),
    ).toBeCloseTo(0.85 * browse + 0.15 * 0.8, 10);
  });

  it("treats a missing passport as neutral and clamps everything else", () => {
    expect(NEUTRAL_REPUTATION_SCORE).toBe(50);
    expect(normalizeReputationScore(undefined)).toBe(50);
    expect(normalizeReputationScore(null)).toBe(50);
    expect(normalizeReputationScore(Number.NaN)).toBe(50);
    expect(normalizeReputationScore(-4)).toBe(0);
    expect(normalizeReputationScore(140)).toBe(100);
    expect(normalizeReputationScore(84.75)).toBe(84.75);
  });
});

describe("reputation ranking", () => {
  it("keeps keyword ranking when no reputation data is supplied", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    const low = registry.register("org_a", manifest({ agentId: "agt_low" }));
    const high = registry.register("org_b", manifest({ agentId: "agt_high" }));

    const plain = registry.search({ q: "extract invoices" });
    expect(plain.every((hit) => hit.reputationScore === undefined)).toBe(true);
    expect(plain[0]?.score).toBe(plain[1]?.score);
    expect(plain.map((hit) => hit.listing.id)).toEqual([low.id, high.id].sort());
  });

  it("ranks a reliable listing above an identical one and applies minScore", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    const low = registry.register("org_a", manifest({ agentId: "agt_low" }));
    const high = registry.register("org_b", manifest({ agentId: "agt_high" }));
    const unknown = registry.register("org_c", manifest());
    const scores = new Map<string, number | null>([
      [low.id, 0],
      [high.id, 90],
      [unknown.id, null],
    ]);

    const blended = registry.search({ q: "extract invoices", withReputation: true }, { scoresByListingId: scores });
    expect(blended.map((hit) => hit.listing.id)).toEqual([high.id, unknown.id, low.id]);
    expect(blended.map((hit) => hit.reputationScore)).toEqual([90, 50, 0]);
    expect(blended[0]?.score).toBeGreaterThan(blended[1]?.score ?? 0);
    expect(blended[1]?.score).toBeGreaterThan(blended[2]?.score ?? 0);

    const floor = registry.search({ q: "extract invoices", minScore: 50 }, { scoresByListingId: scores });
    expect(floor.map((hit) => hit.listing.id)).toEqual([high.id, unknown.id]);

    const strict = registry.search({ q: "extract invoices", minScore: 80 }, { scoresByListingId: scores });
    expect(strict.map((hit) => hit.listing.id)).toEqual([high.id]);

    const plain = registry.search({ q: "extract invoices" });
    const sample = plain.find((hit) => hit.listing.id === high.id);
    const matched = blended.find((hit) => hit.listing.id === high.id);
    expect(sample?.score).not.toBe(matched?.score);
  });

  it("uses blendRankScore for the opted-in hit", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    registry.register("org_a", manifest());
    const plain = registry.search({ q: "extract invoices" });
    const blended = registry.search({ q: "extract invoices", withReputation: true });
    const hit = plain[0];
    expect(blended[0]?.reputationScore).toBe(50);
    expect(blended[0]?.score).toBeCloseTo(
      blendRankScore({
        browsing: false,
        relevance: hit?.relevance ?? 0,
        priceHint: hit?.priceHint ?? 0,
        latencyHint: hit?.latencyHint ?? 0,
        reputationScore: 50,
      }),
      10,
    );
  });

  it("drops every hit when minScore is above the neutral score and no passports are known", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    registry.register("org_a", manifest());
    expect(registry.search({ q: "extract invoices", minScore: 90 })).toEqual([]);
    expect(registry.search({ q: "extract invoices", minScore: 50 })).toHaveLength(1);
  });

  it("uses caller-supplied cosine scores for semantic search", () => {
    const registry = new CapabilityRegistry({ now: clock() });
    const invoice = registry.register("org_a", manifest());
    const weather = registry.register(
      "org_a",
      manifest({
        name: "Weather",
        description: "Forecasts for a city.",
        tags: ["weather"],
      }),
    );
    const hits = registry.search({ q: "invoice", semantic: true, limit: 5 }, null, new Map([
      [invoice.id, 0.01],
      [weather.id, 0.9],
    ]));
    expect(hits[0]?.listing.id).toBe(weather.id);
    expect(hits[0]?.relevance).toBeCloseTo(0.9);
    expect(hits.some((hit) => hit.listing.id === invoice.id)).toBe(false);
  });
});
