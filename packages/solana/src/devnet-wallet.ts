import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  formatUsdc,
  parseUsdc,
  WalletProviderError,
} from "@albesa/core";
import type {
  MockWalletSnapshot,
  PersistentSandboxWallet,
  TransferRequest,
  TransferResult,
  WalletProvider,
} from "@albesa/core";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionSignature,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { keypairFromSecret } from "./keys.js";


const DEFAULT_RPC = "https://api.devnet.solana.com";
const RPC_RETRY_ATTEMPTS = 6;
const RPC_RETRY_BASE_MS = 400;

function isRetryableRpcError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /429|Too Many Requests|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up|fetch failed|503|502|504/i.test(
    msg,
  );
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff for public Devnet RPC 429s and transient network errors. */
export async function withRpcRetry<T>(fn: () => Promise<T>, label = "rpc"): Promise<T> {
  let delay = RPC_RETRY_BASE_MS;
  let last: unknown;
  for (let attempt = 0; attempt < RPC_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (!isRetryableRpcError(error) || attempt === RPC_RETRY_ATTEMPTS - 1) throw error;
      const wait = delay + Math.floor(Math.random() * 200);
      console.warn(
        JSON.stringify({
          t: new Date().toISOString(),
          msg: "solana-devnet rpc retry",
          label,
          attempt: attempt + 1,
          waitMs: wait,
          error: error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160),
        }),
      );
      await sleepMs(wait);
      delay = Math.min(delay * 2, 8_000);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

const TOKEN_DECIMALS = 6;

export interface SolanaDevnetWalletOptions {
  /** Fee-payer / mint-authority secret (JSON byte array or base58). Never logged. */
  feePayerSecret: string;
  rpcUrl?: string;
  /** Persist mint pubkey here so restarts reuse the same Roster test token. */
  mintStatePath?: string;
  /** Optional Commitment. */
  commitment?: "processed" | "confirmed" | "finalized";
  /** Injected connection for tests. */
  connection?: Connection;
  /** Skip live airdrop attempts (tests). */
  skipAirdrop?: boolean;
  /** Replace sendAndConfirm for tests. */
  sender?: (tx: Transaction, signers: Keypair[]) => Promise<string>;
  /**
   * Test-only: keep balances in the soft ledger and still call `sender` for
   * transferable signatures without dialing RPC for mint/ATA setup.
   */
  offlineLedger?: boolean;
}

export interface SolanaDevnetStatus {
  rail: "solana-devnet";
  cluster: "devnet";
  rpcUrl: string;
  feePayer: string;
  mint: string | null;
  feePayerSol: number | null;
  airdropOk: boolean | null;
  airdropError: string | null;
  label: "devnet · Roster test SPL (not mainnet)";
}

/**
 * Real Solana Devnet settlement rail for the sandbox.
 *
 * - Fee payer (treasury) signs and pays SOL fees.
 * - Agent/escrow addresses are deterministic keypairs derived from the fee payer seed
 *   (HMAC), so the process can sign without storing per-wallet secrets.
 * - Asset is a Roster-minted SPL token with 6 decimals (USDC-shaped). Circle's
 *   public Devnet USDC faucet is not automatable; minting keeps sandbox funding
 *   reliable while still producing real explorer signatures.
 */
export class SolanaDevnetWalletProvider implements WalletProvider, PersistentSandboxWallet {
  readonly id = "solana-devnet" as const;
  readonly chain = "solana-devnet" as const;

  private readonly connection: Connection;
  private readonly feePayer: Keypair;
  private readonly rpcUrl: string;
  private readonly mintStatePath: string | null;
  private readonly sender: SolanaDevnetWalletOptions["sender"];
  private readonly skipAirdrop: boolean;
  private readonly offlineLedger: boolean;
  private mint: PublicKey | null = null;
  private sequence = 0;
  private airdropOk: boolean | null = null;
  private airdropError: string | null = null;
  /** Soft off-chain ledger used only when an address has not been credited on-chain yet in this process — export/import for sandbox grants across restarts before first on-chain credit. */
  private readonly pendingCredits = new Map<string, bigint>();
  private readonly derived = new Map<string, Keypair>();
  private readonly refs = new Map<string, string>();

  constructor(options: SolanaDevnetWalletOptions) {
    if (!options.feePayerSecret?.trim()) {
      throw new WalletProviderError("solana-devnet rail requires feePayerSecret.");
    }
    this.feePayer = keypairFromSecret(options.feePayerSecret, "feePayerSecret");
    this.rpcUrl = options.rpcUrl?.trim() || DEFAULT_RPC;
    this.connection = options.connection ?? new Connection(this.rpcUrl, options.commitment ?? "confirmed");
    this.mintStatePath = options.mintStatePath?.trim() || null;
    this.sender = options.sender;
    this.skipAirdrop = options.skipAirdrop === true;
    this.offlineLedger = options.offlineLedger === true;
    if (this.offlineLedger) {
      this.mint = Keypair.generate().publicKey;
    }
    if (this.mintStatePath && existsSync(this.mintStatePath)) {
      try {
        const raw = JSON.parse(readFileSync(this.mintStatePath, "utf8")) as { mint?: string };
        if (raw.mint) this.mint = new PublicKey(raw.mint);
      } catch {
        // recreate mint on next credit
      }
    }
  }

  get feePayerPublicKey(): string {
    return this.feePayer.publicKey.toBase58();
  }

  async status(): Promise<SolanaDevnetStatus> {
    let feePayerSol: number | null = null;
    try {
      const lamports = await this.connection.getBalance(this.feePayer.publicKey, "confirmed");
      feePayerSol = lamports / LAMPORTS_PER_SOL;
    } catch {
      feePayerSol = null;
    }
    return {
      rail: "solana-devnet",
      cluster: "devnet",
      rpcUrl: this.rpcUrl,
      feePayer: this.feePayerPublicKey,
      mint: this.mint?.toBase58() ?? null,
      feePayerSol,
      airdropOk: this.airdropOk,
      airdropError: this.airdropError,
      label: "devnet · Roster test SPL (not mainnet)",
    };
  }

  /** Request Devnet SOL for fees. Rate-limits are recorded; mock rail stays untouched. */
  async ensureFeePayerSol(minSol = 0.5): Promise<{ ok: boolean; sol: number; error: string | null }> {
    if (this.skipAirdrop) {
      this.airdropOk = true;
      this.airdropError = null;
      return { ok: true, sol: 0, error: null };
    }
    try {
      const lamports = await this.connection.getBalance(this.feePayer.publicKey, "confirmed");
      let sol = lamports / LAMPORTS_PER_SOL;
      if (sol >= minSol) {
        this.airdropOk = true;
        this.airdropError = null;
        return { ok: true, sol, error: null };
      }
      const sig = await this.connection.requestAirdrop(this.feePayer.publicKey, Math.ceil(1.5 * LAMPORTS_PER_SOL));
      await withRpcRetry(() => this.connection.confirmTransaction(sig, "confirmed"), "confirmAirdrop");
      sol = (await this.connection.getBalance(this.feePayer.publicKey, "confirmed")) / LAMPORTS_PER_SOL;
      this.airdropOk = true;
      this.airdropError = null;
      return { ok: true, sol, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : "devnet airdrop failed";
      this.airdropOk = false;
      this.airdropError = message;
      return { ok: false, sol: 0, error: message };
    }
  }

  async createAddress(ownerRef: string): Promise<{ address: string }> {
    if (!ownerRef.trim()) throw new WalletProviderError("Owner ref is required.");
    const keypair = this.keypairFor(ownerRef);
    this.derived.set(keypair.publicKey.toBase58(), keypair);
    this.refs.set(keypair.publicKey.toBase58(), ownerRef);
    return { address: keypair.publicKey.toBase58() };
  }

  async getBalance(address: string): Promise<string> {
    const owner = this.resolveOwner(address);
    const pending = this.pendingCredits.get(owner.toBase58()) ?? 0n;
    if (this.offlineLedger || !this.mint) return formatUsdc(pending);
    try {
      const ata = getAssociatedTokenAddressSync(this.mint, owner, false, TOKEN_PROGRAM_ID);
      const bal = await withRpcRetry(
        () => this.connection.getTokenAccountBalance(ata, "confirmed"),
        "getTokenAccountBalance",
      );
      const amount = BigInt(bal.value.amount);
      return formatUsdc(amount + pending);
    } catch {
      return formatUsdc(pending);
    }
  }

  async credit(address: string, amountUsdc: string): Promise<void> {
    const amount = parseUsdc(amountUsdc);
    if (amount <= 0n) throw new WalletProviderError("Credit amount must be greater than zero.");
    const owner = this.resolveOwner(address);
    if (this.offlineLedger) {
      const key = owner.toBase58();
      this.pendingCredits.set(key, (this.pendingCredits.get(key) ?? 0n) + amount);
      if (this.sender) {
        await this.sender(new Transaction(), [this.feePayer]);
      }
      return;
    }
    try {
      await this.ensureMint();
      if (!this.mint) throw new WalletProviderError("Mint unavailable.");
      const ata = await this.ensureAta(owner);
      const tx = new Transaction().add(
        createMintToInstruction(this.mint, ata, this.feePayer.publicKey, amount, [], TOKEN_PROGRAM_ID),
      );
      await this.send(tx, [this.feePayer]);
      this.pendingCredits.delete(owner.toBase58());
    } catch (error) {
      // Soft ledger when RPC/airdrop/SOL is unavailable so sandbox boot (fleet fund)
      // does not hard-crash. Transfers still require on-chain fee-payer SOL.
      const key = owner.toBase58();
      this.pendingCredits.set(key, (this.pendingCredits.get(key) ?? 0n) + amount);
      this.airdropError = error instanceof Error ? error.message : "on-chain credit failed";
      console.warn(
        JSON.stringify({
          t: new Date().toISOString(),
          msg: "solana-devnet soft credit (on-chain mint failed)",
          address: `${key.slice(0, 8)}…`,
          error: this.airdropError,
        }),
      );
    }
  }

  async transfer(request: TransferRequest): Promise<TransferResult> {
    const amount = parseUsdc(request.amountUsdc);
    if (amount <= 0n) throw new WalletProviderError("Transfer amount must be greater than zero.");
    const from = this.resolveOwner(request.fromAddress);
    const to = this.resolveOwner(request.toAddress);
    const fromKp = this.keypairForAddress(from.toBase58(), request.fromAddress);

    if (this.offlineLedger) {
      const fromKey = from.toBase58();
      const toKey = to.toBase58();
      const fromBal = this.pendingCredits.get(fromKey) ?? 0n;
      if (fromBal < amount) throw new WalletProviderError("Insufficient balance.");
      this.pendingCredits.set(fromKey, fromBal - amount);
      this.pendingCredits.set(toKey, (this.pendingCredits.get(toKey) ?? 0n) + amount);
      const signature = this.sender
        ? await this.sender(new Transaction(), [this.feePayer, fromKp])
        : `offline_${(++this.sequence).toString()}${"x".repeat(70)}`;
      this.sequence += 1;
      return { providerRef: signature, status: "settled", chain: this.chain };
    }

    await this.ensureMint();
    if (!this.mint) throw new WalletProviderError("Mint unavailable.");

    const fromAta = await this.ensureAta(from);
    const toAta = await this.ensureAta(to);

    // Flush any pending soft credit (sandbox grant before first on-chain mint).
    const pending = this.pendingCredits.get(from.toBase58()) ?? 0n;
    if (pending > 0n) {
      const txMint = new Transaction().add(
        createMintToInstruction(this.mint, fromAta, this.feePayer.publicKey, pending, [], TOKEN_PROGRAM_ID),
      );
      await this.send(txMint, [this.feePayer]);
      this.pendingCredits.delete(from.toBase58());
    }

    const tx = new Transaction().add(
      createTransferInstruction(fromAta, toAta, from, amount, [], TOKEN_PROGRAM_ID),
    );
    const signature = await this.send(tx, [this.feePayer, fromKp]);
    this.sequence += 1;
    return {
      providerRef: signature,
      status: "settled",
      chain: this.chain,
    };
  }

  /** Soft ledger for sandbox snapshots when operators still use JSON wallet state. */
  exportState(): MockWalletSnapshot {
    const balances = [...this.pendingCredits.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([address, micros]) => ({ address, balanceUsdc: formatUsdc(micros) }));
    return { balances, sequence: this.sequence };
  }

  importState(snapshot: MockWalletSnapshot): void {
    this.pendingCredits.clear();
    for (const entry of snapshot.balances) {
      this.pendingCredits.set(entry.address, parseUsdc(entry.balanceUsdc));
    }
    this.sequence = snapshot.sequence;
  }

  /**
   * Prefer on-chain mint; when RPC/airdrop is down, park a pending credit so
   * sandbox grants do not hard-fail boot. Transfers still require RPC.
   */
  async creditSoftOrChain(address: string, amountUsdc: string): Promise<"chain" | "soft"> {
    const before = this.pendingCredits.get(this.resolveOwner(address).toBase58()) ?? 0n;
    await this.credit(address, amountUsdc);
    const after = this.pendingCredits.get(this.resolveOwner(address).toBase58()) ?? 0n;
    return after > before ? "soft" : "chain";
  }

  private async ensureMint(): Promise<PublicKey> {
    if (this.mint) return this.mint;
    const mintKp = Keypair.generate();
    const lamports = await getMinimumBalanceForRentExemptMint(this.connection);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: this.feePayer.publicKey,
        newAccountPubkey: mintKp.publicKey,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mintKp.publicKey, TOKEN_DECIMALS, this.feePayer.publicKey, null, TOKEN_PROGRAM_ID),
    );
    await this.send(tx, [this.feePayer, mintKp]);
    this.mint = mintKp.publicKey;
    if (this.mintStatePath) {
      mkdirSync(dirname(this.mintStatePath), { recursive: true });
      writeFileSync(this.mintStatePath, JSON.stringify({ mint: this.mint.toBase58(), decimals: TOKEN_DECIMALS }, null, 2));
    }
    return this.mint;
  }

  private async ensureAta(owner: PublicKey): Promise<PublicKey> {
    if (!this.mint) throw new WalletProviderError("Mint unavailable.");
    const ata = getAssociatedTokenAddressSync(this.mint, owner, false, TOKEN_PROGRAM_ID);
    const info = await withRpcRetry(() => this.connection.getAccountInfo(ata, "confirmed"), "getAccountInfo");
    if (info) return ata;
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        this.feePayer.publicKey,
        ata,
        owner,
        this.mint,
        TOKEN_PROGRAM_ID,
      ),
    );
    await this.send(tx, [this.feePayer]);
    return ata;
  }

  private async send(tx: Transaction, signers: Keypair[]): Promise<TransactionSignature> {
    if (this.sender) return this.sender(tx, signers);
    // Retry blockhash + send together; confirm separately so a 429 on confirm does not rebroadcast.
    const { signature, blockhash, lastValidBlockHeight } = await withRpcRetry(async () => {
      const latest = await this.connection.getLatestBlockhash("confirmed");
      tx.feePayer = this.feePayer.publicKey;
      tx.recentBlockhash = latest.blockhash;
      tx.sign(...signers);
      const signature = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      return { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight };
    }, "send");
    await withRpcRetry(
      () =>
        this.connection.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          "confirmed",
        ),
      "confirm",
    );
    return signature;
  }

  private keypairFor(ownerRef: string): Keypair {
    const seed = createHmac("sha256", this.feePayer.secretKey)
      .update(`roster-devnet-wallet-v1:${ownerRef}`)
      .digest();
    return Keypair.fromSeed(seed);
  }

  /** Resolve a stored address (pubkey) or a legacy label (`mock:fees:…`) to a keypair we control. */
  private keypairForAddress(pubkey: string, original: string): Keypair {
    const cached = this.derived.get(pubkey);
    if (cached) return cached;
    if (original.startsWith("mock:") || original.includes(":")) {
      const kp = this.keypairFor(original);
      this.derived.set(kp.publicKey.toBase58(), kp);
      this.refs.set(kp.publicKey.toBase58(), original);
      return kp;
    }
    const ref = this.refs.get(pubkey);
    if (ref) {
      const kp = this.keypairFor(ref);
      this.derived.set(pubkey, kp);
      return kp;
    }
    throw new WalletProviderError(`Cannot sign for unknown Solana address ${pubkey.slice(0, 8)}…`);
  }

  private resolveOwner(address: string): PublicKey {
    if (address.startsWith("mock:") || (address.includes(":") && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address))) {
      const kp = this.keypairFor(address);
      this.derived.set(kp.publicKey.toBase58(), kp);
      this.refs.set(kp.publicKey.toBase58(), address);
      return kp.publicKey;
    }
    try {
      return new PublicKey(address);
    } catch {
      const kp = this.keypairFor(address);
      this.derived.set(kp.publicKey.toBase58(), kp);
      this.refs.set(kp.publicKey.toBase58(), address);
      return kp.publicKey;
    }
  }
}

