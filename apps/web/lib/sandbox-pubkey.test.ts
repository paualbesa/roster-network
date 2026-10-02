import { describe, expect, it } from "vitest";
import { decodeBase58 } from "./base58";
import { SANDBOX_PUBKEY_LABEL_PREFIX, sandboxParticipantPubkey } from "./sandbox-pubkey";

describe("sandbox participant pubkey", () => {
  it("is a stable 32-byte key and changes with the label", async () => {
    expect(SANDBOX_PUBKEY_LABEL_PREFIX).toBe("roster-sandbox-v1:");
    const buyer = await sandboxParticipantPubkey("buyer:agt_1");
    expect(buyer).toBe(await sandboxParticipantPubkey("buyer:agt_1"));
    expect(buyer).not.toBe(await sandboxParticipantPubkey("provider:agt_2"));
    expect(decodeBase58(buyer)).toHaveLength(32);
    expect(buyer).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });
});
