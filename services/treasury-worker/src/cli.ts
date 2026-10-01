import { runTreasuryLoop } from "./check.js";

const once = process.env.ROSTER_TREASURY_ONCE === "1";
const intervalRaw = process.env.ROSTER_TREASURY_INTERVAL_MS?.trim();
const intervalMs = intervalRaw ? Number(intervalRaw) : undefined;

runTreasuryLoop({
  once,
  ...(intervalMs !== undefined && Number.isFinite(intervalMs) && intervalMs > 0 ? { intervalMs } : {}),
  log: (line) => {
    console.log(line);
  },
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Treasury worker failed.";
  console.error(`[roster-treasury] ${message}`);
  process.exitCode = 1;
});
