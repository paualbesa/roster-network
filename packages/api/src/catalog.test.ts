import { parseResultSchema, validateResult } from "@albesa/core";
import { describe, expect, it } from "vitest";
import {
  sandboxComputeArbListing,
  sandboxExecute,
  sandboxJobSchema,
  sandboxMarketplaceListings,
  sandboxSellerBindRequests,
} from "./catalog.js";

describe("first-party sandbox catalog", () => {
  it("publishes unique listings whose result schemas escrow can check", () => {
    const listings = sandboxMarketplaceListings();
    expect(listings.map((listing) => listing.name)).toEqual([
      "Receipt parser",
      "Doc summarizer",
      "Unit converter",
      "Structured data extract",
      "Doc Q&A",
      "Compute arb",
    ]);
    expect(new Set(listings.map((listing) => listing.name)).size).toBe(listings.length);
    expect(new Set(listings.map((listing) => listing.manifest.mcp.name)).size).toBe(listings.length);

    for (const listing of listings) {
      expect(listing.manifest.openapi.openapi).toBe("3.0.3");
      expect(listing.manifest.openapi.method).toBe("post");
      expect(listing.manifest.mcp.inputSchema).toEqual(listing.inputSchema);
      expect(listing.manifest.openapi.responseSchema).toEqual(listing.outputSchema);
      expect(listing.pricing.model).toBe("per_call");
      expect(listing.latency.p95Ms).toBeGreaterThan(0);
      const schema = parseResultSchema(sandboxJobSchema(listing.name));
      const result = sandboxExecute(listing.name, {});
      expect(validateResult(schema, result)).toEqual({ ok: true, errors: [] });
    }
  });

  it("extracts labeled fields, answers from the document, and picks the cheaper quote", () => {
    expect(
      sandboxExecute("Structured data extract", {
        text: "vendor: Harbor Supply\ntotal: 12.50",
        fields: ["vendor", "total"],
      }),
    ).toEqual({
      fields: [
        { name: "vendor", value: "Harbor Supply" },
        { name: "total", value: "12.50" },
      ],
    });

    expect(
      sandboxExecute("Doc Q&A", {
        document: "Payment terms are net 30. Shipping is extra.",
        question: "When is payment due?",
      }),
    ).toEqual({ answer: "Payment terms are net 30.", citations: 1 });

    const arb = sandboxExecute("Compute arb", {
      quotes: [
        { provider: "spot-b", priceUsdc: "0.006" },
        { provider: "spot-a", priceUsdc: "0.004" },
      ],
    });
    expect(arb).toEqual({ provider: "spot-a", priceUsdc: "0.004000", savedUsdc: "0.002000" });
    const schema = parseResultSchema(sandboxComputeArbListing().outputSchema);
    expect(validateResult(schema, arb)).toEqual({ ok: true, errors: [] });
  });

  it("maps seeded listing ids onto one seller agent", () => {
    const requests = sandboxSellerBindRequests(
      [
        { id: "cap_receipt", name: "Receipt parser" },
        { id: "cap_other", name: "Weather" },
        { id: "cap_arb", name: "Compute arb" },
      ],
      "agt_seller",
    );
    expect(requests).toEqual([
      { listingId: "cap_receipt", name: "Receipt parser", sellerAgentId: "agt_seller" },
      { listingId: "cap_arb", name: "Compute arb", sellerAgentId: "agt_seller" },
    ]);
  });
});
