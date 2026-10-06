#!/usr/bin/env node
/**
 * Real DEVNET E2E against roster-escrow: fund→release and fund→refund.
 * Uses Roster SPL mint (fee-payer is mint authority). Never logs secret key bytes.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from "@solana/spl-token";
import {
  createAndFundIx,
  initializeConfigIx,
  refundIx,
  releaseIx,
  escrowPda,
  vaultPda,
  configPda,
  computeOnChainFeeMicros,
  ROSTER_ESCROW_PROGRAM_ID_DEVNET,
} from "../packages/solana/dist/noncustodial-escrow.js";

function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function explorer(sig) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

const DATA = process.env.ROSTER_DATA_DIR || "/home/ats-server/albesa/roster-data";
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const FEE_PAYER_PATH = process.env.ROSTER_FEE_PAYER_KEYPAIR || `${DATA}/solana-devnet-fee-payer.json`;
const PROGRAM_ID = new PublicKey(process.env.ROSTER_ESCROW_PROGRAM_ID || ROSTER_ESCROW_PROGRAM_ID_DEVNET);
const MINT = new PublicKey(process.env.ROSTER_SPL_MINT || "FdpWC2FjrZ1RTQ1gbGG1Brp3pvVwkxw9FYeThaPZyC38");

const connection = new Connection(RPC, "confirmed");
const feePayer = loadKeypair(FEE_PAYER_PATH);
const buyer = Keypair.generate();
const seller = Keypair.generate();

console.log(JSON.stringify({
  programId: PROGRAM_ID.toBase58(),
  mint: MINT.toBase58(),
  feePayer: feePayer.publicKey.toBase58(),
  buyer: buyer.publicKey.toBase58(),
  seller: seller.publicKey.toBase58(),
}));

async function fundSol(to, lamports) {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: feePayer.publicKey, toPubkey: to, lamports }),
  );
  return sendAndConfirmTransaction(connection, tx, [feePayer]);
}

await fundSol(buyer.publicKey, 50_000_000);
await fundSol(seller.publicKey, 20_000_000);

const buyerAta = getAssociatedTokenAddressSync(MINT, buyer.publicKey);
const sellerAta = getAssociatedTokenAddressSync(MINT, seller.publicKey);
const feeAta = getAssociatedTokenAddressSync(MINT, feePayer.publicKey);

async function ensureAta(ata, owner) {
  try {
    await getAccount(connection, ata);
  } catch {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(feePayer.publicKey, ata, owner, MINT),
    );
    await sendAndConfirmTransaction(connection, tx, [feePayer]);
  }
}

await ensureAta(buyerAta, buyer.publicKey);
await ensureAta(sellerAta, seller.publicKey);
await ensureAta(feeAta, feePayer.publicKey);

const mintToSig = await sendAndConfirmTransaction(
  connection,
  new Transaction().add(createMintToInstruction(MINT, buyerAta, feePayer.publicKey, 5_000_000n)),
  [feePayer],
);
console.log("mintTo buyer", explorer(mintToSig));

const [config] = configPda(PROGRAM_ID);
const cfgInfo = await connection.getAccountInfo(config);
if (!cfgInfo) {
  const ix = initializeConfigIx({
    authority: feePayer.publicKey,
    feeRecipientToken: feeAta,
    mint: MINT,
    arbiter: feePayer.publicKey,
    feeBps: 100,
    flatFee: 3000n,
    disputeWindowSecs: 86_400n,
    programId: PROGRAM_ID,
  });
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [feePayer]);
  console.log("initializeConfig", explorer(sig));
} else {
  console.log("config exists", config.toBase58());
}

async function runFlow(label, { release }) {
  const escrowId = `${label}-${Date.now()}`;
  const amount = 1_000_000n;
  const fee = computeOnChainFeeMicros(amount);
  const schemaHash = createHash("sha256").update(`schema:${label}`).digest();
  const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + (release ? 3600 : 3));
  const [escrow] = escrowPda(buyer.publicKey, escrowId, PROGRAM_ID);
  const [vault] = vaultPda(escrow, PROGRAM_ID);

  const fundIx = createAndFundIx({
    buyer: buyer.publicKey,
    buyerAta,
    seller: seller.publicKey,
    mint: MINT,
    escrowId,
    amount,
    schemaHash,
    deadlineTs,
    programId: PROGRAM_ID,
  });
  const fundSig = await sendAndConfirmTransaction(connection, new Transaction().add(fundIx), [feePayer, buyer]);
  console.log(label, "fund", explorer(fundSig), { escrow: escrow.toBase58(), vault: vault.toBase58(), fee: fee.toString() });

  if (release) {
    const ix = releaseIx({
      authority: buyer.publicKey,
      escrow,
      vault,
      sellerAta,
      feeAta,
      mint: MINT,
      programId: PROGRAM_ID,
    });
    const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [feePayer, buyer]);
    console.log(label, "release", explorer(sig));
    return { fundSig, settleSig: sig, kind: "release", explorerFund: explorer(fundSig), explorerSettle: explorer(sig) };
  }

  console.log(label, "waiting past deadline...");
  await new Promise((r) => setTimeout(r, 4500));
  const ix = refundIx({
    authority: feePayer.publicKey,
    escrow,
    vault,
    buyerAta,
    mint: MINT,
    programId: PROGRAM_ID,
  });
  const sig = await sendAndConfirmTransaction(connection, new Transaction().add(ix), [feePayer]);
  console.log(label, "refund", explorer(sig));
  return { fundSig, settleSig: sig, kind: "refund", explorerFund: explorer(fundSig), explorerSettle: explorer(sig) };
}

const releaseFlow = await runFlow("fund-release", { release: true });
const refundFlow = await runFlow("fund-refund", { release: false });
const bal = await connection.getBalance(feePayer.publicKey);
const out = {
  programId: PROGRAM_ID.toBase58(),
  mint: MINT.toBase58(),
  release: releaseFlow,
  refund: refundFlow,
  feePayerSolRemaining: bal / 1e9,
};
fs.mkdirSync(`${DATA}/escrow-e2e`, { recursive: true });
fs.writeFileSync(`${DATA}/escrow-e2e/last.json`, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
