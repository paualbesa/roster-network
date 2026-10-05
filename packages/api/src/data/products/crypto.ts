import { SOURCES } from "../sources.js";
import type { DataProductSpec } from "../types.js";
import { round } from "../util.js";

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

async function rpc<T>(ctx: Parameters<NonNullable<DataProductSpec["ingest"]>>[0], url: string, method: string, params: unknown[]): Promise<T> {
  const data = await ctx.fetchJson<{ result?: T; error?: { message: string } }>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    timeoutMs: 20_000,
  });
  if (data.error || data.result === undefined) throw new Error(`${method}: ${data.error?.message ?? "no result"}`);
  return data.result;
}

export const cryptoProducts: DataProductSpec[] = [
  {
    slug: "solana-priority-fees",
    name: "Solana priority-fee & throughput stats — hourly snapshots",
    kind: "feed",
    description:
      "Hourly snapshots of Solana mainnet priority fees over the last ~150 slots (p50/p75/p90/max micro-lamports per CU, share of slots paying a fee) plus recent TPS. Pick a fee that lands without overpaying; 30-day history for backtests.",
    tags: ["solana", "fees", "priority-fees", "gas", "blockchain", "crypto", "on-chain", "feed"],
    sources: [SOURCES.solanaRpc],
    cadence: "hourly",
    intervalS: 3600,
    priceUsdc: "0.002",
    p95Ms: 4000,
    timeField: "observed_at",
    idField: "observed_at",
    retainDays: 30,
    maxRows: 800,
    columns: [
      { name: "observed_at", type: "datetime", description: "Snapshot time (UTC, minute)." },
      { name: "slot", type: "integer", description: "Latest slot sampled." },
      { name: "slots_sampled", type: "integer", description: "Slots in the sample." },
      { name: "fee_p50", type: "number", description: "Median priority fee, micro-lamports/CU." },
      { name: "fee_p75", type: "number", description: "75th percentile." },
      { name: "fee_p90", type: "number", description: "90th percentile." },
      { name: "fee_max", type: "number", description: "Maximum." },
      { name: "nonzero_share", type: "number", description: "Share of slots with a non-zero minimum fee." },
      { name: "tps", type: "number", description: "Average transactions per second (recent samples; null when the RPC throttles it)." },
    ],
    ingest: async (ctx) => {
      const url = "https://api.mainnet-beta.solana.com";
      const fees = await rpc<{ slot: number; prioritizationFee: number }[]>(ctx, url, "getRecentPrioritizationFees", []);
      await ctx.sleep(1500);
      // The public RPC throttles performance samples; TPS is best-effort.
      const perf = await rpc<{ numTransactions: number; samplePeriodSecs: number }[]>(ctx, url, "getRecentPerformanceSamples", [5]).catch(
        () => [],
      );
      const values = fees.map((entry) => entry.prioritizationFee).sort((left, right) => left - right);
      const seconds = perf.reduce((sum, sample) => sum + sample.samplePeriodSecs, 0);
      const transactions = perf.reduce((sum, sample) => sum + sample.numTransactions, 0);
      const observed = new Date(Math.floor(ctx.now().getTime() / 60_000) * 60_000).toISOString();
      return [
        {
          observed_at: observed,
          slot: Math.max(0, ...fees.map((entry) => entry.slot)),
          slots_sampled: values.length,
          fee_p50: percentile(values, 50),
          fee_p75: percentile(values, 75),
          fee_p90: percentile(values, 90),
          fee_max: values[values.length - 1] ?? 0,
          nonzero_share: round(values.length ? values.filter((value) => value > 0).length / values.length : 0, 4),
          tps: seconds > 0 ? round(transactions / seconds, 1) : null,
        },
      ];
    },
  },
  {
    slug: "base-gas",
    name: "Base (L2) gas price stats — hourly snapshots",
    kind: "feed",
    description:
      "Hourly snapshots of Base mainnet gas: base fee and priority-fee percentiles (gwei) over the last 20 blocks, gas-used ratio and the RPC gas price. 30-day history to time transactions and budget agent payments on Base.",
    tags: ["base", "ethereum", "l2", "gas", "fees", "eip-1559", "blockchain", "crypto", "feed"],
    sources: [SOURCES.baseRpc],
    cadence: "hourly",
    intervalS: 3600,
    priceUsdc: "0.002",
    p95Ms: 4000,
    timeField: "observed_at",
    idField: "observed_at",
    retainDays: 30,
    maxRows: 800,
    columns: [
      { name: "observed_at", type: "datetime", description: "Snapshot time (UTC, minute)." },
      { name: "block", type: "integer", description: "Latest block." },
      { name: "base_fee_gwei", type: "number", description: "Next-block base fee, gwei." },
      { name: "priority_p25_gwei", type: "number", description: "25th percentile priority fee (20-block mean)." },
      { name: "priority_p50_gwei", type: "number", description: "Median priority fee." },
      { name: "priority_p75_gwei", type: "number", description: "75th percentile priority fee." },
      { name: "gas_used_ratio", type: "number", description: "Mean gas-used ratio." },
      { name: "gas_price_gwei", type: "number", description: "eth_gasPrice, gwei." },
    ],
    ingest: async (ctx) => {
      const url = "https://mainnet.base.org";
      const history = await rpc<{ oldestBlock: string; baseFeePerGas: string[]; gasUsedRatio: number[]; reward: string[][] }>(
        ctx,
        url,
        "eth_feeHistory",
        ["0x14", "latest", [25, 50, 75]],
      );
      await ctx.sleep(300);
      const gasPrice = await rpc<string>(ctx, url, "eth_gasPrice", []);
      const gwei = (hex: string | undefined) => (hex ? Number(BigInt(hex)) / 1e9 : 0);
      const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);
      const rewards = history.reward ?? [];
      const column = (index: number) => mean(rewards.map((entry) => gwei(entry[index])));
      const observed = new Date(Math.floor(ctx.now().getTime() / 60_000) * 60_000).toISOString();
      return [
        {
          observed_at: observed,
          block: Number(BigInt(history.oldestBlock)) + history.gasUsedRatio.length - 1,
          base_fee_gwei: round(gwei(history.baseFeePerGas[history.baseFeePerGas.length - 1]), 6),
          priority_p25_gwei: round(column(0), 6),
          priority_p50_gwei: round(column(1), 6),
          priority_p75_gwei: round(column(2), 6),
          gas_used_ratio: round(mean(history.gasUsedRatio), 4),
          gas_price_gwei: round(gwei(gasPrice), 6),
        },
      ];
    },
  },
];
