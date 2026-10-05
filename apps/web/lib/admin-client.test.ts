import { describe, expect, it } from "vitest";
import { formatUptime, waitlistCsv } from "./admin-client";

describe("admin waitlist export", () => {
  it("quotes fields and neutralises spreadsheet formulas", () => {
    const csv = waitlistCsv([
      { email: "ada@example.com", source: "landing:developer", createdAt: "2026-10-05T10:00:00.000Z" },
      { email: "=cmd@example.com", source: null, createdAt: "2026-10-05T11:00:00.000Z" },
      { email: 'q"uote@example.com', source: "x", createdAt: "t" },
    ]);
    expect(csv.split("\n")).toEqual([
      '"email","source","created_at"',
      '"ada@example.com","landing:developer","2026-10-05T10:00:00.000Z"',
      `"'=cmd@example.com","","2026-10-05T11:00:00.000Z"`,
      '"q""uote@example.com","x","t"',
      "",
    ]);
  });

  it("formats uptime", () => {
    expect(formatUptime(undefined)).toBe("—");
    expect(formatUptime(59)).toBe("0m");
    expect(formatUptime(3_660)).toBe("1h 1m");
    expect(formatUptime(93_784)).toBe("1d 2h");
  });
});
