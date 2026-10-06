import type { JobFilter } from "./admin-client";

export interface ActivityPoint {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  jobs: number;
  /** Released USDC that day. Chart scale only; cards keep the API decimal strings. */
  volumeUsdc: number;
}

export interface ReputationSummary {
  passports: number;
  averageScore: string | null;
  successRate: number | null;
  successes: number;
  failures: number;
}

const USDC_RE = /^-?\d+(\.\d+)?$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function formatUsdcDisplay(value: string): string {
  const trimmed = value.trim();
  if (!USDC_RE.test(trimmed)) return value;
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const micros = fraction.padEnd(6, "0").slice(0, 6);
  const significant = micros.replace(/0+$/, "");
  const decimals = (significant.length <= 2 ? micros.slice(0, 2) : significant).padEnd(2, "0");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${decimals}`;
}

export function formatOperatorTime(value: string | null): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return `${new Date(parsed).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function formatPercent(rate: number | null): string {
  if (rate === null || !Number.isFinite(rate)) return "—";
  return `${Math.round(rate * 100).toString()}%`;
}

/** Same status buckets as `GET /v1/admin/jobs?status=`. */
export function jobMatchesFilter(status: string, filter: JobFilter): boolean {
  if (filter === "all") return true;
  if (filter === "locked") return status === "held" || status === "locked";
  if (filter === "released") return status === "released";
  if (filter === "timed_out") return status === "timed_out";
  return status === "refunded" || status === "failed";
}

export function summarizeReputation(
  agents: readonly { score: string; successCount: number; failureCount: number }[],
): ReputationSummary {
  if (agents.length === 0) {
    return { passports: 0, averageScore: null, successRate: null, successes: 0, failures: 0 };
  }
  let scoreSum = 0;
  let scored = 0;
  let successes = 0;
  let failures = 0;
  for (const agent of agents) {
    const score = Number(agent.score);
    if (Number.isFinite(score)) {
      scoreSum += score;
      scored += 1;
    }
    successes += agent.successCount;
    failures += agent.failureCount;
  }
  const events = successes + failures;
  return {
    passports: agents.length,
    averageScore: scored === 0 ? null : (scoreSum / scored).toFixed(2),
    successRate: events === 0 ? null : successes / events,
    successes,
    failures,
  };
}

/** Seven UTC days ending on `now`, including days with no jobs. */
export function jobActivity(
  jobs: readonly { createdAt: string; status: string; amountUsdc: string }[],
  now: Date,
  days = 7,
): ActivityPoint[] {
  const span = Math.max(1, Math.floor(days));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const points: ActivityPoint[] = [];
  for (let offset = span - 1; offset >= 0; offset -= 1) {
    const day = new Date(end);
    day.setUTCDate(day.getUTCDate() - offset);
    points.push({ day: day.toISOString().slice(0, 10), jobs: 0, volumeUsdc: 0 });
  }
  const index = new Map(points.map((point, slot) => [point.day, slot]));
  for (const job of jobs) {
    const parsed = Date.parse(job.createdAt);
    if (Number.isNaN(parsed)) continue;
    const slot = index.get(new Date(parsed).toISOString().slice(0, 10));
    if (slot === undefined) continue;
    const point = points[slot];
    if (!point) continue;
    point.jobs += 1;
    if (job.status === "released") {
      const amount = Number(job.amountUsdc);
      if (Number.isFinite(amount)) point.volumeUsdc += amount;
    }
  }
  return points;
}

export function weekdayLabel(isoDay: string): string {
  const parsed = Date.parse(`${isoDay}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return isoDay.slice(5);
  return WEEKDAYS[new Date(parsed).getUTCDay()] ?? isoDay.slice(5);
}
