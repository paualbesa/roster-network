import {
  FEE_PAYER_TOP_UP_USDC,
  FEE_PAYER_TOP_UP_USDC_MICROS,
  JUPITER_QUOTE_URL,
  JUPITER_SWAP_URL,
  SolanaFeeError,
  TREASURY_CHECK_INTERVAL_MS,
  USDC_MINT_MAINNET,
  WSOL_MINT,
  formatSol,
  readFeePayerSolBalance,
  resolveSolanaEngineConfig,
  submitSignedTransaction,
  type SolanaClusterMode,
  type SolanaEngineConfig,
  type SolanaEnv,
} from "@albesa/solana";

export { TREASURY_CHECK_INTERVAL_MS };

export type TreasuryAction = "ok" | "dry-run-topup" | "topup" | "refused";

export interface TreasuryCheckResult {
  cluster: SolanaClusterMode;
  dryRun: boolean;
  executed: boolean;
  action: TreasuryAction;
  feePayer: string;
  balanceSol: string;
  thresholdSol: string;
  jupiterQuoteUrl: string | null;
  signature: string | null;
  logs: string[];
}

export interface TreasuryCheckOptions {
  env?: SolanaEnv;
  config?: SolanaEngineConfig;
  fetchImpl?: typeof fetch;
  lamports?: bigint;
  submitSwap?: (swapTransaction: string) => Promise<string>;
  log?: (line: string) => void;
  once?: boolean;
  intervalMs?: number;
  signal?: AbortSignal;
}

const THRESHOLD_SOL = formatSol(20_000_000n);

export function jupiterUsdcToSolQuoteUrl(amountMicros: bigint = FEE_PAYER_TOP_UP_USDC_MICROS): string {
  return `${JUPITER_QUOTE_URL}?inputMint=${USDC_MINT_MAINNET}&outputMint=${WSOL_MINT}&amount=${amountMicros.toString()}&slippageBps=50`;
}

/**
 * A live Jupiter swap spends mainnet USDC. It runs only when every gate is
 * explicit: execute=1, dry-run=0, cluster=mainnet-beta, allow mainnet, secret, RPC.
 * Mock and devnet always stay on the dry-run path.
 */
export function treasuryWillExecute(config: SolanaEngineConfig, env: SolanaEnv): boolean {
  if (env.ROSTER_TREASURY_EXECUTE !== "1") return false;
  if (env.ROSTER_TREASURY_DRY_RUN !== "0") return false;
  if (config.cluster !== "mainnet-beta") return false;
  if (!config.allowMainnet) return false;
  if (!config.feePayerSecret) return false;
  if (!config.rpcUrl) return false;
  return true;
}

function emit(logs: string[], log: ((line: string) => void) | undefined, line: string): void {
  logs.push(line);
  log?.(line);
}

function refusalReason(config: SolanaEngineConfig, env: SolanaEnv): string {
  if (config.cluster === "mock") return "mock cluster never spends";
  if (config.cluster === "devnet") return "Jupiter USDC→SOL uses mainnet mints and is not sent on devnet";
  if (config.cluster === "mainnet-beta" && !config.allowMainnet) {
    return "mainnet swap requires ROSTER_SOLANA_ALLOW_MAINNET=1";
  }
  if (env.ROSTER_TREASURY_EXECUTE !== "1") return "set ROSTER_TREASURY_EXECUTE=1 to arm a swap";
  if (env.ROSTER_TREASURY_DRY_RUN !== "0") return "dry-run is still on; set ROSTER_TREASURY_DRY_RUN=0 together with EXECUTE=1";
  if (!config.feePayerSecret) return "ROSTER_FEE_PAYER_SECRET is unset";
  if (!config.rpcUrl) return "SOLANA_RPC_URL is unset";
  return "swap was not armed";
}

async function readJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

function swapTransactionFrom(body: unknown): string {
  if (typeof body !== "object" || body === null || !("swapTransaction" in body)) {
    throw new SolanaFeeError(502, "jupiter_error", "Jupiter swap response did not include a transaction.");
  }
  const value = body.swapTransaction;
  if (typeof value !== "string" || value.length === 0) {
    throw new SolanaFeeError(502, "jupiter_error", "Jupiter swap response did not include a transaction.");
  }
  return value;
}

