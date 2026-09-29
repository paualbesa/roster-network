import { createHash } from "node:crypto";
import { formatUsdc, parseUsdc } from "../money.js";
import { WalletProviderError } from "./errors.js";
import type { MockWalletSnapshot } from "./mock.js";
import { assertSandboxWalletOptions } from "./sandbox-guard.js";
import type { TransferRequest, TransferResult, WalletProvider } from "./types.js";

export interface BaseUsdcWalletOptions {
  /**
   * Rejected. This adapter never dials Base.
   * There is no field for a private key, mnemonic, or seed.
   */
  rpcUrl?: string;
}

/** Fee and latency recorded for the simulated Base rail. Not a live quote. */
export interface BaseSimDiagnostics {
  rail: "base-sim";
  chain: "base-sepolia-sim";
  networkFeeUsdc: string;
  latencyMs: number;
  transferCount: number;
  feesCollectedUsdc: string;
}

/**
 * One micro-USDC. The L2 target is well under 0.001 USDC.
 * Recorded on each settled transfer. Not deducted from the payer.
 */
export const SIMULATED_BASE_NETWORK_FEE_USDC = "0.000001";

/**
 * Recorded settlement latency. The transfer call does not sleep.
 * The product target is under two seconds.
 */
export const SIMULATED_BASE_LATENCY_MS = 180;

const NETWORK_FEE_MICROS = parseUsdc(SIMULATED_BASE_NETWORK_FEE_USDC);

interface SettledTransfer {
  fromAddress: string;
  toAddress: string;
  amountMicros: bigint;
  result: TransferResult;
}

/**
 * In-process Base Sepolia simulator. Addresses are deterministic labels, not keys.
 * Balances live in a Map. Nothing is broadcast and no RPC client is loaded.
 * The simulated network fee and latency are metadata so escrow principal stays exact.
 */
export class BaseUsdcWalletProvider implements WalletProvider {
  readonly id = "base-usdc" as const;
  readonly chain = "base-sepolia-sim" as const;
  private readonly balances = new Map<string, bigint>();
  private readonly settled = new Map<string, SettledTransfer>();
  private sequence = 0;
  private feesCollectedMicros = 0n;

  constructor(options: BaseUsdcWalletOptions = {}) {
    assertSandboxWalletOptions(options);
  }

  async createAddress(ownerRef: string): Promise<{ address: string }> {
    if (!ownerRef.trim()) throw new WalletProviderError("Owner ref is required.");
    const address = simulatedBaseAddress(ownerRef);
    if (!this.balances.has(address)) this.balances.set(address, 0n);
    return { address };
  }

  async getBalance(address: string): Promise<string> {
    return formatUsdc(this.balances.get(address) ?? 0n);
  }

  /** Sandbox-only mint. Not part of {@link WalletProvider}; a live rail will not mint. */
  async credit(address: string, amountUsdc: string): Promise<void> {
    const amount = parseUsdc(amountUsdc);
    if (amount <= 0n) throw new WalletProviderError("Credit amount must be greater than zero.");
    const current = this.balances.get(address) ?? 0n;
    this.balances.set(address, current + amount);
  }

  async transfer(request: TransferRequest): Promise<TransferResult> {
    const idempotencyKey = request.idempotencyKey.trim();
    if (!idempotencyKey) throw new WalletProviderError("Idempotency key is required.");
    const amount = parseUsdc(request.amountUsdc);
    if (amount <= 0n) throw new WalletProviderError("Transfer amount must be greater than zero.");
    const prior = this.settled.get(idempotencyKey);
    if (prior) {
      if (
        prior.fromAddress !== request.fromAddress ||
        prior.toAddress !== request.toAddress ||
        prior.amountMicros !== amount
      ) {
        throw new WalletProviderError("Idempotency key was already used for a different transfer.");
      }
      return prior.result;
    }

    const fromBalance = this.balances.get(request.fromAddress) ?? 0n;
    if (fromBalance < amount) throw new WalletProviderError("Insufficient balance.");
    if (!this.balances.has(request.toAddress)) this.balances.set(request.toAddress, 0n);
    this.balances.set(request.fromAddress, fromBalance - amount);
    const toBalance = this.balances.get(request.toAddress) ?? 0n;
    this.balances.set(request.toAddress, toBalance + amount);
    this.sequence += 1;
    this.feesCollectedMicros += NETWORK_FEE_MICROS;
    const result: TransferResult = {
      providerRef: `base_sim_tx_${this.sequence.toString(10)}`,
      status: "settled",
      chain: this.chain,
      networkFeeUsdc: SIMULATED_BASE_NETWORK_FEE_USDC,
      latencyMs: SIMULATED_BASE_LATENCY_MS,
    };
    this.settled.set(idempotencyKey, {
      fromAddress: request.fromAddress,
      toAddress: request.toAddress,
      amountMicros: amount,
      result,
    });
    return result;
  }

  diagnostics(): BaseSimDiagnostics {
    return {
      rail: "base-sim",
      chain: this.chain,
      networkFeeUsdc: SIMULATED_BASE_NETWORK_FEE_USDC,
      latencyMs: SIMULATED_BASE_LATENCY_MS,
      transferCount: this.sequence,
      feesCollectedUsdc: formatUsdc(this.feesCollectedMicros),
    };
  }

  exportState(): MockWalletSnapshot {
    const balances = [...this.balances.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([address, micros]) => ({ address, balanceUsdc: formatUsdc(micros) }));
    return {
      balances,
      sequence: this.sequence,
      networkFeesCollectedUsdc: formatUsdc(this.feesCollectedMicros),
    };
  }

  importState(snapshot: MockWalletSnapshot): void {
    if (!Number.isInteger(snapshot.sequence) || snapshot.sequence < 0) {
      throw new WalletProviderError("Mock wallet sequence must be a non-negative integer.");
    }
    const next = new Map<string, bigint>();
    for (const entry of snapshot.balances) {
      if (!entry.address) throw new WalletProviderError("Mock wallet snapshot has an empty address.");
      next.set(entry.address, parseUsdc(entry.balanceUsdc));
    }
    const fees =
      snapshot.networkFeesCollectedUsdc === undefined ? 0n : parseUsdc(snapshot.networkFeesCollectedUsdc);
    this.balances.clear();
    for (const [address, amount] of next) this.balances.set(address, amount);
    this.sequence = snapshot.sequence;
    this.feesCollectedMicros = fees;
    this.settled.clear();
  }
}

/** Deterministic sandbox label. Not an EIP-55 address and not derived from a key. */
export function simulatedBaseAddress(ownerRef: string): string {
  const digest = createHash("sha256").update(`roster.base-sim.v1\n${ownerRef}`).digest("hex");
  return `base-sim:0x${digest.slice(0, 40)}`;
}
