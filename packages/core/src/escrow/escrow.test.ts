import { describe, expect, it } from "vitest";
import { decideSettlement, decideSlaTimeout, quoteEscrowSettlement, SLA_TIMEOUT_REASON } from "./machine.js";
import { EscrowSchemaError, parseResultSchema, validateResult } from "./schema.js";
import { ESCROW_TAKE_RATE_BPS } from "./types.js";

const deliverySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "rows"],
  properties: {
    status: { type: "string", enum: ["ok"] },
    rows: { type: "integer", minimum: 1 },
  },
};

describe("escrow settlement quote", () => {
  it("deducts a 1% take-rate from the locked amount", () => {
    expect(ESCROW_TAKE_RATE_BPS).toBe(100);
    expect(quoteEscrowSettlement("4.00")).toEqual({
      takeRateBps: 100,
      takeRateUsdc: "0.040000",
      sellerNetUsdc: "3.960000",
    });
    expect(quoteEscrowSettlement("0.15")).toEqual({
      takeRateBps: 100,
      takeRateUsdc: "0.001500",
      sellerNetUsdc: "0.148500",
    });
    const dust = quoteEscrowSettlement("0.000001");
    expect(dust.takeRateUsdc).toBe("0.000000");
    expect(dust.sellerNetUsdc).toBe("0.000001");
  });
});

describe("escrow schema hook", () => {
  const schema = parseResultSchema(deliverySchema);

  it("accepts a result that matches the schema", () => {
    expect(validateResult(schema, { status: "ok", rows: 4 })).toEqual({ ok: true, errors: [] });
  });

  it("reports the constraints a delivery missed", () => {
    const verdict = validateResult(schema, { status: "ok", rows: 0, extra: true });
    expect(verdict.ok).toBe(false);
    expect(verdict.errors).toEqual([
      "result.extra: is not allowed.",
      "result.rows: expected >= 1.",
    ]);
  });

  it("rejects a schema that is not an object contract", () => {
    expect(() => parseResultSchema({ type: "string" })).toThrow(EscrowSchemaError);
    expect(() => parseResultSchema({ type: "object", properties: { rows: { type: "integer", minLenght: 1 } } })).toThrow(
      /unknown keyword/,
    );
  });
});

describe("escrow state machine", () => {
  const schema = parseResultSchema(deliverySchema);

  it("releases a valid delivery and refunds a failed one", () => {
    expect(decideSettlement("held", schema, { status: "ok", rows: 2 }).status).toBe("released");
    const failed = decideSettlement("held", schema, { status: "ok", rows: 0 });
    expect(failed.status).toBe("refunded");
    expect(failed.validationErrors).toEqual(["result.rows: expected >= 1."]);
  });

  it("treats a failing hook as a refund and refuses a second settlement", () => {
    const hooked = decideSettlement("held", schema, { status: "ok", rows: 2 }, () => ({
      ok: false,
      errors: ["manual rejection"],
    }));
    expect(hooked).toEqual({ status: "refunded", validationErrors: ["manual rejection"] });
    expect(() => decideSettlement("released", schema, { status: "ok", rows: 2 })).toThrow(/already released/);
    expect(() => decideSettlement("refunded", schema, {})).toThrow(/already refunded/);
  });

  it("refunds a held escrow when the SLA elapses and refuses a second settlement", () => {
    expect(decideSlaTimeout("held")).toEqual({
      status: "refunded",
      validationErrors: [SLA_TIMEOUT_REASON],
    });
    expect(() => decideSlaTimeout("released")).toThrow(/already released/);
    expect(() => decideSlaTimeout("refunded")).toThrow(/already refunded/);
  });
});

describe("resolveEscrowMode", () => {
  it("defaults to custodial-mock and rejects unknown values", async () => {
    const { resolveEscrowMode } = await import("./mode.js");
    expect(resolveEscrowMode({})).toBe("custodial-mock");
    expect(resolveEscrowMode({ ROSTER_ESCROW_MODE: "noncustodial-sim" })).toBe("noncustodial-sim");
    expect(resolveEscrowMode({ ROSTER_ESCROW_MODE: "noncustodial-devnet" })).toBe("noncustodial-devnet");
    expect(() => resolveEscrowMode({ ROSTER_ESCROW_MODE: "custodial-real" })).toThrow(/ROSTER_ESCROW_MODE/);
  });
});
