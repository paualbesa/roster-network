/** Statuses that end polling. `refunded` is the sandbox schema-failure outcome. */
const TERMINAL_JOB_STATUSES = new Set(["released", "timed_out", "failed", "refunded"]);

export function isTerminalJobStatus(status: string): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

export function jobStatusLabel(status: string): string {
  switch (status) {
    case "held":
      return "Held";
    case "released":
      return "Released";
    case "refunded":
      return "Refunded";
    case "failed":
      return "Failed";
    case "timed_out":
      return "Timed out";
    default:
      return status;
  }
}

export interface PollSnapshot<T> {
  value: T;
  attempts: number;
  done: boolean;
}

export async function pollUntilTerminal<T extends { status: string }>(options: {
  read: () => Promise<T>;
  sleep: (ms: number) => Promise<void>;
  intervalMs: number;
  maxAttempts: number;
}): Promise<PollSnapshot<T>> {
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer.");
  }
  let value = await options.read();
  let attempts = 1;
  while (!isTerminalJobStatus(value.status) && attempts < options.maxAttempts) {
    await options.sleep(options.intervalMs);
    value = await options.read();
    attempts += 1;
  }
  return { value, attempts, done: isTerminalJobStatus(value.status) };
}
