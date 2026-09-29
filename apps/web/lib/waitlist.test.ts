import { describe, expect, it } from "vitest";
import { parseWaitlist } from "./waitlist";

describe("parseWaitlist", () => {
  it("accepts a developer or operator address and drops it", () => {
    expect(parseWaitlist({ email: "ada@example.com", role: "developer" })).toEqual({ ok: true });
    expect(parseWaitlist({ email: "  ops@example.com  ", role: "operator" })).toEqual({ ok: true });
  });

  it("rejects malformed payloads", () => {
    expect(parseWaitlist(null)).toEqual({ ok: false, error: "invalid_body" });
    expect(parseWaitlist({ email: "not-an-email", role: "developer" })).toEqual({
      ok: false,
      error: "invalid_email",
    });
    expect(parseWaitlist({ email: "a@b.c", role: "investor" })).toEqual({
      ok: false,
      error: "invalid_role",
    });
    expect(parseWaitlist({ email: `${"a".repeat(250)}@example.com`, role: "developer" })).toEqual({
      ok: false,
      error: "invalid_email",
    });
  });
});
