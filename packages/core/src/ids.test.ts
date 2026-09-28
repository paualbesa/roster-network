import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSandboxApiKey, hashSandboxApiKey } from "./ids.js";

describe("sandbox API keys", () => {
  it("hashes the secret and does not echo it", () => {
    const apiKey = createSandboxApiKey();
    const hash = hashSandboxApiKey(apiKey);
    expect(hash).toBe(createHash("sha256").update(apiKey, "utf8").digest("hex"));
    expect(hash).not.toBe(apiKey);
    expect(apiKey.startsWith("sk_sandbox_")).toBe(true);
  });
});
