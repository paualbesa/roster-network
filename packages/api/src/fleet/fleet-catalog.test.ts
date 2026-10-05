import { parseResultSchema, validateResult } from "@albesa/core";
import { CapabilityRegistry } from "@albesa/registry";
import { describe, expect, it } from "vitest";
import { isRosterFleetName, rosterFleetListings, sandboxExecute, sandboxJobSchema, sandboxMarketplaceListings } from "../catalog.js";
import { fleetTools } from "./index.js";

const GARBAGE: unknown[] = [{}, null, "text", 42, [], { text: 5, csv: null, records: "x", values: ["a"], items: [1, 2] }];

describe("Roster Fleet catalog", () => {
  it("publishes 80+ unique first-party listings the registry accepts", () => {
    const drafts = rosterFleetListings();
    expect(drafts.length).toBeGreaterThanOrEqual(80);
    expect(drafts.length).toBeLessThanOrEqual(100);
    expect(new Set(drafts.map((draft) => draft.name)).size).toBe(drafts.length);
    expect(new Set(drafts.map((draft) => draft.manifest.mcp.name)).size).toBe(drafts.length);
    const registry = new CapabilityRegistry();
    for (const draft of drafts) registry.register("org_fleet", draft);
    expect(registry.list()).toHaveLength(drafts.length);
    expect(sandboxMarketplaceListings()).toHaveLength(6);
  });

  it("covers the categories buyers ask for", () => {
    const categories = new Set(fleetTools().map((tool) => tool.category));
    for (const category of ["text", "extraction", "translation", "data", "finance", "code", "seo", "research", "media"]) {
      expect(categories.has(category as never)).toBe(true);
    }
    for (const tool of fleetTools()) {
      expect(tool.p95Ms).toBeGreaterThanOrEqual(150);
      expect(Number(tool.priceUsdc)).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(80);
    }
  });

  it("delivers a schema-valid result for every listing on its example, on empty input, and on garbage", () => {
    for (const draft of rosterFleetListings()) {
      expect(isRosterFleetName(draft.name)).toBe(true);
      const schema = parseResultSchema(sandboxJobSchema(draft.name));
      const examples = (draft.inputSchema as { examples?: unknown[] }).examples ?? [];
      for (const input of [...examples, ...GARBAGE]) {
        const result = sandboxExecute(draft.name, input);
        const verdict = validateResult(schema, result);
        if (!verdict.ok) throw new Error(`${draft.name} with ${JSON.stringify(input)}: ${verdict.errors.join("; ")}`);
      }
    }
  });

  it("does real work on the examples", () => {
    expect(sandboxExecute("IBAN validator", { iban: "ES91 2100 0418 4502 0005 1332" })).toMatchObject({ valid: true, country: "ES" });
    expect(sandboxExecute("IBAN validator", { iban: "ES91 2100 0418 4502 0005 1333" })).toMatchObject({ valid: false });
    expect(sandboxExecute("Card number validator", { number: "4242 4242 4242 4242" })).toMatchObject({ valid: true, brand: "visa" });
    expect(sandboxExecute("EU VAT calculator", { amount: 100, country: "ES" })).toMatchObject({ gross: "121.00", vat: "21.00" });
    expect(sandboxExecute("Sentiment analyzer", { text: "I love it, great and fast" })).toMatchObject({ label: "positive" });
    expect(sandboxExecute("Language detector", { text: "Bon dia, voldria saber quan arribarà la meva comanda." })).toMatchObject({ language: "ca" });
    expect(sandboxExecute("Unit converter pro", { value: 100, from: "c", to: "f" })).toMatchObject({ value: 212, supported: true });
    expect(sandboxExecute("Timezone converter", { datetime: "2026-10-05T18:30", fromZone: "Europe/Madrid", toZone: "UTC" })).toMatchObject({ converted: "2026-10-05T16:30:00", valid: true });
    expect(sandboxExecute("Glossary translator English to Spanish", { text: "Thank you" })).toMatchObject({ translation: "Gracias" });
    const invoice = sandboxExecute("Invoice parser", { text: "ACME S.L.\nInvoice No: INV-9\nDate: 2026-09-30\nGPU hours ... 120.00\nTotal: 145.20 EUR" });
    expect(invoice).toMatchObject({ vendor: "ACME S.L.", invoiceNumber: "INV-9", issueDate: "2026-09-30", total: "145.20", currency: "EUR" });
    const cleaned = sandboxExecute("CSV cleaner", { csv: "Email,Name\nA@X.IO , Anna\na@x.io,Anna\n,\n" });
    expect(cleaned).toMatchObject({ rowsIn: 3, rowsOut: 1, duplicatesRemoved: 1, emptyRemoved: 1 });
    const review = sandboxExecute("Code review linter", { code: "var x = 1\neval(x)\n" }) as { findings: { rule: string }[] };
    expect(review.findings.map((finding) => finding.rule)).toEqual(expect.arrayContaining(["no-var", "no-eval"]));
    const image = sandboxExecute("Image header inspector", {
      base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    });
    expect(image).toMatchObject({ format: "png", width: 1, height: 1 });
    const pii = sandboxExecute("PII redactor", { text: "Mail jane@example.com now" }) as { text: string };
    expect(pii.text).toBe("Mail [EMAIL] now");
    const cron = sandboxExecute("Cron expression explainer", { expression: "0 9 * * 1", from: "2026-10-05T10:00:00Z", count: 2 });
    expect(cron).toMatchObject({ valid: true, nextRuns: ["2026-10-12T09:00:00.000Z", "2026-10-19T09:00:00.000Z"] });
  });

  it("is discoverable through registry keyword and semantic search", () => {
    const registry = new CapabilityRegistry();
    for (const draft of rosterFleetListings()) registry.register("org_fleet", draft);
    const top = (q: string, semantic = false) =>
      registry.search({ q, tags: [], maxPriceUsdc: null, maxP95Ms: null, limit: 3, withReputation: false, semantic })[0]?.listing.name;
    expect(top("translate english to catalan")).toBe("Glossary translator English to Catalan");
    expect(top("clean messy csv spreadsheet")).toBe("CSV cleaner");
    expect(top("review my pull request code")).toBe("Code review linter");
    expect(top("seo content brief for a keyword", true)).toBe("SEO content brief");
    const invoiceHits = registry
      .search({ q: "parse invoice pdf text", tags: [], maxPriceUsdc: null, maxP95Ms: null, limit: 3, withReputation: false, semantic: true })
      .map((hit) => hit.listing.name);
    expect(invoiceHits).toContain("Invoice parser");
  });
});
