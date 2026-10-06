import { createHash } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  ROSTER_ESCROW_PROGRAM_ID_DEVNET,
  computeOnChainFeeMicros,
  configPda,
  createAndFundIx,
  escrowIdBytes,
  escrowPda,
  releaseIx,
  refundIx,
  vaultPda,
} from "./noncustodial-escrow.js";

const PROGRAM = new PublicKey(ROSTER_ESCROW_PROGRAM_ID_DEVNET);

describe("noncustodial escrow client", () => {
  it("fee math matches Rust / docs (10 USDC → 103_000)", () => {
    expect(computeOnChainFeeMicros(10_000_000n)).toBe(103_000n);
    expect(() => computeOnChainFeeMicros(2_000n)).toThrow(/fee exceeds/);
  });

  it("PDA seeds are stable and distinct", () => {
    const buyer = Keypair.generate().publicKey;
    const id = "escrow_test_1";
    const [escrowA] = escrowPda(buyer, id, PROGRAM);
    const [escrowB] = escrowPda(buyer, id, PROGRAM);
    expect(escrowA.equals(escrowB)).toBe(true);
    const [vault] = vaultPda(escrowA, PROGRAM);
    expect(vault.equals(escrowA)).toBe(false);
    const [cfg] = configPda(PROGRAM);
    expect(cfg.equals(vault)).toBe(false);
  });

  it("escrowId longer than 32 bytes is hashed", () => {
    const long = "x".repeat(80);
    expect(escrowIdBytes(long)).toEqual(createHash("sha256").update(long).digest());
  });

  it("createAndFund / release / refund instruction layouts", () => {
    const buyer = Keypair.generate().publicKey;
    const seller = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const buyerAta = Keypair.generate().publicKey;
    const schemaHash = createHash("sha256").update("schema").digest();
    const fund = createAndFundIx({
      buyer,
      buyerAta,
      seller,
      mint,
      escrowId: "job_1",
      amount: 1_000_000n,
      schemaHash,
      deadlineTs: BigInt(Math.floor(Date.now() / 1000) + 3600),
      programId: PROGRAM,
    });
    expect(fund.programId.equals(PROGRAM)).toBe(true);
    expect(fund.data[0]).toBe(1);
    expect(fund.keys[0].isSigner).toBe(true);

    const [escrow] = escrowPda(buyer, "job_1", PROGRAM);
    const [vault] = vaultPda(escrow, PROGRAM);
    const rel = releaseIx({
      authority: buyer,
      escrow,
      vault,
      sellerAta: Keypair.generate().publicKey,
      feeAta: Keypair.generate().publicKey,
      mint,
      programId: PROGRAM,
    });
    expect(rel.data[0]).toBe(2);

    const ref = refundIx({
      authority: buyer,
      escrow,
      vault,
      buyerAta,
      mint,
      programId: PROGRAM,
    });
    expect(ref.data[0]).toBe(3);
  });

  it("wrong-signer negative: release authority must be first signer meta", () => {
    const buyer = Keypair.generate().publicKey;
    const [escrow] = escrowPda(buyer, "neg", PROGRAM);
    const [vault] = vaultPda(escrow, PROGRAM);
    const stranger = Keypair.generate().publicKey;
    const ix = releaseIx({
      authority: stranger,
      escrow,
      vault,
      sellerAta: Keypair.generate().publicKey,
      feeAta: Keypair.generate().publicKey,
      mint: Keypair.generate().publicKey,
      programId: PROGRAM,
    });
    expect(ix.keys[0].pubkey.equals(stranger)).toBe(true);
    expect(ix.keys[0].isSigner).toBe(true);
  });
});