/** Load fee-payer secret from env or a chmod-600 file path. Never log the value. */
export function loadFeePayerSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const inline = env.ROSTER_FEE_PAYER_SECRET?.trim();
  if (inline) return inline;
  const path = env.ROSTER_FEE_PAYER_KEYPAIR?.trim() || env.ROSTER_SOLANA_FEE_PAYER_FILE?.trim();
  if (!path) return null;
  if (!existsSync(path)) {
    throw new WalletProviderError(`Fee-payer keypair file not found: ${path}`);
  }
  return readFileSync(path, "utf8").trim();
}

export function createSolanaDevnetWallet(env: NodeJS.ProcessEnv = process.env): SolanaDevnetWalletProvider {
  const secret = loadFeePayerSecret(env);
  if (!secret) {
    throw new WalletProviderError(
      "solana-devnet requires ROSTER_FEE_PAYER_SECRET or ROSTER_FEE_PAYER_KEYPAIR (server file under roster-data).",
    );
  }
  const dataDir = env.ROSTER_DATA_DIR?.trim() || "";
  const mintStatePath =
    env.ROSTER_SOLANA_MINT_STATE?.trim() ||
    (dataDir ? `${dataDir.replace(/\/$/, "")}/solana-devnet-mint.json` : undefined);
  return new SolanaDevnetWalletProvider({
    feePayerSecret: secret,
    rpcUrl: env.SOLANA_RPC_URL?.trim() || env.ROSTER_SOLANA_RPC?.trim() || DEFAULT_RPC,
    ...(mintStatePath ? { mintStatePath } : {}),
  });
}

/** Deterministic secret for unit tests (not a production key). */
export function testFeePayerSecret(): string {
  const seed = createHash("sha256").update("roster-devnet-test-fee-payer-v1").digest();
  return JSON.stringify(Array.from(Keypair.fromSeed(seed).secretKey));
}
