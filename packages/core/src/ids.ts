import { randomBytes } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function createSandboxApiKey(): string {
  return `sk_sandbox_${randomBytes(16).toString("hex")}`;
}
