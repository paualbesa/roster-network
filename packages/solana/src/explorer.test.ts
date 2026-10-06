import { describe, expect, it } from "vitest";
import { looksLikeSolanaSignature, solanaExplorerTxUrl } from "./explorer.js";

describe("explorer helpers", () => {
  it("builds a labeled Devnet explorer URL", () => {
    const sig = "5".padEnd(88, "A");
    expect(solanaExplorerTxUrl(sig, "devnet")).toBe(
      `https://explorer.solana.com/tx/${encodeURIComponent(sig)}?cluster=devnet`,
    );
    expect(solanaExplorerTxUrl("mock_tx_1", "devnet")).toBeNull();
  });

  it("detects Solana signatures", () => {
    expect(looksLikeSolanaSignature("mock_tx_9")).toBe(false);
    expect(looksLikeSolanaSignature("5".padEnd(88, "A"))).toBe(true);
  });
});