export async function runTreasuryCheck(options: TreasuryCheckOptions = {}): Promise<TreasuryCheckResult> {
  const env = options.env ?? process.env;
  const config = options.config ?? resolveSolanaEngineConfig(env);
  const logs: string[] = [];
  const quoteUrl = jupiterUsdcToSolQuoteUrl();
  let balance;
  try {
    balance =
      options.lamports !== undefined
        ? await readFeePayerSolBalance(config, { lamports: options.lamports, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) })
        : await readFeePayerSolBalance(config, options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fee payer balance check failed.";
    emit(logs, options.log, `[roster-treasury] refused: ${message}`);
    return {
      cluster: config.cluster,
      dryRun: true,
      executed: false,
      action: "refused",
      feePayer: config.feePayerPubkey ?? "unset",
      balanceSol: "0.000000000",
      thresholdSol: THRESHOLD_SOL,
      jupiterQuoteUrl: null,
      signature: null,
      logs,
    };
  }

  const execute = treasuryWillExecute(config, env);
  const swapping = execute && balance.belowMinimum;
  const header = `[roster-treasury] cluster=${config.cluster} dryRun=${(!swapping).toString()} feePayer=${balance.feePayer} balanceSol=${balance.sol} thresholdSol=${THRESHOLD_SOL} source=${balance.source}`;

  if (!balance.belowMinimum) {
    emit(logs, options.log, `${header} action=ok`);
    return {
      cluster: config.cluster,
      dryRun: true,
      executed: false,
      action: "ok",
      feePayer: balance.feePayer,
      balanceSol: balance.sol,
      thresholdSol: THRESHOLD_SOL,
      jupiterQuoteUrl: null,
      signature: null,
      logs,
    };
  }

  emit(
    logs,
    options.log,
    `${header} action=${execute ? "topup" : "dry-run-topup"}`,
  );
  emit(
    logs,
    options.log,
    `[roster-treasury] fee payer SOL is below ${THRESHOLD_SOL}; plan swap ${FEE_PAYER_TOP_UP_USDC.toString()} USDC → SOL via Jupiter and fund fee payer ${balance.feePayer}`,
  );
  emit(logs, options.log, `[roster-treasury] jupiter ${quoteUrl}`);

  if (!execute) {
    emit(
      logs,
      options.log,
      `[roster-treasury] dry-run: no Jupiter request was sent and no funds moved (${refusalReason(config, env)})`,
    );
    return {
      cluster: config.cluster,
      dryRun: true,
      executed: false,
      action: "dry-run-topup",
      feePayer: balance.feePayer,
      balanceSol: balance.sol,
      thresholdSol: THRESHOLD_SOL,
      jupiterQuoteUrl: quoteUrl,
      signature: null,
      logs,
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const quoteResponse = await fetchImpl(quoteUrl);
  if (!quoteResponse.ok) {
    throw new SolanaFeeError(502, "jupiter_error", `Jupiter quote returned HTTP ${quoteResponse.status}.`);
  }
  const quoteBody = await readJson(quoteResponse);
  const swapResponse = await fetchImpl(JUPITER_SWAP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quoteBody,
      userPublicKey: balance.feePayer,
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapResponse.ok) {
    throw new SolanaFeeError(502, "jupiter_error", `Jupiter swap returned HTTP ${swapResponse.status}.`);
  }
  const swapTransaction = swapTransactionFrom(await readJson(swapResponse));
  const signature = options.submitSwap
    ? await options.submitSwap(swapTransaction)
    : await submitSignedTransaction(swapTransaction, config, fetchImpl);
  emit(logs, options.log, `[roster-treasury] submitted Jupiter swap signature=${signature}`);

  return {
    cluster: config.cluster,
    dryRun: false,
    executed: true,
    action: "topup",
    feePayer: balance.feePayer,
    balanceSol: balance.sol,
    thresholdSol: THRESHOLD_SOL,
    jupiterQuoteUrl: quoteUrl,
    signature,
    logs,
  };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Repeats the balance check every five minutes unless `once` is set. */
export async function runTreasuryLoop(options: TreasuryCheckOptions = {}): Promise<TreasuryCheckResult> {
  const intervalMs = options.intervalMs ?? TREASURY_CHECK_INTERVAL_MS;
  let latest: TreasuryCheckResult | null = null;
  do {
    latest = await runTreasuryCheck(options);
    if (options.once || options.signal?.aborted) break;
    await sleep(intervalMs, options.signal);
  } while (!options.signal?.aborted);
  if (!latest) {
    throw new SolanaFeeError(502, "treasury_check_failed", "Treasury check did not run.");
  }
  return latest;
}
