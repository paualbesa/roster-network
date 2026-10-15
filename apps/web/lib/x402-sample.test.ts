import { describe, expect, it } from "vitest";
import { atomicUsdc, parsePaymentRequired, transcript } from "./x402-sample";

const header = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    resource: { description: "SEC ticker lookup: resolve a ticker" },
    accepts: [{ scheme: "exact", network: "solana:devnet", amount: "10000", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", payTo: "8s1QdYzbHkoMthqzuX1mzb9A1PaQZw8SPWV5Jz5iyZjW", maxTimeoutSeconds: 64 }],
  }),
).toString("base64");

describe("x402 sample", () => {
  it("decodes the header", () => {
    const p = parsePaymentRequired(header);
    expect(p.version).toBe(2);
    expect(p.description).toBe("SEC ticker lookup");
    expect(p.accept?.amount).toBe("10000");
  });
  it("tolerates junk", () => {
    expect(parsePaymentRequired("%%%").accept).toBeNull();
    expect(parsePaymentRequired(null).version).toBeNull();
  });
  it("formats USDC", () => {
    expect(atomicUsdc("10000")).toBe("0.01");
    expect(atomicUsdc("1000000")).toBe("1");
    expect(atomicUsdc("1500000")).toBe("1.5");
  });
  it("prints a transcript", () => {
    const t = transcript({ url: "https://x/y", status: 402, ...parsePaymentRequired(header) });
    expect(t).toContain("HTTP/2 402");
    expect(t).toContain("0.01 USDC");
  });
});
