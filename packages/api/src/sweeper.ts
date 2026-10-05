import { sweepExpiredJobs } from "./fleet.js";

export const DEFAULT_EXPIRE_INTERVAL_MS = 15_000;

/** `ROSTER_EXPIRE_INTERVAL_MS=0` turns the sweeper off. Unset keeps 15 s. */
export function resolveExpireIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ROSTER_EXPIRE_INTERVAL_MS?.trim();
  if (!raw) return DEFAULT_EXPIRE_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_EXPIRE_INTERVAL_MS;
  if (value === 0) return 0;
  return Math.max(1_000, Math.floor(value));
}

/**
 * Background SLA sweep. Runs one sweep at a time and never throws out of the timer.
 * `afterSweep` lets the Supabase boot flush the mirror when something changed.
 */
export function startExpirySweeper(options: {
  app: object;
  intervalMs: number;
  afterSweep?: () => Promise<void>;
  log?: (line: string) => void;
}): { stop: () => void; runOnce: () => Promise<number> } {
  const log = options.log ?? ((line: string) => console.log(line));
  let running = false;
  const runOnce = async (): Promise<number> => {
    if (running) return 0;
    running = true;
    try {
      const count = await sweepExpiredJobs(options.app);
      if (count > 0) {
        if (options.afterSweep) await options.afterSweep();
        log(JSON.stringify({ t: new Date().toISOString(), msg: "sla_sweep", expired: count }));
      }
      return count;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(JSON.stringify({ t: new Date().toISOString(), msg: "sla_sweep_failed", error: message }));
      return 0;
    } finally {
      running = false;
    }
  };
  if (options.intervalMs <= 0) return { stop: () => undefined, runOnce };
  const timer = setInterval(() => void runOnce(), options.intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), runOnce };
}
