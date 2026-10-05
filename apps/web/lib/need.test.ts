import { describe, expect, it } from "vitest";
import { formatAge, formatUsdc, freshnessLine, readBuyResponse, readNeedResponse, sampleCell, sampleColumns } from "./need";
import { parseListingDetail } from "./public-data";
import { demandCsv } from "./admin-client";

const NOW = Date.parse("2026-10-05T12:00:00Z");

describe("need helpers", () => {
  it("parses ranked matches and skips bad rows", () => {
    const view = readNeedResponse({
      need: "eur usd",
      matched: true,
      matches: [
        {
          listingId: "cap_1",
          name: "FX history",
          kind: "dataset",
          summary: "Daily ECB rates",
          priceUsdc: "0.020000",
          relevance: 0.8,
          seller: "Roster Data",
          freshness: { lastRefreshedAt: "2026-10-05T09:00:00Z", refreshCadence: "daily", status: "ok", rowCount: 7107 },
          source: { name: "ECB", license: "Free reuse with attribution", url: "https://www.ecb.europa.eu" },
          sample: [{ date: "2026-10-02", USD: 1.17 }],
          inputExample: {},
          p95Ms: 4000,
        },
        { name: "missing id" },
      ],
    });
    expect(view.matches).toHaveLength(1);
    expect(view.matches[0]?.kind).toBe("dataset");
    expect(freshnessLine(view.matches[0]!.freshness, NOW)).toBe("Updated 3 h ago · daily · 7,107 rows");
    expect(readNeedResponse({ matches: [], unmet: { logged: true, message: "logged" } }).unmetMessage).toBe("logged");
  });

  it("formats prices, ages, and sample cells", () => {
    expect(formatUsdc("0.010000")).toBe("0.01");
    expect(formatUsdc("0.002000")).toBe("0.002");
    expect(formatAge(null, NOW)).toBe("not collected yet");
    expect(formatAge("2026-10-05T11:50:00Z", NOW)).toBe("10 min ago");
    expect(formatAge("2026-10-01T12:00:00Z", NOW)).toBe("4 d ago");
    expect(sampleCell({ a: "x".repeat(80) }).endsWith("…")).toBe(true);
    expect(sampleColumns([{ a: 1, b: 2 }, { c: 3 }], 2)).toEqual(["a", "b"]);
  });

  it("reads signed download links from a dataset buy", () => {
    const receipt = readBuyResponse({
      status: "released",
      delivered: true,
      job: { id: "job_1" },
      result: { jsonUrl: "https://x/json", csvUrl: "https://x/csv", rowCount: 3 },
      receipt: { amountUsdc: "0.020000", listingName: "FX", buyerBalanceUsdc: "0.98" },
    });
    expect(receipt.csvUrl).toBe("https://x/csv");
    expect(receipt.jobId).toBe("job_1");
  });

  it("parses a listing detail with its data product", () => {
    const detail = parseListingDetail({
      listing: { id: "cap_1", name: "FX", kind: "dataset", pricing: { amountUsdc: "0.02" }, latency: { p95Ms: 4000 } },
      dataProduct: { slug: "fx-history", name: "FX", kind: "dataset", rowCount: 10, sources: [{ name: "ECB", url: "https://e", license: "CC" }] },
    });
    expect(detail?.kind).toBe("dataset");
    expect(detail?.dataProduct?.sources[0]?.license).toBe("CC");
    expect(parseListingDetail({})).toBeNull();
  });

  it("exports unmet demand as CSV", () => {
    const csv = demandCsv([
      { id: "need_1", need: 'flight "prices"', normalized: "", count: 3, firstSeenAt: "", lastSeenAt: "2026-10-05", bestScore: 0.2, bestListingName: null, budgetUsdc: null, kind: null, organizationId: null },
    ]);
    expect(csv).toContain('"flight ""prices""",3,2026-10-05,"",0.20,');
  });
});
