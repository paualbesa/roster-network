import { Keypair, MessageV0 } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { encodeBase58 } from "./base58.js";
import { USDC_MINT_DEVNET } from "./constants.js";
import { mockSolanaEngineConfig } from "./config.js";
import { prepareLock, settleEscrow } from "./engine.js";
import { sandboxBlockhash, sandboxFeePayerPublicKey, sandboxProgramAuthorityPublicKey, verifyEd25519 } from "./keys.js";
import { deserializeVersionedTransaction } from "./transaction.js";

const BUYER = Keypair.generate().publicKey.toBase58();
const PROVIDER = Keypair.generate().publicKey.toBase58();

function transfers(base64: string): { opcode: number; amount: bigint; dest: string; owner: string }[] {
  const tx = deserializeVersionedTransaction(base64);
  expect(tx.message).toBeInstanceOf(MessageV0);
  const message = tx.message as MessageV0;
  return message.compiledInstructions.map((instruction) => {
    const data = Buffer.from(instruction.data);
    const destIndex = instruction.accountKeyIndexes[1];
    const ownerIndex = instruction.accountKeyIndexes[2];
    const dest = destIndex === undefined ? undefined : message.staticAccountKeys[destIndex];
    const owner = ownerIndex === undefined ? undefined : message.staticAccountKeys[ownerIndex];
    return {
      opcode: data[0] ?? -1,
      amount: data.readBigUInt64LE(1),
      dest: dest?.toBase58() ?? "",
      owner: owner?.toBase58() ?? "",
    };
  });
}

