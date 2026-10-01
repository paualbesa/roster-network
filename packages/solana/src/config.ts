import { SolanaFeeError } from "./errors.js";

export type SolanaClusterMode = "mock" | "devnet" | "mainnet-beta";

export interface SolanaEngineConfig {
  cluster: SolanaClusterMode;
  feePayerPubkey: string | null;
  /** Ignored in mock mode. Never logged. */
  feePayerSecret: string | null;
  /** Ignored in mock mode. Never logged. */
  programAuthoritySecret: string | null;
  treasuryUsdcAta: string | null;
  rpcUrl: string | null;
  /** Settle broadcasts only when this is true and the other live gates pass. */
  send: boolean;
  /** Required before mainnet-beta signing, broadcast, or a Jupiter swap. */
  allowMainnet: boolean;
  /** Mock SOL balance override. Used when the cluster is mock or RPC is unset. */
  simulatedFeePayerSol: string | null;
}

export type SolanaEnv = Record<string, string | undefined>;

function readOptional(env: SolanaEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

export function resolveSolanaCluster(env: SolanaEnv = process.env): SolanaClusterMode {
  const raw = env.ROSTER_SOLANA_CLUSTER?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "mock" || raw === "offline") return "mock";
  if (raw === "devnet") return "devnet";
  if (raw === "mainnet-beta" || raw === "mainnet") return "mainnet-beta";
  throw new SolanaFeeError(
    400,
    "invalid_cluster",
    `Unsupported ROSTER_SOLANA_CLUSTER "${raw}". Use mock, offline, devnet, or mainnet-beta.`,
  );
}

/**
 * Default is mock/offline. Secrets are dropped in mock mode so a sandbox
 * process does not keep key material it will not use.
 */
export function resolveSolanaEngineConfig(env: SolanaEnv = process.env): SolanaEngineConfig {
  const cluster = resolveSolanaCluster(env);
  const live = cluster !== "mock";
  return {
    cluster,
    feePayerPubkey: readOptional(env, "ROSTER_FEE_PAYER_PUBKEY"),
    feePayerSecret: live ? readOptional(env, "ROSTER_FEE_PAYER_SECRET") : null,
    programAuthoritySecret: live ? readOptional(env, "ROSTER_PROGRAM_AUTHORITY_SECRET") : null,
    treasuryUsdcAta: readOptional(env, "ROSTER_TREASURY_USDC_ATA"),
    rpcUrl: readOptional(env, "SOLANA_RPC_URL"),
    send: env.ROSTER_SOLANA_SEND === "1",
    allowMainnet: env.ROSTER_SOLANA_ALLOW_MAINNET === "1",
    simulatedFeePayerSol: readOptional(env, "ROSTER_FEE_PAYER_SOL_BALANCE"),
  };
}

export function mockSolanaEngineConfig(overrides: Partial<SolanaEngineConfig> = {}): SolanaEngineConfig {
  return {
    cluster: "mock",
    feePayerPubkey: null,
    feePayerSecret: null,
    programAuthoritySecret: null,
    treasuryUsdcAta: null,
    rpcUrl: null,
    send: false,
    allowMainnet: false,
    simulatedFeePayerSol: null,
    ...overrides,
  };
}
