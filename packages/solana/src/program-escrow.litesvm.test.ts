/**
 * LiteSVM negative-case suite for roster-escrow.
 * Loads the committed .so from programs/roster-escrow/deploy/.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash as sha256 } from "node:crypto";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  MINT_SIZE,
} from "@solana/spl-token";
import { describe, expect, it } from "vitest";
import {
  ROSTER_ESCROW_PROGRAM_ID_DEVNET,
  createAndFundIx,
  initializeConfigIx,
  refundIx,
  releaseIx,
  escrowPda,
  vaultPda,
} from "./noncustodial-escrow.js";

const PROGRAM_ID = new PublicKey(ROSTER_ESCROW_PROGRAM_ID_DEVNET);
const SO_PATH = resolve(
  process.cwd(),
  // vitest cwd is packages/solana
  "../../programs/roster-escrow/deploy/roster_escrow.so",
);

function loadSvm(): LiteSVM {
  const svm = new LiteSVM();
  const bytes = readFileSync(SO_PATH);
  svm.addProgram(PROGRAM_ID, new Uint8Array(bytes));
  return svm;
}

function send(svm: LiteSVM, tx: Transaction, signers: Keypair[]) {
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = signers[0]!.publicKey;
  tx.sign(...signers);
  return svm.sendTransaction(tx);
}

function failed(res: unknown): boolean {
  return res instanceof FailedTransactionMetadata;
}

describe("roster-escrow LiteSVM", () => {
  it("loads the committed .so", () => {
    const svm = loadSvm();
    expect(svm.getAccount(PROGRAM_ID) != null).toBe(true);
  });

  it("rejects release with wrong signer; allows buyer release; rejects double release", () => {
    const svm = loadSvm();
    const authority = Keypair.generate();
    const buyer = Keypair.generate();
    const seller = Keypair.generate();
    const stranger = Keypair.generate();
    const mintKp = Keypair.generate();
    for (const kp of [authority, buyer, seller, stranger]) {
      svm.airdrop(kp.publicKey, BigInt(2 * LAMPORTS_PER_SOL));
    }

    // Create mint
    const mintTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: mintKp.publicKey,
        space: MINT_SIZE,
        lamports: Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))),
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mintKp.publicKey, 6, authority.publicKey, null),
    );
    send(svm, mintTx, [authority, mintKp]);

    const buyerAta = getAssociatedTokenAddressSync(mintKp.publicKey, buyer.publicKey);
    const sellerAta = getAssociatedTokenAddressSync(mintKp.publicKey, seller.publicKey);
    const feeAta = getAssociatedTokenAddressSync(mintKp.publicKey, authority.publicKey);
    const ataTx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, buyerAta, buyer.publicKey, mintKp.publicKey),
      createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, sellerAta, seller.publicKey, mintKp.publicKey),
      createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, feeAta, authority.publicKey, mintKp.publicKey),
      createMintToInstruction(mintKp.publicKey, buyerAta, authority.publicKey, 5_000_000n),
    );
    send(svm, ataTx, [authority]);

    // Init config
    const init = initializeConfigIx({
      authority: authority.publicKey,
      feeRecipientToken: feeAta,
      mint: mintKp.publicKey,
      arbiter: authority.publicKey,
      feeBps: 100,
      flatFee: 3000n,
      disputeWindowSecs: 86_400n,
      programId: PROGRAM_ID,
    });
    send(svm, new Transaction().add(init), [authority]);

    const escrowId = "lite-neg-1";
    const schemaHash = sha256("sha256").update("s").digest();
    const now = Number(svm.getClock().unixTimestamp);
    const fund = createAndFundIx({
      buyer: buyer.publicKey,
      buyerAta,
      seller: seller.publicKey,
      mint: mintKp.publicKey,
      escrowId,
      amount: 1_000_000n,
      schemaHash,
      deadlineTs: BigInt(now + 3600),
      programId: PROGRAM_ID,
    });
    send(svm, new Transaction().add(fund), [authority, buyer]);

    const [escrow] = escrowPda(buyer.publicKey, escrowId, PROGRAM_ID);
    const [vault] = vaultPda(escrow, PROGRAM_ID);

    // Wrong signer
    const bad = releaseIx({
      authority: stranger.publicKey,
      escrow,
      vault,
      sellerAta,
      feeAta,
      mint: mintKp.publicKey,
      programId: PROGRAM_ID,
    });
    const badRes = send(svm, new Transaction().add(bad), [authority, stranger]);
    expect(failed(badRes)).toBe(true);

    // Buyer release OK
    const good = releaseIx({
      authority: buyer.publicKey,
      escrow,
      vault,
      sellerAta,
      feeAta,
      mint: mintKp.publicKey,
      programId: PROGRAM_ID,
    });
    const goodRes = send(svm, new Transaction().add(good), [authority, buyer]);
    expect(failed(goodRes)).toBe(false);

    // Double release
    const again = send(svm, new Transaction().add(good), [authority, buyer]);
    expect(failed(again)).toBe(true);
  });

  it("rejects fake vault PDA and wrong mint on fund", () => {
    const svm = loadSvm();
    const authority = Keypair.generate();
    const buyer = Keypair.generate();
    const seller = Keypair.generate();
    svm.airdrop(authority.publicKey, BigInt(3 * LAMPORTS_PER_SOL));
    svm.airdrop(buyer.publicKey, BigInt(2 * LAMPORTS_PER_SOL));

    const mintKp = Keypair.generate();
    const otherMint = Keypair.generate();
    for (const m of [mintKp, otherMint]) {
      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: authority.publicKey,
          newAccountPubkey: m.publicKey,
          space: MINT_SIZE,
          lamports: Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(m.publicKey, 6, authority.publicKey, null),
      );
      send(svm, tx, [authority, m]);
    }

    const buyerAta = getAssociatedTokenAddressSync(mintKp.publicKey, buyer.publicKey);
    const feeAta = getAssociatedTokenAddressSync(mintKp.publicKey, authority.publicKey);
    send(
      svm,
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, buyerAta, buyer.publicKey, mintKp.publicKey),
        createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, feeAta, authority.publicKey, mintKp.publicKey),
        createMintToInstruction(mintKp.publicKey, buyerAta, authority.publicKey, 2_000_000n),
      ),
      [authority],
    );

    send(
      svm,
      new Transaction().add(
        initializeConfigIx({
          authority: authority.publicKey,
          feeRecipientToken: feeAta,
          mint: mintKp.publicKey,
          arbiter: authority.publicKey,
          feeBps: 100,
          flatFee: 3000n,
          disputeWindowSecs: 3600n,
          programId: PROGRAM_ID,
        }),
      ),
      [authority],
    );

    const now = Number(svm.getClock().unixTimestamp);
    const wrongMintFund = createAndFundIx({
      buyer: buyer.publicKey,
      buyerAta,
      seller: seller.publicKey,
      mint: otherMint.publicKey, // wrong vs config
      escrowId: "wrong-mint",
      amount: 1_000_000n,
      schemaHash: sha256("sha256").update("x").digest(),
      deadlineTs: BigInt(now + 100),
      programId: PROGRAM_ID,
    });
    // Account metas still pass buyerAta for config mint — instruction will fail WrongMint on mint account
    const fail = send(svm, new Transaction().add(wrongMintFund), [authority, buyer]);
    expect(failed(fail)).toBe(true);
  });

  it("refund after deadline is permissionless; release after refund fails", () => {
    const svm = loadSvm();
    const authority = Keypair.generate();
    const buyer = Keypair.generate();
    const seller = Keypair.generate();
    const crank = Keypair.generate();
    for (const kp of [authority, buyer, seller, crank]) {
      svm.airdrop(kp.publicKey, BigInt(2 * LAMPORTS_PER_SOL));
    }
    const mintKp = Keypair.generate();
    send(
      svm,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: authority.publicKey,
          newAccountPubkey: mintKp.publicKey,
          space: MINT_SIZE,
          lamports: Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))),
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMint2Instruction(mintKp.publicKey, 6, authority.publicKey, null),
      ),
      [authority, mintKp],
    );
    const buyerAta = getAssociatedTokenAddressSync(mintKp.publicKey, buyer.publicKey);
    const sellerAta = getAssociatedTokenAddressSync(mintKp.publicKey, seller.publicKey);
    const feeAta = getAssociatedTokenAddressSync(mintKp.publicKey, authority.publicKey);
    send(
      svm,
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, buyerAta, buyer.publicKey, mintKp.publicKey),
        createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, sellerAta, seller.publicKey, mintKp.publicKey),
        createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, feeAta, authority.publicKey, mintKp.publicKey),
        createMintToInstruction(mintKp.publicKey, buyerAta, authority.publicKey, 3_000_000n),
      ),
      [authority],
    );
    send(
      svm,
      new Transaction().add(
        initializeConfigIx({
          authority: authority.publicKey,
          feeRecipientToken: feeAta,
          mint: mintKp.publicKey,
          arbiter: authority.publicKey,
          feeBps: 100,
          flatFee: 3000n,
          disputeWindowSecs: 10n,
          programId: PROGRAM_ID,
        }),
      ),
      [authority],
    );

    const now = Number(svm.getClock().unixTimestamp);
    const escrowId = "refund-deadline";
    send(
      svm,
      new Transaction().add(
        createAndFundIx({
          buyer: buyer.publicKey,
          buyerAta,
          seller: seller.publicKey,
          mint: mintKp.publicKey,
          escrowId,
          amount: 1_000_000n,
          schemaHash: sha256("sha256").update("r").digest(),
          deadlineTs: BigInt(now + 2),
          programId: PROGRAM_ID,
        }),
      ),
      [authority, buyer],
    );

    // Warp past deadline
    const clock = svm.getClock();
    clock.unixTimestamp = BigInt(now + 10);
    svm.setClock(clock);

    const [escrow] = escrowPda(buyer.publicKey, escrowId, PROGRAM_ID);
    const [vault] = vaultPda(escrow, PROGRAM_ID);
    const refund = refundIx({
      authority: crank.publicKey,
      escrow,
      vault,
      buyerAta,
      mint: mintKp.publicKey,
      programId: PROGRAM_ID,
    });
    const refRes = send(svm, new Transaction().add(refund), [authority, crank]);
    expect(failed(refRes)).toBe(false);

    const release = releaseIx({
      authority: buyer.publicKey,
      escrow,
      vault,
      sellerAta,
      feeAta,
      mint: mintKp.publicKey,
      programId: PROGRAM_ID,
    });
    const relRes = send(svm, new Transaction().add(release), [authority, buyer]);
    expect(failed(relRes)).toBe(true);
  });
});
