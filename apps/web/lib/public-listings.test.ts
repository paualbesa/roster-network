import { describe, expect, it } from "vitest";
import { formatListingPrice, parsePublicListings } from "./public-listings";

describe("public listings on the landing page", () => {
  it("keeps active, well-formed listings and caps the count", () => {
    const payload = {
      listings: [
        {
          id: "cap_1",
          name: "Receipt parser",
          description: "Parse receipts",
          status: "active",
          pricing: { model: "per_call", amountUsdc: "0.010000" },
          latency: { p95Ms: 400 },
          tags: ["receipt", "ocr", "finance", "extra"],
        },
        { id: "cap_2", name: "Paused", status: "paused", pricing: { amountUsdc: "1" }, latency: { p95Ms: 1 } },
        { id: "cap_3", name: "Broken", status: "active" },
        {
          id: "cap_4",
          name: "Unit converter",
          status: "active",
          pricing: { amountUsdc: "0.002000" },
          latency: { p95Ms: 120 },
        },
      ],
    };
    const listings = parsePublicListings(payload, 5);
    expect(listings.map((listing) => listing.id)).toEqual(["cap_1", "cap_4"]);
    expect(listings[0]?.tags).toEqual(["receipt", "ocr", "finance"]);
    expect(listings[1]).toMatchObject({ pricingModel: "per_call", description: "", tags: [] });
    expect(parsePublicListings({ listings: [payload.listings[0], payload.listings[3]] }, 1)).toHaveLength(1);
    expect(parsePublicListings(null)).toEqual([]);
    expect(parsePublicListings({ error: { code: "unauthorized" } })).toEqual([]);
  });

  it("formats USDC prices without trailing zeros", () => {
    expect(formatListingPrice("0.010000")).toBe("0.01");
    expect(formatListingPrice("0.002500")).toBe("0.0025");
    expect(formatListingPrice("1.000000")).toBe("1.00");
    expect(formatListingPrice("3")).toBe("3.00");
  });
});
