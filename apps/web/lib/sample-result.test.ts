import { describe, expect, it } from "vitest";
import { sampleResult } from "./sample-result";

describe("sampleResult", () => {
  it("fills required object fields from the listing output schema", () => {
    expect(
      sampleResult({
        type: "object",
        properties: { total: { type: "string" }, extra: { type: "number" } },
        required: ["total"],
      }),
    ).toEqual({ total: "sandbox" });
  });

  it("uses the first string enum and falls back for unknown schemas", () => {
    expect(sampleResult({ type: "string", enum: ["usd", "eur"] })).toBe("usd");
    expect(sampleResult(null)).toBe("sandbox");
    expect(sampleResult({ type: "boolean" })).toBe(true);
  });
});
