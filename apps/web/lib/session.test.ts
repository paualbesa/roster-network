import { describe, expect, it } from "vitest";
import { parseSandboxSession, serializeSandboxSession } from "./session";

describe("sandbox session", () => {
  it("round-trips a sandbox API key and remembers whether it was shown", () => {
    const raw = serializeSandboxSession({
      apiKey: " sk_sandbox_test ",
      email: "ada@example.com",
      revealed: false,
    });
    expect(parseSandboxSession(raw)).toEqual({
      apiKey: "sk_sandbox_test",
      email: "ada@example.com",
      revealed: false,
    });
  });

  it("drops malformed storage", () => {
    expect(parseSandboxSession(null)).toBeNull();
    expect(parseSandboxSession("{")).toBeNull();
    expect(parseSandboxSession(JSON.stringify({ email: "ada@example.com" }))).toBeNull();
    expect(parseSandboxSession(JSON.stringify({ apiKey: "  ", email: "ada@example.com" }))).toBeNull();
  });

  it("keeps a GitHub or Google label and drops an unknown provider", () => {
    const raw = serializeSandboxSession({
      apiKey: "sk_sandbox_test",
      email: "ada@example.com",
      revealed: true,
      provider: "google",
    });
    expect(parseSandboxSession(raw)?.provider).toBe("google");
    expect(
      parseSandboxSession(
        JSON.stringify({ apiKey: "sk_sandbox_test", email: "ada@example.com", provider: "password" }),
      )?.provider,
    ).toBeUndefined();
  });
});
