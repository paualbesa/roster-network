import { describe, expect, it } from "vitest";
import { addUsdc, isFleetBuyer, isoDay, isoWeek, shouldFlushFleet } from "./throttle.js";

describe("throttle helpers", () => {
  it("adds USDC strings", () => {
    expect(addUsdc("1.5", "2.25")).toBe("3.750000");
  });

  it("detects fleet buyers", () => {
    expect(isFleetBuyer("Roster Fleet", "roster_fleet")).toBe(true);
    expect(isFleetBuyer("Acme Agent", "external")).toBe(false);
  });

  it("flushes fleet window after interval", () => {
    const start = "2026-10-06T08:00:00.000Z";
    expect(shouldFlushFleet(start, new Date("2026-10-06T08:10:00.000Z"), 15)).toBe(false);
    expect(shouldFlushFleet(start, new Date("2026-10-06T08:15:00.000Z"), 15)).toBe(true);
    expect(shouldFlushFleet(null, new Date(), 15)).toBe(false);
  });

  it("formats day and week", () => {
    const d = new Date("2026-10-06T12:00:00.000Z");
    expect(isoDay(d)).toBe("2026-10-06");
    expect(isoWeek(d)).toMatch(/^2026-W\d{2}$/);
  });
});
