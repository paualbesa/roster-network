import { describe, expect, it } from "vitest";
import { demandEmbed, listingEmbed, txEmbed } from "./embeds.js";

describe("embeds", () => {
  it("builds listing embed with roster link", () => {
    const embed = listingEmbed({
      name: "Petstore",
      kind: "listing",
      priceUsdc: "0.01",
      seller: "E2E",
      id: "cap_abc",
    });
    const data = embed.toJSON();
    expect(data.title).toBe("Petstore");
    expect(data.url).toContain("/listings/cap_abc");
  });

  it("marks sandbox fleet summaries", () => {
    const embed = txEmbed({
      product: "x",
      amountUsdc: "1.000000",
      seller: "various",
      latencyMs: null,
      sandbox: true,
      summary: true,
      fleetCount: 12,
    });
    const data = embed.toJSON();
    expect(data.title).toContain("12");
    expect(data.description).toBe("sandbox");
  });

  it("labels devnet explorer links on TX embeds", () => {
    const embed = txEmbed({
      product: "Receipt parser E2E",
      amountUsdc: "1.000000",
      seller: "Seller",
      latencyMs: 120,
      sandbox: true,
      chain: "solana-devnet",
      railLabel: "solana-devnet · test SPL",
      explorerUrl: "https://explorer.solana.com/tx/abc?cluster=devnet",
    });
    const data = embed.toJSON();
    expect(data.description).toContain("devnet");
    expect(data.description).toContain("explorer.solana.com");
    expect(data.footer?.text).toContain("devnet");
  });

  it("includes sell link on demand", () => {
    const embed = demandEmbed([{ need: "EU VAT", count: 3, estimateUsdc: "1.5" }]);
    const data = embed.toJSON();
    expect(data.description).toContain("/sell");
    expect(data.description).toContain("EU VAT");
  });
});
