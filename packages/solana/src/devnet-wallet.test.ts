import { describe, expect, it } from "vitest";
import { Keypair, Transaction } from "@solana/web3.js";
import { SolanaDevnetWalletProvider, testFeePayerSecret } from "./devnet-wallet.js";

describe("SolanaDevnetWalletProvider (offline sender)", () => {
  it("creates addresses, credits, and transfers with a fake sender", async () => {
    const signatures: string[] = [];
    const wallet = new SolanaDevnetWalletProvider({
      feePayerSecret: testFeePayerSecret(),
      skipAirdrop: true,
      offlineLedger: true,
      sender: async (_tx: Transaction, _signers: Keypair[]) => {
        const sig = `DevnetTestSig${signatures.length.toString().padStart(70, "x")}`;
        signatures.push(sig);
        return sig;
      },
    });

    const buyer = await wallet.createAddress("agent:buyer");
    const hold = await wallet.createAddress("escrow:esc_test");
    const seller = await wallet.createAddress("agent:seller");
    expect(buyer.address).not.toMatch(/^mock:/);

    await wallet.credit(buyer.address, "1.000000");
    expect(signatures.length).toBeGreaterThan(0);

    const lock = await wallet.transfer({
      fromAddress: buyer.address,
      toAddress: hold.address,
      amountUsdc: "0.500000",
      idempotencyKey: "lock-1",
    });
    expect(lock.chain).toBe("solana-devnet");
    expect(lock.providerRef.length).toBeGreaterThan(60);

    const release = await wallet.transfer({
      fromAddress: hold.address,
      toAddress: seller.address,
      amountUsdc: "0.495000",
      idempotencyKey: "release-1",
    });
    expect(release.providerRef).not.toBe(lock.providerRef);

    const status = await wallet.status();
    expect(status.rail).toBe("solana-devnet");
    expect(status.label).toContain("devnet");
    expect(status.feePayer).toBe(wallet.feePayerPublicKey);
  });
});
