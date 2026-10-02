import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { encodeBase58 } from "./base58.js";

/** Same label prefix the console hashes in apps/web/lib/sandbox-pubkey.ts. */
const SANDBOX_PUBKEY_LABEL_PREFIX = "roster-sandbox-v1:";

describe("console sandbox pubkey", () => {
  it("hashes to a 32-byte Solana public key the mock cluster accepts", () => {
    const bytes = createHash("sha256").update(`${SANDBOX_PUBKEY_LABEL_PREFIX}buyer:agt_1`, "utf8").digest();
    const encoded = encodeBase58(bytes);
    const key = new PublicKey(encoded);
    expect(key.toBytes()).toHaveLength(32);
    expect(key.toBase58()).toBe(encoded);
  });
});