describe("VersionedTransaction lock and settle", () => {
  it("partially signs the lock as the sandbox fee payer and leaves the buyer slot empty", async () => {
    const locked = await prepareLock(
      { buyerPubkey: BUYER, amountUsdc: "1.00", escrowId: "escrow_demo", jobId: "job_demo" },
      mockSolanaEngineConfig(),
    );
    expect(locked.broadcast).toBe(false);
    expect(locked.feePayer).toBe(sandboxFeePayerPublicKey().toBase58());
    expect(locked.feePayerSignature).toBe("sandbox");
    expect(locked.buyerSigned).toBe(false);
    expect(locked.mint).toBe(USDC_MINT_DEVNET);
    expect(locked.quote.rosterFeeUsdc).toBe("0.013000");
    expect(locked.quote.providerPayoutUsdc).toBe("0.987000");

    const tx = deserializeVersionedTransaction(locked.transaction);
    const again = deserializeVersionedTransaction(locked.transaction);
    expect(Buffer.from(again.serialize())).toEqual(Buffer.from(tx.serialize()));
    expect(tx.message).toBeInstanceOf(MessageV0);
    const message = tx.message as MessageV0;
    expect(message.header.numRequiredSignatures).toBe(2);
    expect(message.staticAccountKeys[0]?.toBase58()).toBe(locked.feePayer);
    expect(message.recentBlockhash).toBe(locked.recentBlockhash);

    const feePayerSignature = tx.signatures[0];
    const buyerSignature = tx.signatures[1];
    expect(feePayerSignature).toBeDefined();
    expect(buyerSignature?.every((byte) => byte === 0)).toBe(true);
    expect(
      verifyEd25519(message.staticAccountKeys[0]!.toBytes(), message.serialize(), feePayerSignature!),
    ).toBe(true);

    const [transfer] = transfers(locked.transaction);
    expect(transfer?.opcode).toBe(3);
    expect(transfer?.amount).toBe(1_000_000n);
    expect(transfer?.dest).toBe(locked.escrowAta);
  });

  it("uses a mock signature when the fee payer pubkey is configured without a secret", async () => {
    const declared = Keypair.generate().publicKey.toBase58();
    const locked = await prepareLock(
      { buyerPubkey: BUYER, amountUsdc: "2" },
      mockSolanaEngineConfig({ feePayerPubkey: declared, feePayerSecret: "not-a-real-secret" }),
    );
    expect(locked.feePayer).toBe(declared);
    expect(locked.feePayerSignature).toBe("mock");
    const tx = deserializeVersionedTransaction(locked.transaction);
    expect(tx.signatures[0]?.every((byte) => byte === 0x11)).toBe(true);
  });

  it("settles provider payout and the Roster fee into the treasury ATA", async () => {
    const treasury = Keypair.generate().publicKey.toBase58();
    const locked = await prepareLock(
      { buyerPubkey: BUYER, amountUsdc: "4.00", escrowId: "escrow_settle" },
      mockSolanaEngineConfig(),
    );
    const settled = await settleEscrow(
      {
        escrowId: locked.escrowId,
        buyerPubkey: BUYER,
        providerPubkey: PROVIDER,
        amountUsdc: "4.00",
        verified: true,
        jobId: "job_settle",
      },
      mockSolanaEngineConfig({ treasuryUsdcAta: treasury }),
    );

    expect(settled.broadcast).toBe(false);
    expect(settled.submitted).toBe(false);
    expect(settled.broadcastNote).toBeNull();
    expect(settled.signature).toBeTruthy();
    expect(settled.escrowPda).toBe(locked.escrowPda);
    expect(settled.escrowAta).toBe(locked.escrowAta);
    expect(settled.programAuthority).toBe(sandboxProgramAuthorityPublicKey().toBase58());
    expect(settled.treasuryUsdcAta).toBe(treasury);
    expect(settled.quote).toMatchObject({
      rosterFeeUsdc: "0.043000",
      providerPayoutUsdc: "3.957000",
    });

    const tx = deserializeVersionedTransaction(settled.transaction);
    expect(tx.message).toBeInstanceOf(MessageV0);
    const message = tx.message as MessageV0;
    expect(message.header.numRequiredSignatures).toBe(2);
    expect(message.staticAccountKeys[0]?.toBase58()).toBe(settled.feePayer);
    expect(verifyEd25519(sandboxFeePayerPublicKey().toBytes(), message.serialize(), tx.signatures[0]!)).toBe(true);
    expect(verifyEd25519(sandboxProgramAuthorityPublicKey().toBytes(), message.serialize(), tx.signatures[1]!)).toBe(true);

    const [payout, fee] = transfers(settled.transaction);
    expect(payout).toMatchObject({ opcode: 3, amount: 3_957_000n, dest: settled.providerTokenAccount });
    expect(fee).toMatchObject({ opcode: 3, amount: 43_000n, dest: treasury, owner: settled.programAuthority });
    expect((payout?.amount ?? 0n) + (fee?.amount ?? 0n)).toBe(4_000_000n);
  });

  it("refuses settle before verification and refuses an unarmed mainnet cluster", async () => {
    await expect(
      settleEscrow(
        { escrowId: "escrow_x", buyerPubkey: BUYER, providerPubkey: PROVIDER, amountUsdc: "1", verified: false },
        mockSolanaEngineConfig(),
      ),
    ).rejects.toThrow(/verified/);

    await expect(
      prepareLock({ buyerPubkey: BUYER, amountUsdc: "1" }, mockSolanaEngineConfig({ cluster: "mainnet-beta" })),
    ).rejects.toThrow(/mainnet-beta signing is disabled/);
  });

  it("signs with an env fee payer on devnet and still does not broadcast", async () => {
    const feePayer = Keypair.generate();
    const authority = Keypair.generate();
    const treasury = Keypair.generate().publicKey.toBase58();
    const config = mockSolanaEngineConfig({
      cluster: "devnet",
      feePayerPubkey: feePayer.publicKey.toBase58(),
      feePayerSecret: JSON.stringify(Array.from(feePayer.secretKey)),
      programAuthoritySecret: encodeBase58(authority.secretKey),
      treasuryUsdcAta: treasury,
      send: true,
    });
    const settled = await settleEscrow(
      { escrowId: "escrow_dev", buyerPubkey: BUYER, providerPubkey: PROVIDER, amountUsdc: "1", verified: true },
      config,
    );
    expect(settled.broadcast).toBe(false);
    expect(settled.broadcastNote).toBe("SOLANA_RPC_URL is unset");
    expect(settled.feePayer).toBe(feePayer.publicKey.toBase58());
    expect(settled.feePayerSignature).toBe("env");
    expect(settled.programAuthority).toBe(authority.publicKey.toBase58());
    const tx = deserializeVersionedTransaction(settled.transaction);
    const message = tx.message as MessageV0;
    expect(verifyEd25519(feePayer.publicKey.toBytes(), message.serialize(), tx.signatures[0]!)).toBe(true);
  });

  it("broadcasts only through the injected sender when every live gate is open", async () => {
    const feePayer = Keypair.generate();
    const authority = Keypair.generate();
    const calls: number[] = [];
    const settled = await settleEscrow(
      { escrowId: "escrow_send", buyerPubkey: BUYER, providerPubkey: PROVIDER, amountUsdc: "1", verified: true },
      mockSolanaEngineConfig({
        cluster: "devnet",
        feePayerSecret: JSON.stringify(Array.from(feePayer.secretKey)),
        programAuthoritySecret: JSON.stringify(Array.from(authority.secretKey)),
        treasuryUsdcAta: Keypair.generate().publicKey.toBase58(),
        rpcUrl: "http://127.0.0.1:9",
        send: true,
      }),
      {
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ jsonrpc: "2.0", result: { value: { blockhash: sandboxBlockhash() } } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        sender: async (bytes) => {
          calls.push(bytes.length);
          return "test-signature";
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(settled.broadcast).toBe(true);
    expect(settled.submitted).toBe(true);
    expect(settled.signature).toBe("test-signature");
    expect(settled.broadcastNote).toBeNull();
  });
});
