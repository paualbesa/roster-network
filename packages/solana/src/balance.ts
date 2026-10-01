import { FEE_PAYER_MIN_LAMPORTS } from "./constants.js";
import type { SolanaEngineConfig } from "./config.js";
import { SolanaFeeError } from "./errors.js";
import { feePayerSigner } from "./keys.js";
import { rpcGetBalanceLamports } from "./rpc.js";

const LAMPORTS_PER_SOL = 1_000_000_000n;
const DEFAULT_SIMULATED_LAMPORTS = LAMPORTS_PER_SOL;

export function parseSol(value: string): bigint {
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.(\d{1,9}))?$/.test(trimmed)) {
    throw new SolanaFeeError(400, "invalid_request", `Invalid SOL amount: ${value}`);
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const fractionPadded = `${fraction}000000000`.slice(0, 9);
  return BigInt(whole ?? "0") * LAMPORTS_PER_SOL + BigInt(fractionPadded);
}

export function formatSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const absolute = negative ? -lamports : lamports;
  const whole = absolute / LAMPORTS_PER_SOL;
  const fraction = (absolute % LAMPORTS_PER_SOL).toString().padStart(9, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

export interface FeePayerSolBalance {
  lamports: bigint;
  sol: string;
  source: "simulated" | "rpc";
  feePayer: string;
  belowMinimum: boolean;
}

export async function readFeePayerSolBalance(
  config: SolanaEngineConfig,
  options: { fetchImpl?: typeof fetch; lamports?: bigint } = {},
): Promise<FeePayerSolBalance> {
  const feePayer = feePayerSigner(config).publicKey.toBase58();
  let lamports: bigint;
  let source: FeePayerSolBalance["source"];
  if (options.lamports !== undefined) {
    lamports = options.lamports;
    source = "simulated";
  } else if (config.cluster !== "mock" && config.rpcUrl && config.simulatedFeePayerSol === null) {
    lamports = await rpcGetBalanceLamports(config.rpcUrl, feePayer, options.fetchImpl ?? fetch);
    source = "rpc";
  } else if (config.simulatedFeePayerSol) {
    lamports = parseSol(config.simulatedFeePayerSol);
    source = "simulated";
  } else {
    lamports = DEFAULT_SIMULATED_LAMPORTS;
    source = "simulated";
  }
  return {
    lamports,
    sol: formatSol(lamports),
    source,
    feePayer,
    belowMinimum: lamports < FEE_PAYER_MIN_LAMPORTS,
  };
}
