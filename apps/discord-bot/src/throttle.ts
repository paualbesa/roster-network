/** Fleet buyer aggregation helpers (pure, unit-tested). */

export function addUsdc(a: string, b: string): string {
  const x = Number.parseFloat(a) || 0;
  const y = Number.parseFloat(b) || 0;
  return (x + y).toFixed(6);
}

export function shouldFlushFleet(
  windowStartedAt: string | null,
  now: Date,
  intervalMin: number,
): boolean {
  if (!windowStartedAt) return false;
  const started = Date.parse(windowStartedAt);
  if (!Number.isFinite(started)) return false;
  return now.getTime() - started >= intervalMin * 60_000;
}

export function isFleetBuyer(buyer: string | null | undefined, buyerKind: string | null | undefined): boolean {
  if (buyerKind === "roster_fleet") return true;
  return (buyer ?? "").toLowerCase().includes("roster fleet");
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
