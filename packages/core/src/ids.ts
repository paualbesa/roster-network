import { createHash, randomBytes } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function createSandboxApiKey(): string {
  return `sk_sandbox_${randomBytes(16).toString("hex")}`;
}

/** SHA-256 hex digest. Sandbox keys are high-entropy, so the hash is stored without a salt. */
export function hashSandboxApiKey(apiKey: string): string {
  return createHash("sha256").update(apiKey, "utf8").digest("hex");
}
